import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { API_ERROR_CODES } from "../../../shared/api-errors";
import {
	addMonths,
	fridaysInMonth,
	isMonth,
	tokyoDate,
} from "../../../shared/date";
import { countCharacters } from "../../../shared/profile";
import { CLOSED_REASON_MAX_LENGTH } from "../../../shared/seminar-day";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ApiError, api, isClientError, readErrorCode } from "../../lib/api";
import { formatDate, formatMonth } from "../../lib/format-date";
import { monthDaysQueryOptions } from "../../lib/month-days-query";

// API に送る値（routes/admin.ts の PATCH /api/admin/days/:date）。再開では理由に null を送る（理由のキーは省けない。shared/schemas.ts の seminarDayStatusInputSchema）
type StatusInput =
	| { status: "closed"; closedReason: string | null }
	| { status: "open"; closedReason: null };

// 確認ダイアログで何をしようとしているか。isClosed は押したときの状態で、ダイアログの文言を決めるために持つ
// （ダイアログを開いている間に一覧が取り直されても、確かめた内容と違う文言にしないため）
type PendingChange = { date: string; isClosed: boolean; input: StatusInput };

function confirmMessage({ date, isClosed, input }: PendingChange) {
	if (input.status === "open") {
		return `${formatDate(date)} の休講を取り消し、開催日に戻しますか？`;
	}
	// 理由の変更も休止と同じ値を送るため、画面を開いている間にほかの管理者が開催日に戻していれば、予約が消える。
	// 画面の状態が古いことがあるため、理由の変更でも削除の注意を出す。
	// 開始時刻を過ぎた枠の予約は、発表済みのため消さない（services/seminar-day.ts の updateSeminarDayStatus）
	return isClosed
		? `${formatDate(date)} の休講の理由を変更しますか？（ほかの管理者が開催日に戻していた場合は、この日の予約が削除されます。開始時刻を過ぎた枠の予約は残ります）`
		: `${formatDate(date)} を休講にしますか？この日の予約は削除されます（開始時刻を過ぎた枠の予約は残ります）`;
}

// 送信の失敗の文言。4xx は送り直しても結果が変わらないため、ダイアログは「はい」を出さない（action-error.ts と同じ考え方）
function changeErrorMessage(error: unknown) {
	switch (error instanceof ApiError ? error.code : null) {
		case API_ERROR_CODES.UNAUTHORIZED:
			return "ログインの有効期限が切れました。ページを再読み込みして、ログインし直してください";
		case API_ERROR_CODES.FORBIDDEN:
			return "この操作を行う権限がありません";
		case API_ERROR_CODES.SEMINAR_DAY_PAST:
			return "今日より前の開催日は変更できません";
		case API_ERROR_CODES.VALIDATION_ERROR:
			return `休講の理由を確認してください（${CLOSED_REASON_MAX_LENGTH}文字まで。見えない文字は使えません）`;
	}
	return isClientError(error)
		? "送信できませんでした。ページを再読み込みしてください"
		: "送信できませんでした。時間をおいてもう一度お試しください";
}

export function AdminDaysPage() {
	// 表示中の月は URL に持つ（再読み込みしても同じ月を開くように）。無いときや形式が不正なときは、日本時間の今月（home.tsx と同じ）
	const [searchParams, setSearchParams] = useSearchParams();
	const monthParam = searchParams.get("month");
	const today = tokyoDate(new Date());
	const month = isMonth(monthParam) ? monthParam : today.slice(0, 7);
	const previousMonth = addMonths(month, -1);
	const nextMonth = addMonths(month, 1);

	// カレンダーと同じキャッシュを使う。休止・再開したあとに取り直すと、トップのカレンダーにもすぐ反映される
	const daysQuery = useQuery(monthDaysQueryOptions(month));
	const daysByDate = new Map(
		(daysQuery.data?.days ?? []).map((day) => [day.date, day]),
	);

	// 理由の入力欄を開いている日
	const [editingDate, setEditingDate] = useState<string | null>(null);
	const [reason, setReason] = useState("");
	const [pendingChange, setPendingChange] = useState<PendingChange | null>(
		null,
	);
	// 直前の操作の結果（消した予約の件数など）。次の操作を始めるか、月を移ったら消す
	const [resultMessage, setResultMessage] = useState<string | null>(null);

	const queryClient = useQueryClient();
	const changeMutation = useMutation({
		mutationFn: async ({ date, input }: PendingChange) => {
			const res = await api.api.admin.days[":date"].$patch({
				param: { date },
				json: input,
			});
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`送信できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return res.json();
		},
		// 一覧を取り直し終えてから閉じる（day.tsx と同じ理由。取り直すまでの間、古い状態のボタンを押せないように）
		onSuccess: async (result, change) => {
			await refetchDays(change.date);
			setResultMessage(
				result.day.status === "open"
					? `${formatDate(change.date)} を開催日に戻しました`
					: `${formatDate(change.date)} を休講にしました（削除した予約: ${result.deletedReservationCount}件）`,
			);
			setPendingChange(null);
			setEditingDate(null);
		},
		// 失敗したときも取り直す。ほかの管理者が先に変えていたときに、古い状態を見せ続けないため
		onError: (_, change) => refetchDays(change.date),
	});

	// 月の開催日（カレンダー・連絡の開催日の候補と共有）と、その日の枠の表（day.tsx）を取り直す。
	// 休止で予約が消えるため、マイページの予約一覧（me.tsx）も次に開いたときに取り直させる
	function refetchDays(date: string) {
		return Promise.all([
			queryClient.invalidateQueries({ queryKey: ["days"] }),
			queryClient.invalidateQueries({ queryKey: ["day", date] }),
			queryClient.invalidateQueries({ queryKey: ["me", "reservations"] }),
		]);
	}

	function moveMonth(target: string) {
		setEditingDate(null);
		setResultMessage(null);
		setSearchParams({ month: target });
	}

	function openReasonForm(date: string, currentReason: string | null) {
		setResultMessage(null);
		setEditingDate(date);
		setReason(currentReason ?? "");
	}

	function openDialog(change: PendingChange) {
		// 前のダイアログの失敗の文言を残さない
		changeMutation.reset();
		setResultMessage(null);
		setPendingChange(change);
	}

	const trimmedReason = reason.trim();
	const isReasonTooLong =
		countCharacters(trimmedReason) > CLOSED_REASON_MAX_LENGTH;

	return (
		<section className="mt-4">
			<div className="flex items-center justify-between">
				{/* 2000〜2099 年の外は API が受け付けないため、端の月ではボタンを押せなくする（home.tsx と同じ） */}
				<button
					type="button"
					onClick={() => moveMonth(previousMonth)}
					disabled={!isMonth(previousMonth)}
					aria-label="前の月"
					className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-40"
				>
					‹
				</button>
				<h2 className="font-bold">{formatMonth(month)}</h2>
				<button
					type="button"
					onClick={() => moveMonth(nextMonth)}
					disabled={!isMonth(nextMonth)}
					aria-label="次の月"
					className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-40"
				>
					›
				</button>
			</div>
			<p className="mt-2 text-xs text-gray-600">
				「未作成」は、まだ枠を作っていない日です（4週間先までは自動で作ります）。休講にすると、枠を作らずに休講日にします。今日より前の日は変更できません
			</p>

			{resultMessage && (
				<p role="status" className="mt-2 text-sm text-green-700">
					{resultMessage}
				</p>
			)}
			{daysQuery.isPending && (
				<p className="mt-2 text-sm text-gray-600">読み込み中…</p>
			)}
			{daysQuery.isError && (
				<div role="alert" className="mt-2 text-sm text-red-700">
					開催日を読み込めませんでした
					<button
						type="button"
						onClick={() => daysQuery.refetch()}
						className="ml-2 underline"
					>
						再読み込み
					</button>
				</div>
			)}

			{/* 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中は一覧を出さない（古い状態のまま操作させないため） */}
			{daysQuery.data && !daysQuery.isError && (
				<ul className="mt-2 divide-y divide-gray-200 border-y border-gray-200">
					{/* 開催日は金曜だけのため、金曜を並べる（API も金曜以外は受け付けない） */}
					{fridaysInMonth(month).map((date) => {
						const day = daysByDate.get(date);
						const isClosed = day?.status === "closed";
						const isPast = date < today;
						const isEditing = editingDate === date;

						return (
							<li key={date} className="py-2 text-sm">
								<div className="flex items-start justify-between gap-2">
									<div className="min-w-0">
										<p className="font-bold">{formatDate(date)}</p>
										<p className="break-all text-gray-600">
											{!day
												? "未作成"
												: isClosed
													? `休講${day.closedReason ? `：${day.closedReason}` : ""}`
													: "開催"}
										</p>
									</div>
									{!isPast && !isEditing && (
										<div className="flex shrink-0 gap-1">
											<button
												type="button"
												onClick={() =>
													openReasonForm(date, day?.closedReason ?? null)
												}
												className="rounded border border-gray-300 px-2 py-1"
											>
												{isClosed ? "理由を変更" : "休講にする"}
											</button>
											{isClosed && (
												<button
													type="button"
													onClick={() =>
														openDialog({
															date,
															isClosed,
															input: { status: "open", closedReason: null },
														})
													}
													className="rounded border border-gray-300 px-2 py-1"
												>
													再開する
												</button>
											)}
										</div>
									)}
								</div>

								{isEditing && (
									<form
										className="mt-2"
										onSubmit={(event) => {
											event.preventDefault();
											openDialog({
												date,
												isClosed,
												// 空欄は「理由なし」として null で送る（API は空文字を受け付けない）
												input: {
													status: "closed",
													closedReason:
														trimmedReason === "" ? null : trimmedReason,
												},
											});
										}}
									>
										<label className="block text-xs text-gray-600">
											休講の理由（任意・{CLOSED_REASON_MAX_LENGTH}文字まで）
											<input
												type="text"
												value={reason}
												onChange={(event) => setReason(event.target.value)}
												placeholder="例：大学祭"
												className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-sm"
											/>
										</label>
										<p
											className={`mt-1 text-right text-xs ${isReasonTooLong ? "text-red-700" : "text-gray-600"}`}
										>
											{countCharacters(trimmedReason)}/
											{CLOSED_REASON_MAX_LENGTH}
										</p>
										<div className="mt-1 flex justify-end gap-2">
											<button
												type="button"
												onClick={() => setEditingDate(null)}
												className="rounded border border-gray-300 px-3 py-1"
											>
												やめる
											</button>
											<button
												type="submit"
												disabled={isReasonTooLong}
												className="rounded bg-blue-700 px-3 py-1 text-white disabled:opacity-50"
											>
												{isClosed ? "理由を変更する" : "休講にする"}
											</button>
										</div>
									</form>
								)}
							</li>
						);
					})}
				</ul>
			)}

			<ConfirmDialog
				isOpen={pendingChange !== null}
				message={pendingChange ? confirmMessage(pendingChange) : ""}
				isPending={changeMutation.isPending}
				errorMessage={
					changeMutation.isError
						? changeErrorMessage(changeMutation.error)
						: null
				}
				isResendable={!isClientError(changeMutation.error)}
				onConfirm={() => {
					if (pendingChange) {
						changeMutation.mutate(pendingChange);
					}
				}}
				onClose={() => setPendingChange(null)}
			/>
		</section>
	);
}
