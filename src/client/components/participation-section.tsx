import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	PARTICIPATION_STATUS_LABELS,
	PARTICIPATION_STATUSES,
	type ParticipationStatus,
} from "../../shared/participation-status";
import { ApiError, api, isClientError, readErrorCode } from "../lib/api";
import { isConferenceGone } from "../lib/conference-error";
import {
	conferenceQueryOptions,
	markConferenceGone,
} from "../lib/conference-query";
import { participationErrorMessage } from "../lib/participation-error";
import { ConfirmDialog } from "./confirm-dialog";

type MyParticipation = { id: string; status: ParticipationStatus };

// 学会の詳細の「自分の状態」。参加するのは常にログイン中の本人で、他人の参加は操作できない（設計メモ「ユーザー」）。
// 未参加なら状態のボタンで参加し（POST）、参加中なら別の状態のボタンで変え（PATCH）、取消は確認してから消す（DELETE）
export function ParticipationSection({
	conferenceId,
	conferenceTitle,
	myParticipation,
	isStale,
}: {
	conferenceId: string;
	conferenceTitle: string;
	// 詳細の参加者のうち isMine の行。参加していなければ null
	myParticipation: MyParticipation | null;
	// 詳細の取り直しに失敗し、手元の参加者が今の状態か分からないか。
	// その間は見出し・今の状態・状態のボタンを隠し、失敗の文言と取消の確認ダイアログだけを残す（古い状態のボタンを押させないため）
	isStale: boolean;
}) {
	const queryClient = useQueryClient();

	// 詳細（参加者一覧と自分の状態）を取り直す。一覧の参加者も変わるため、学会の一覧にも古い印を付ける。
	// 取り直しに失敗しても invalidateQueries は失敗を投げない（詳細のほうにエラーが出る）
	function refetchConference() {
		return Promise.all([
			queryClient.invalidateQueries({
				queryKey: conferenceQueryOptions(conferenceId).queryKey,
			}),
			queryClient.invalidateQueries({ queryKey: ["conferences"] }),
		]);
	}

	// 失敗したときの取り直し。別のタブで参加・取消していたときに、古い状態のボタンを見せ続けないため取り直す。
	// ただし学会がすでに削除されていたときは取り直さず、一覧と詳細に古い印だけを付ける（detail.tsx の削除と同じ扱い）。
	// 取り直すと、上の学会の情報が「学会が見つかりません」に置き換わり、何が消えたのか分からなくなるため
	function handleError(error: unknown) {
		if (isConferenceGone(error)) {
			markConferenceGone(queryClient, conferenceId);
			return;
		}
		return refetchConference();
	}

	const statusMutation = useMutation({
		// どの行を変えるかは、押した時点の値を引数で受け取る（取り直しで変わる myParticipation を mutationFn の中で読まないため）。
		// conferenceId はこの画面を開いている間は変わらないため、props から読む
		mutationFn: async ({
			status,
			participantId,
		}: {
			status: ParticipationStatus;
			participantId: string | null;
		}) => {
			const res =
				participantId === null
					? await api.api.conferences[":id"].participants.$post({
							param: { id: conferenceId },
							json: { status },
						})
					: await api.api.conferences[":id"].participants[
							":participantId"
						].$patch({
							param: { id: conferenceId, participantId },
							json: { status },
						});
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`送信できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
		},
		// 取り直し終えるまで「送信中」のままにする。先に終えると、取り直すまでの間、古い状態のボタンが押せてしまうため（day.tsx と同じ理由）
		onSuccess: () => refetchConference(),
		onError: handleError,
	});

	// 取消の確認ダイアログで取り消す行。開いた時点の行を持ち、取り直しで自分の行が消えても、ダイアログの文言が変わらないようにする
	const [cancelTarget, setCancelTarget] = useState<MyParticipation | null>(
		null,
	);
	const cancelMutation = useMutation({
		mutationFn: async (participantId: string) => {
			const res = await api.api.conferences[":id"].participants[
				":participantId"
			].$delete({ param: { id: conferenceId, participantId } });
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`取り消せませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
		},
		// 成功したら、取り直し終えてからダイアログを閉じる（状態のボタンと同じ理由）
		onSuccess: async () => {
			await refetchConference();
			setCancelTarget(null);
		},
		onError: handleError,
	});

	const isBusy = statusMutation.isPending || cancelMutation.isPending;
	// 学会が消えたあとは、どのボタンを押しても同じ失敗になるため出さない
	const isButtonsHidden = isStale || isConferenceGone(statusMutation.error);

	function changeStatus(status: ParticipationStatus) {
		// 状態のボタンの失敗の文言と、取消の失敗の文言を同時に残さない
		cancelMutation.reset();
		statusMutation.mutate({
			status,
			participantId: myParticipation?.id ?? null,
		});
	}

	function openCancelDialog(target: MyParticipation) {
		// 前に開いたときの失敗の文言と、状態のボタンの失敗の文言を残さない
		statusMutation.reset();
		cancelMutation.reset();
		setCancelTarget(target);
	}

	return (
		<section className="mt-6">
			{!isButtonsHidden && (
				<>
					<h2 className="font-bold">自分の状態</h2>
					<p className="mt-1 text-sm text-gray-700">
						{myParticipation
							? `今の状態：${PARTICIPATION_STATUS_LABELS[myParticipation.status]}`
							: "まだ参加していません"}
					</p>
					<div className="mt-2 flex flex-wrap gap-2">
						{PARTICIPATION_STATUSES.map((status) => {
							const isCurrent = myParticipation?.status === status;
							return (
								<button
									key={status}
									type="button"
									// 今の状態のボタンは、選ばれていることを見た目と読み上げの両方で伝え、押しても何も変わらないため押せなくする
									aria-pressed={isCurrent}
									disabled={isBusy || isCurrent}
									onClick={() => changeStatus(status)}
									className={`rounded border px-3 py-1 text-sm ${
										isCurrent
											? "border-blue-700 bg-blue-700 text-white"
											: "border-gray-300 disabled:opacity-50"
									}`}
								>
									{PARTICIPATION_STATUS_LABELS[status]}
								</button>
							);
						})}
						{myParticipation && (
							<button
								type="button"
								disabled={isBusy}
								onClick={() => openCancelDialog(myParticipation)}
								className="rounded border border-red-300 px-3 py-1 text-sm text-red-700 disabled:opacity-50"
							>
								取消
							</button>
						)}
					</div>
				</>
			)}
			{statusMutation.isPending && (
				<p role="status" className="mt-2 text-sm text-gray-600">
					送信中…
				</p>
			)}
			{statusMutation.isError && (
				<p role="alert" className="mt-2 text-sm text-red-700">
					{participationErrorMessage(statusMutation.error)}
				</p>
			)}

			<ConfirmDialog
				isOpen={cancelTarget !== null}
				message={
					cancelTarget
						? `「${conferenceTitle}」への参加（${PARTICIPATION_STATUS_LABELS[cancelTarget.status]}）を取り消しますか？`
						: ""
				}
				isPending={cancelMutation.isPending}
				errorMessage={
					cancelMutation.isError
						? participationErrorMessage(cancelMutation.error)
						: null
				}
				isResendable={!isClientError(cancelMutation.error)}
				onConfirm={() => {
					if (cancelTarget) {
						cancelMutation.mutate(cancelTarget.id);
					}
				}}
				onClose={() => setCancelTarget(null)}
			/>
		</section>
	);
}
