import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { API_ERROR_CODES } from "../../../shared/api-errors";
import { formatDisplayName } from "../../../shared/grade";
import { PARTICIPATION_STATUS_LABELS } from "../../../shared/participation-status";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ApiError, api, isClientError, readErrorCode } from "../../lib/api";
import { conferenceErrorMessage } from "../../lib/conference-error";
import { conferenceQueryOptions } from "../../lib/conference-query";
import {
	formatDateRange,
	formatDateTime,
	formatDateWithYear,
} from "../../lib/format-date";

// 理由が分かるエラーだけ文言を返す。それ以外（ログイン切れの 401・5xx・通信の失敗など）は null を返し、
// 共通の「読み込めませんでした＋再読み込み」を出す（day.tsx と同じ）。
// id の形が違う URL（400）も、利用者から見れば無い学会と同じため、同じ文言にする
function errorMessage(error: unknown) {
	switch (error instanceof ApiError ? error.code : null) {
		case API_ERROR_CODES.CONFERENCE_NOT_FOUND:
		case API_ERROR_CODES.VALIDATION_ERROR:
			return "学会が見つかりません";
		default:
			return null;
	}
}

// http:// か https:// で始まる URL だけリンクにする。この Issue では学会を手で insert するため API の検証を通らず、
// javascript: などの URL が入っていても、押した人のブラウザでスクリプトが動かないようにする（設計メモ リスク2）
function isHttpUrl(value: string) {
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

export function ConferenceDetailPage() {
	// ルートの定義（/conferences/:id）で必ず入るが、型の上では undefined がありうるため空文字にする（API が 400 を返す）
	const { id = "" } = useParams();

	const conferenceQuery = useQuery(conferenceQueryOptions(id));
	const conference = conferenceQuery.data?.conference;

	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
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
			// 一覧は今は画面に無いため、古い印を付けるだけにし、開いたときに取り直させる
			queryClient.invalidateQueries({ queryKey: ["conferences"] });
			// 「戻る」で削除した学会の詳細に戻らないよう、履歴を置き換える
			navigate("/conferences", { replace: true });
		},
	});

	function openDeleteDialog() {
		// 前に開いたときの失敗の文言を残さない
		deleteMutation.reset();
		setIsDeleteDialogOpen(true);
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
					{errorMessage(conferenceQuery.error) ?? (
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

					{/* 文章の項目は React の通常の表示に任せ、HTML として埋め込まない（設計メモ リスク2） */}
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
						onClose={() => setIsDeleteDialogOpen(false)}
					/>

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
				</>
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
