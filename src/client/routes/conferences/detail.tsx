import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { isHttpUrl } from "../../../shared/conference";
import { formatDisplayName } from "../../../shared/grade";
import { PARTICIPATION_STATUS_LABELS } from "../../../shared/participation-status";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ParticipationSection } from "../../components/participation-section";
import { ApiError, api, isClientError, readErrorCode } from "../../lib/api";
import {
	conferenceErrorMessage,
	isConferenceGone,
} from "../../lib/conference-error";
import {
	conferenceQueryErrorMessage,
	conferenceQueryOptions,
	markConferenceGone,
} from "../../lib/conference-query";
import {
	formatDateRange,
	formatDateTime,
	formatDateWithYear,
} from "../../lib/format-date";

export function ConferenceDetailPage() {
	// ルートの定義（/conferences/:id）で必ず入るが、型の上では undefined がありうるため空文字にする（API が 400 を返す）
	const { id = "" } = useParams();

	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

	const conferenceQuery = useQuery({
		...conferenceQueryOptions(id),
		// 編集の保存のあとは、詳細を取り直し終えてからこの画面へ移る（conference-form.tsx）。
		// 取ったばかりの値を、開いた直後にもう一度取り直さないよう、少しの間は新しいものとして扱う。
		// 学会が消えて古い印が付いたとき（markConferenceGone）は、この時間に関係なく取り直す
		staleTime: 5_000,
		// 削除のダイアログを開いている間は、画面に戻ったときと通信が戻ったときに取り直さない。
		// 取り直しが 404 や通信の失敗になると、中身ごとダイアログが消え、「すでに削除されています」などの文言が読めなくなるため
		refetchOnWindowFocus: !isDeleteDialogOpen,
		refetchOnReconnect: !isDeleteDialogOpen,
	});
	const conference = conferenceQuery.data?.conference;

	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const deleteMutation = useMutation({
		mutationFn: async () => {
			const res = await api.api.conferences[":id"].$delete({ param: { id } });
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`削除できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
		},
		onSuccess: () => {
			markConferenceGone(queryClient, id);
			// 「戻る」で削除した学会の詳細に戻らないよう、履歴を置き換える
			navigate("/conferences", { replace: true });
		},
		onError: (error) => {
			// ほかの人が先に削除していたときも、消えた学会として古い印を付ける（ダイアログを閉じると一覧へ移る）
			if (isConferenceGone(error)) {
				markConferenceGone(queryClient, id);
			}
		},
	});

	function openDeleteDialog() {
		// 前に開いたときの失敗の文言を残さない
		deleteMutation.reset();
		setIsDeleteDialogOpen(true);
	}

	function closeDeleteDialog() {
		setIsDeleteDialogOpen(false);
		// すでに削除されていた学会の詳細に残っても何もできないため、一覧へ移る。
		// すぐに移ると「すでに削除されています」の文言が読めないため、ダイアログを閉じたときに移る
		if (isConferenceGone(deleteMutation.error)) {
			navigate("/conferences", { replace: true });
		}
	}

	return (
		<main className="mx-auto max-w-md p-4">
			<Link to="/conferences" className="text-sm text-blue-700 underline">
				← 学会の一覧
			</Link>

			{conferenceQuery.isPending && (
				<p className="mt-4 text-sm text-gray-600">読み込み中…</p>
			)}
			{conferenceQuery.isError && (
				<div role="alert" className="mt-4 text-sm text-red-700">
					{conferenceQueryErrorMessage(conferenceQuery.error) ?? (
						<>
							学会を読み込めませんでした
							<button
								type="button"
								onClick={() => conferenceQuery.refetch()}
								className="ml-2 underline"
							>
								再読み込み
							</button>
						</>
					)}
				</div>
			)}

			{/* 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中は中身を出さない（day.tsx と同じ理由） */}
			{conference && !conferenceQuery.isError && (
				<>
					<p className="mt-4 text-xs text-gray-600">{conference.seriesName}</p>
					<h1 className="break-all text-xl font-bold">{conference.title}</h1>

					{/* 文章の項目は React の通常の表示に任せ、HTML として埋め込まない（設計メモ リスク2）。
					    URL は API でも検証しているが、手で insert した行は検証を通らないため、リンクにする前にも確かめる。
					    javascript: などの URL をリンクにすると、押した人のブラウザでスクリプトが動くため */}
					<dl className="mt-4 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2 text-sm">
						<Field label="開催地">{conference.venue ?? "未定"}</Field>
						<Field label="URL">
							{conference.url === null ? (
								"なし"
							) : isHttpUrl(conference.url) ? (
								<a
									href={conference.url}
									target="_blank"
									rel="noopener noreferrer"
									className="text-blue-700 underline"
								>
									{conference.url}
								</a>
							) : (
								conference.url
							)}
						</Field>
						<Field label="締切">
							{conference.submissionDeadline === null
								? "未定"
								: formatDateWithYear(conference.submissionDeadline)}
							{conference.submissionNote !== null && (
								<p className="mt-1 whitespace-pre-wrap text-gray-700">
									{conference.submissionNote}
								</p>
							)}
						</Field>
						<Field label="開催日">
							{formatDateRange(conference.startDate, conference.endDate) ??
								"未定"}
							{conference.scheduleNote !== null && (
								<p className="mt-1 whitespace-pre-wrap text-gray-700">
									{conference.scheduleNote}
								</p>
							)}
						</Field>
						<Field label="説明">
							<span className="whitespace-pre-wrap">
								{conference.description ?? "なし"}
							</span>
						</Field>
						<Field label="メモ">
							<span className="whitespace-pre-wrap">
								{conference.note ?? "なし"}
							</span>
						</Field>
						<Field label="最終更新">
							{formatDateTime(conference.updatedAt)}
						</Field>
					</dl>

					<div className="mt-4 flex gap-2">
						<Link
							to={`/conferences/${conference.id}/edit`}
							className="rounded border border-gray-300 px-3 py-1 text-sm"
						>
							編集
						</Link>
						<button
							type="button"
							onClick={openDeleteDialog}
							className="rounded border border-red-300 px-3 py-1 text-sm text-red-700"
						>
							削除
						</button>
					</div>

					{/* 誰でも削除でき、元に戻せないため、学会名を出して確かめる（設計メモ リスク3） */}
					<ConfirmDialog
						isOpen={isDeleteDialogOpen}
						message={`「${conference.title}」を削除しますか？参加者の情報も一緒に消え、元に戻せません`}
						isPending={deleteMutation.isPending}
						errorMessage={
							deleteMutation.isError
								? conferenceErrorMessage(deleteMutation.error)
								: null
						}
						isResendable={!isClientError(deleteMutation.error)}
						onConfirm={() => deleteMutation.mutate()}
						onClose={closeDeleteDialog}
					/>
				</>
			)}

			{/* 自分の状態は、取得がエラーの間も描く（中で状態のボタンだけを隠す）。
			    参加の操作の失敗のあとに取り直しも失敗したとき、失敗の文言と取消の確認ダイアログまで消えないようにするため
			    （day.tsx の確認ダイアログを表の外に置いているのと同じ理由） */}
			{conference && (
				<ParticipationSection
					conferenceId={conference.id}
					conferenceTitle={conference.title}
					myParticipation={
						conference.participants.find(({ isMine }) => isMine) ?? null
					}
					isStale={conferenceQuery.isError}
				/>
			)}

			{conference && !conferenceQuery.isError && (
				<section className="mt-6">
					<h2 className="font-bold">参加者</h2>
					{conference.participants.length === 0 ? (
						<p className="mt-2 text-sm text-gray-600">まだ参加者はいません</p>
					) : (
						<ul className="mt-2 flex flex-col gap-1 text-sm">
							{conference.participants.map((participant) => (
								<li
									key={participant.id}
									className="flex justify-between gap-2 border-b border-gray-200 py-1"
								>
									<span className="break-all">
										{/* 表示名が無い人（手で insert した行など）は、日別の表（day-slot-table.tsx）と同じ文言にする */}
										{formatDisplayName(
											participant.displayName ?? "名前未登録",
											participant.grade,
										)}
									</span>
									<span className="shrink-0 text-gray-700">
										{PARTICIPATION_STATUS_LABELS[participant.status]}
									</span>
								</li>
							))}
						</ul>
					)}
				</section>
			)}
		</main>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-gray-600">{label}</dt>
			<dd className="break-all">{children}</dd>
		</>
	);
}
