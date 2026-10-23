import type { InferResponseType } from "hono/client";
import { formatDisplayName } from "../../shared/grade";
import { formatPeriod, SLOT_KIND_LABELS } from "../../shared/schedule-template";
import type { api } from "../lib/api";

// 1枠分の形は、GET /api/days/:date の成功時のレスポンスの型から作る（手で書くと、API を変えたときに食い違うため）
export type DaySlot = InferResponseType<
	(typeof api.api.days)[":date"]["$get"],
	200
>["slots"][number];

// 続けて並ぶ同じ時限の枠の数を、先頭の枠の位置に入れて返す（先頭でない枠は 0）。
// スプシのセル結合のように、時限のセルを rowSpan でまとめるため。
// 管理者の編集で時限が飛び飛びになっても崩れないよう、時限ごとの合計ではなく「続けて並ぶ数」で数える
function periodRowSpans(slots: DaySlot[]): number[] {
	const spans = slots.map(() => 0);
	let start = 0;
	for (const [index, slot] of slots.entries()) {
		if (slot.period !== slots[start]?.period) {
			start = index;
		}
		spans[start] = (spans[start] ?? 0) + 1;
	}
	return spans;
}

// 予約者の表示名。予約にはプロフィールの登録が要るため通常は起きないが、DB の列は NULL を許すため、空欄にせず分かるようにする
export function reserverName(reservation: NonNullable<DaySlot["reservation"]>) {
	return formatDisplayName(
		reservation.displayName ?? "名前未登録",
		reservation.grade,
	);
}

function reserverLabel(slot: DaySlot, isClosed: boolean) {
	if (slot.kind !== "presentation") {
		return SLOT_KIND_LABELS[slot.kind];
	}
	if (slot.reservation) {
		return reserverName(slot.reservation);
	}
	// 休講日は予約できないため、「空き」とは出さない
	return isClosed ? "—" : "空き";
}

const CELL_BUTTON_CLASS =
	"w-full text-left text-blue-700 underline underline-offset-2";

// 予約者のセルの中身。押せるかどうかは API が返す isReservable / isCancelable で決める
// （予約できる条件を画面でも書くと、API と食い違ったときに「押せるのに 409 になる」ため）
function ReserverCell({
	slot,
	isClosed,
	onReserve,
	onCancel,
}: {
	slot: DaySlot;
	isClosed: boolean;
	onReserve: (slot: DaySlot) => void;
	onCancel: (slot: DaySlot) => void;
}) {
	const label = reserverLabel(slot, isClosed);
	if (slot.isReservable) {
		return (
			<button
				type="button"
				onClick={() => onReserve(slot)}
				aria-label={`${slot.startTime}〜${slot.endTime} を予約する`}
				className={CELL_BUTTON_CLASS}
			>
				{label}
			</button>
		);
	}
	if (slot.reservation?.isCancelable) {
		return (
			<button
				type="button"
				onClick={() => onCancel(slot)}
				aria-label={`${label} の ${slot.startTime}〜${slot.endTime} の予約を取り消す`}
				className={CELL_BUTTON_CLASS}
			>
				{label}
			</button>
		);
	}
	return label;
}

// スプシ風の枠の表。発表枠・休憩・先生からの共有・なし をすべて行として並べる
export function DaySlotTable({
	slots,
	isClosed,
	onReserve,
	onCancel,
}: {
	slots: DaySlot[];
	isClosed: boolean;
	onReserve: (slot: DaySlot) => void;
	onCancel: (slot: DaySlot) => void;
}) {
	const rowSpans = periodRowSpans(slots);

	return (
		<table
			className={`w-full table-fixed border-collapse text-sm ${isClosed ? "text-gray-400" : ""}`}
		>
			<colgroup>
				<col className="w-12" />
				<col className="w-14" />
				<col className="w-14" />
				<col />
			</colgroup>
			<thead>
				<tr className="bg-gray-100 text-xs text-gray-600">
					<th scope="col" className="border border-gray-300 px-1 py-1">
						時限
					</th>
					<th scope="col" className="border border-gray-300 px-1 py-1">
						開始
					</th>
					<th scope="col" className="border border-gray-300 px-1 py-1">
						終了
					</th>
					<th scope="col" className="border border-gray-300 px-2 py-1">
						予約者
					</th>
				</tr>
			</thead>
			<tbody>
				{slots.map((slot, index) => {
					const rowSpan = rowSpans[index] ?? 0;
					const isPresentation = slot.kind === "presentation";
					const isFree = isPresentation && slot.reservation === null;
					const timeCellClass = `border border-gray-300 px-1 py-1 text-center tabular-nums ${isPresentation ? "" : "bg-gray-50"}`;
					return (
						<tr key={slot.id}>
							{rowSpan > 0 && (
								<th
									scope="rowgroup"
									rowSpan={rowSpan}
									className="border border-gray-300 px-1 py-1 align-top font-normal"
								>
									{formatPeriod(slot.period)}
								</th>
							)}
							<td className={timeCellClass}>{slot.startTime}</td>
							<td className={timeCellClass}>{slot.endTime}</td>
							<td
								className={`border border-gray-300 px-2 py-1 break-words ${isPresentation ? "" : "bg-gray-50 text-gray-500"} ${isFree ? "text-gray-400" : ""}`}
							>
								<ReserverCell
									slot={slot}
									isClosed={isClosed}
									onReserve={onReserve}
									onCancel={onCancel}
								/>
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}
