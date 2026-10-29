import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { API_ERROR_CODES } from "../../shared/api-errors";
import { isDate, isMonth } from "../../shared/date";
import { ConfirmDialog } from "../components/confirm-dialog";
import {
	type DaySlot,
	DaySlotTable,
	type Reservation,
	reserverName,
} from "../components/day-slot-table";
import { actionErrorMessage } from "../lib/action-error";
import {
	ApiError,
	api,
	isClientError,
	isRetryable,
	readErrorCode,
} from "../lib/api";
import { formatDate } from "../lib/format-date";

// 確認ダイアログで何をしようとしているか。取消は、押したときの予約の id を持つ
// （ダイアログを開いている間に表が取り直されても、確かめた予約とは別の予約を消さないため）
type PendingAction =
	| { kind: "reserve"; slot: DaySlot }
	| { kind: "cancel"; slot: DaySlot; reservation: Reservation };

function confirmMessage(action: PendingAction) {
	const time = `${action.slot.startTime}〜${action.slot.endTime}`;
	// 取消は、admin が他人の予約を消すこともあるため、誰の予約かを出す（間違えて消さないように）
	return action.kind === "reserve"
		? `${time} を予約しますか？`
		: `${reserverName(action.reservation)} の ${time} の予約を取り消しますか？`;
}

// 理由が分かるエラーだけ文言を返す。それ以外（ログイン切れの 401・5xx・通信の失敗など）は null を返し、
// 共通の「読み込めませんでした＋再読み込み」を出す
function errorMessage(error: unknown) {
	switch (error instanceof ApiError ? error.code : null) {
		case API_ERROR_CODES.SEMINAR_DAY_NOT_FOUND:
			return "この日は開催日ではありません";
		case API_ERROR_CODES.VALIDATION_ERROR:
			return "日付が正しくありません";
		default:
			return null;
	}
}

export function DayPage() {
	// ルートの定義（/days/:date）で必ず入るが、型の上では undefined がありうるため空文字にする（API が 400 を返す）
	const { date = "" } = useParams();
	// 見ていた月のカレンダーに戻す。URL の先頭（年月）が月の形でなければ、今月（トップの既定）に戻す
	const month = date.slice(0, 7);

	// 日付ごとに別のキーで取る。前の日の結果を表示し続ける設定（placeholderData）は使わない（home.tsx と同じ理由）
	const dayQuery = useQuery({
		queryKey: ["day", date],
		queryFn: async () => {
			const res = await api.api.days[":date"].$get({ param: { date } });
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`枠を取得できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return res.json();
		},
		retry: isRetryable,
	});
	const data = dayQuery.data;

	const queryClient = useQueryClient();
	const [pendingAction, setPendingAction] = useState<PendingAction | null>(
		null,
	);
	const actionMutation = useMutation({
		mutationFn: async (action: PendingAction) => {
			const res =
				action.kind === "reserve"
					? await api.api.slots[":slotId"].reservations.$post({
							param: { slotId: action.slot.id },
						})
					: await api.api.reservations[":id"].$delete({
							param: { id: action.reservation.id },
						});
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`送信できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
		},
		// 成功したら、表を取り直し終えてからダイアログを閉じる。先に閉じると、取り直すまでの間、
		// 古い表の「空き」が押せてしまうため（取り直している間は「送信中…」のまま）
		onSuccess: async () => {
			await refetchSlots();
			setPendingAction(null);
		},
		// 失敗したときも取り直す。枠が埋まっていたときに、空きのままの表を見せ続けないため。
		// 取り直し終えてから失敗の文言を出す（文言が出たときには、後ろの表が新しくなっている）
		onError: () => refetchSlots(),
	});

	// カレンダーの空き枠の数も変わるため、月の開催日（home.tsx の ["days", month]）も取り直す。
	// マイページの予約一覧（me.tsx の ["me", "reservations"]）も、次に開いたときに古い一覧を出さないよう取り直させる。
	// 取り直しに失敗しても invalidateQueries は失敗を投げない（表のほうにエラーが出る）
	function refetchSlots() {
		return Promise.all([
			queryClient.invalidateQueries({ queryKey: ["day", date] }),
			queryClient.invalidateQueries({ queryKey: ["days"] }),
			queryClient.invalidateQueries({ queryKey: ["me", "reservations"] }),
		]);
	}

	function openDialog(action: PendingAction) {
		// 前のダイアログの失敗の文言を残さない
		actionMutation.reset();
		setPendingAction(action);
	}

	function closeDialog() {
		setPendingAction(null);
	}

	return (
		<main className="mx-auto max-w-md p-4">
			<Link
				to={isMonth(month) ? `/?month=${month}` : "/"}
				className="text-sm text-blue-700 underline"
			>
				カレンダーに戻る
			</Link>
			{/* 実在しない日付を formatDate に渡すと NaN月 になるため、そのまま出す */}
			<h1 className="mt-2 text-xl font-bold">
				{isDate(date) ? formatDate(date) : date}
			</h1>

			{dayQuery.isPending && (
				<p className="mt-4 text-sm text-gray-600">読み込み中…</p>
			)}
			{dayQuery.isError && (
				<div role="alert" className="mt-4 text-sm text-red-700">
					{errorMessage(dayQuery.error) ?? (
						<>
							枠を読み込めませんでした
							<button
								type="button"
								onClick={() => dayQuery.refetch()}
								className="ml-2 underline"
							>
								再読み込み
							</button>
						</>
					)}
				</div>
			)}

			{/* 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中は表を出さない。
			    開催日が消えて 404 になったときに、古い表（予約者名つき）を今の状態として見せないため */}
			{data && !dayQuery.isError && (
				<>
					{data.day.status === "closed" && (
						<p role="status" className="mt-4 rounded bg-gray-100 p-3 text-sm">
							休講日
							{data.day.closedReason
								? `：${data.day.closedReason}`
								: "（理由は登録されていません）"}
						</p>
					)}
					<div className="mt-4">
						{data.slots.length > 0 ? (
							<DaySlotTable
								slots={data.slots}
								isClosed={data.day.status === "closed"}
								onReserve={(slot) => openDialog({ kind: "reserve", slot })}
								onCancel={(slot, reservation) =>
									openDialog({ kind: "cancel", slot, reservation })
								}
							/>
						) : (
							<p className="text-sm text-gray-600">この日の枠はありません</p>
						)}
					</div>
				</>
			)}

			<ConfirmDialog
				isOpen={pendingAction !== null}
				message={pendingAction ? confirmMessage(pendingAction) : ""}
				isPending={actionMutation.isPending}
				errorMessage={
					actionMutation.isError
						? actionErrorMessage(actionMutation.error)
						: null
				}
				isResendable={!isClientError(actionMutation.error)}
				onConfirm={() => {
					if (pendingAction) {
						actionMutation.mutate(pendingAction);
					}
				}}
				onClose={closeDialog}
			/>
		</main>
	);
}
