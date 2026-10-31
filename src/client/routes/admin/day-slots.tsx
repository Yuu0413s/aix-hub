import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { API_ERROR_CODES } from "../../../shared/api-errors";
import { isDate } from "../../../shared/date";
import {
	formatPeriod,
	SLOT_KIND_LABELS,
	SLOT_KINDS,
	type SlotKind,
} from "../../../shared/schedule-template";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { type DaySlot, reserverName } from "../../components/day-slot-table";
import { ApiError, api, isClientError, readErrorCode } from "../../lib/api";
import { dayQueryOptions } from "../../lib/day-query";
import { formatDate } from "../../lib/format-date";

// 種類の選択肢の名前。日別の表の名前（SLOT_KIND_LABELS）は presentation を持たないため、ここで足す
const KIND_OPTION_LABELS: Record<SlotKind, string> = {
	presentation: "発表",
	...SLOT_KIND_LABELS,
};

// API に送る値（routes/admin.ts の PATCH /api/admin/slots/:id）。変えない項目も含めて3項目すべてを送る
type SlotInput = { kind: SlotKind; startTime: string; endTime: string };

// 何を送ろうとしているか。slot は押したときの枠で、ダイアログと結果の文言に使う
// （送っている間に表が取り直されても、確かめた枠と違う時刻を出さないため）
type PendingEdit = { slot: DaySlot; input: SlotInput };

function slotTime(slot: { startTime: string; endTime: string }) {
	return `${slot.startTime}〜${slot.endTime}`;
}

// 種類を presentation 以外にすると、API はその枠の予約を消す。表の予約の有無に関わらず注意を出す
// （画面を開いている間に予約が入っていても、注意を見ずに消さないため。admin/days.tsx の理由の変更と同じ考え方）
function confirmMessage({ slot, input }: PendingEdit) {
	return `${slotTime(slot)} の枠を「${KIND_OPTION_LABELS[input.kind]}」${slotTime(input)} に変更しますか？この枠に予約があれば削除されます`;
}

// 送信の失敗の文言。4xx は送り直しても結果が変わらないため、ダイアログは「はい」を出さない（admin/days.tsx と同じ考え方）
function editErrorMessage(error: unknown) {
	switch (error instanceof ApiError ? error.code : null) {
		case API_ERROR_CODES.UNAUTHORIZED:
			return "ログインの有効期限が切れました。ページを再読み込みして、ログインし直してください";
		case API_ERROR_CODES.FORBIDDEN:
			return "この操作を行う権限がありません";
		case API_ERROR_CODES.SLOT_NOT_FOUND:
			return "この枠は見つかりませんでした";
		case API_ERROR_CODES.SLOT_STARTED:
			return "開始時刻を過ぎた枠は変更できません";
		case API_ERROR_CODES.SLOT_START_TIME_TAKEN:
			return "同じ日に同じ開始時刻の枠があります";
		case API_ERROR_CODES.VALIDATION_ERROR:
			return "時刻を確認してください（開始時刻は終了時刻より前にしてください）";
	}
	return isClientError(error)
		? "送信できませんでした。ページを再読み込みしてください"
		: "送信できませんでした。時間をおいてもう一度お試しください";
}

// 枠の表の読み込みの失敗で、理由が分かるものだけ文言を返す（day.tsx と同じ）
function loadErrorMessage(error: unknown) {
	switch (error instanceof ApiError ? error.code : null) {
		case API_ERROR_CODES.SEMINAR_DAY_NOT_FOUND:
			return "この日は開催日ではありません";
		case API_ERROR_CODES.VALIDATION_ERROR:
			return "日付が正しくありません";
		default:
			return null;
	}
}

// 枠の開始時刻を過ぎたか。開催日と開始時刻は日本時間として読む（API の isNotStarted と同じ）。
// 入力欄を出すかを決めるためだけに使い、変えられるかの最終的な判定は API が行う
function isSlotStarted(date: string, slot: DaySlot, now: Date) {
	return new Date(`${date}T${slot.startTime}:00+09:00`) <= now;
}

export function AdminDaySlotsPage() {
	// ルートの定義（/admin/days/:date）で必ず入るが、型の上では undefined がありうるため空文字にする（API が 400 を返す）
	const { date = "" } = useParams();
	const month = date.slice(0, 7);

	const dayQuery = useQuery(dayQueryOptions(date));
	const data = dayQuery.data;
	const now = new Date();

	const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
	// 直前の変更の結果（消した予約の件数など）。次の変更を始めたら消す
	const [resultMessage, setResultMessage] = useState<string | null>(null);

	const queryClient = useQueryClient();
	const editMutation = useMutation({
		mutationFn: async ({ slot, input }: PendingEdit) => {
			const res = await api.api.admin.slots[":id"].$patch({
				param: { id: slot.id },
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
		// 表を取り直し終えてからダイアログを閉じる（day.tsx と同じ理由。取り直すまでの間、古い枠を編集させないように）
		onSuccess: async (result, { slot }) => {
			await refetchSlots();
			setResultMessage(
				`${slotTime(slot)} の枠を「${KIND_OPTION_LABELS[result.slot.kind]}」${slotTime(result.slot)} に変更しました${
					result.deletedReservationCount > 0
						? `（削除した予約: ${result.deletedReservationCount}件）`
						: ""
				}`,
			);
			setPendingEdit(null);
		},
		// 失敗したときも取り直す。ほかの管理者が先に変えていたときに、古い枠を見せ続けないため
		onError: () => refetchSlots(),
	});

	// その日の枠の表（日別の表と共有）と、空き枠の数が変わる月の開催日を取り直す。
	// 種類の変更で予約が消えるため、マイページの予約一覧（me.tsx）も次に開いたときに取り直させる
	function refetchSlots() {
		return Promise.all([
			queryClient.invalidateQueries({ queryKey: ["day", date] }),
			queryClient.invalidateQueries({ queryKey: ["days"] }),
			queryClient.invalidateQueries({ queryKey: ["me", "reservations"] }),
		]);
	}

	function save(edit: PendingEdit) {
		// 前の変更の失敗の文言・結果を残さない
		editMutation.reset();
		setResultMessage(null);
		if (edit.input.kind === "presentation") {
			// 発表の枠のままなら予約は消えないため、確かめずに送る
			editMutation.mutate(edit);
		} else {
			setPendingEdit(edit);
		}
	}

	// ダイアログを使わずに送った変更の失敗は、その枠の行に出す
	const rowErrorSlotId =
		pendingEdit === null && editMutation.isError
			? editMutation.variables?.slot.id
			: undefined;

	return (
		<section className="mt-4">
			<Link
				to={`/admin/days?month=${month}`}
				className="text-sm text-blue-700 underline"
			>
				開催日の一覧に戻る
			</Link>
			{/* 実在しない日付を formatDate に渡すと NaN月 になるため、そのまま出す */}
			<h2 className="mt-2 font-bold">
				{isDate(date) ? formatDate(date) : date} の枠
			</h2>
			<p className="mt-2 text-xs text-gray-600">
				種類を発表以外にすると、その枠の予約は削除されます。時刻だけの変更なら予約は残ります。開始時刻を過ぎた枠は変更できません
			</p>

			{resultMessage && (
				<p role="status" className="mt-2 text-sm text-green-700">
					{resultMessage}
				</p>
			)}
			{dayQuery.isPending && (
				<p className="mt-2 text-sm text-gray-600">読み込み中…</p>
			)}
			{dayQuery.isError && (
				<div role="alert" className="mt-2 text-sm text-red-700">
					{loadErrorMessage(dayQuery.error) ?? (
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

			{/* 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中は表を出さない（古い枠のまま編集させないため） */}
			{data && !dayQuery.isError && (
				<>
					{data.day.status === "closed" && (
						<p className="mt-2 rounded bg-gray-100 p-2 text-sm">
							休講日です（枠は編集できます）
						</p>
					)}
					{data.slots.length > 0 ? (
						<ul className="mt-2 divide-y divide-gray-200 border-y border-gray-200">
							{data.slots.map((slot) => (
								<SlotEditRow
									// 取り直して枠の値が変わったら入力欄を作り直し、新しい値から編集させる
									key={`${slot.id}-${slot.kind}-${slot.startTime}-${slot.endTime}`}
									slot={slot}
									isStarted={isSlotStarted(date, slot, now)}
									isSaving={editMutation.isPending}
									errorMessage={
										rowErrorSlotId === slot.id
											? editErrorMessage(editMutation.error)
											: null
									}
									onSave={(input) => save({ slot, input })}
								/>
							))}
						</ul>
					) : (
						<p className="mt-2 text-sm text-gray-600">この日の枠はありません</p>
					)}
				</>
			)}

			<ConfirmDialog
				isOpen={pendingEdit !== null}
				message={pendingEdit ? confirmMessage(pendingEdit) : ""}
				isPending={editMutation.isPending}
				errorMessage={
					editMutation.isError ? editErrorMessage(editMutation.error) : null
				}
				isResendable={!isClientError(editMutation.error)}
				onConfirm={() => {
					if (pendingEdit) {
						editMutation.mutate(pendingEdit);
					}
				}}
				onClose={() => setPendingEdit(null)}
			/>
		</section>
	);
}

function SlotEditRow({
	slot,
	isStarted,
	isSaving,
	errorMessage,
	onSave,
}: {
	slot: DaySlot;
	isStarted: boolean;
	isSaving: boolean;
	errorMessage: string | null;
	onSave: (input: SlotInput) => void;
}) {
	const [kind, setKind] = useState<SlotKind>(slot.kind);
	const [startTime, setStartTime] = useState(slot.startTime);
	const [endTime, setEndTime] = useState(slot.endTime);

	const isChanged =
		kind !== slot.kind ||
		startTime !== slot.startTime ||
		endTime !== slot.endTime;
	// 時刻の入力欄を空にすると "" になる。HH:MM は文字列のままで時刻の順に比べられる（API と同じ条件）
	const isTimeValid = startTime !== "" && endTime !== "" && startTime < endTime;

	return (
		<li className="py-2 text-sm">
			<p className="text-gray-600">
				{formatPeriod(slot.period)}
				{slot.reservation && ` ・ 予約: ${reserverName(slot.reservation)}`}
			</p>
			{isStarted ? (
				<p className="mt-1">
					{KIND_OPTION_LABELS[slot.kind]} {slotTime(slot)}
					<span className="ml-2 text-xs text-gray-600">（開始済み）</span>
				</p>
			) : (
				<form
					className="mt-1 flex flex-wrap items-center gap-1"
					onSubmit={(event) => {
						event.preventDefault();
						onSave({ kind, startTime, endTime });
					}}
				>
					<select
						value={kind}
						onChange={(event) => setKind(event.target.value as SlotKind)}
						aria-label="種類"
						className="rounded border border-gray-300 px-1 py-1"
					>
						{SLOT_KINDS.map((option) => (
							<option key={option} value={option}>
								{KIND_OPTION_LABELS[option]}
							</option>
						))}
					</select>
					<input
						type="time"
						value={startTime}
						onChange={(event) => setStartTime(event.target.value)}
						aria-label="開始時刻"
						className="rounded border border-gray-300 px-1 py-1"
					/>
					〜
					<input
						type="time"
						value={endTime}
						onChange={(event) => setEndTime(event.target.value)}
						aria-label="終了時刻"
						className="rounded border border-gray-300 px-1 py-1"
					/>
					<button
						type="submit"
						disabled={!isChanged || !isTimeValid || isSaving}
						className="ml-auto rounded bg-blue-700 px-3 py-1 text-white disabled:opacity-50"
					>
						保存
					</button>
				</form>
			)}
			{!isStarted && isChanged && !isTimeValid && (
				<p className="mt-1 text-xs text-red-700">
					開始時刻は終了時刻より前にしてください
				</p>
			)}
			{errorMessage && (
				<p role="alert" className="mt-1 text-xs text-red-700">
					{errorMessage}
				</p>
			)}
		</li>
	);
}
