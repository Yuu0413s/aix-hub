import type { InferResponseType } from "hono/client";
import { formatDisplayName } from "../../shared/grade";
import { formatPeriod, SLOT_KIND_LABELS } from "../../shared/schedule-template";
import type { api } from "../lib/api";

// 1枠分の形は、GET /api/days/:date の成功時のレスポンスの型から作る（手で書くと、API を変えたときに食い違うため）
type DaySlot = InferResponseType<
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

function reserverLabel(slot: DaySlot, isClosed: boolean) {
	if (slot.kind !== "presentation") {
		return SLOT_KIND_LABELS[slot.kind];
	}
	if (slot.reservation) {
		// 予約にはプロフィールの登録が要るため通常は起きないが、DB の列は NULL を許すため、空欄にせず分かるようにする
		return formatDisplayName(
			slot.reservation.displayName ?? "名前未登録",
			slot.reservation.grade,
		);
	}
	// 休講日は予約できないため、「空き」とは出さない
	return isClosed ? "—" : "空き";
}

// スプシ風の枠の表。発表枠・休憩・先生からの共有・なし をすべて行として並べる
export function DaySlotTable({
	slots,
	isClosed,
}: {
	slots: DaySlot[];
	isClosed: boolean;
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
							<td
								className={`border border-gray-300 px-1 py-1 text-center tabular-nums ${isPresentation ? "" : "bg-gray-50"}`}
							>
								{slot.startTime}
							</td>
							<td
								className={`border border-gray-300 px-1 py-1 text-center tabular-nums ${isPresentation ? "" : "bg-gray-50"}`}
							>
								{slot.endTime}
							</td>
							<td
								className={`border border-gray-300 px-2 py-1 break-words ${isPresentation ? "" : "bg-gray-50 text-gray-500"} ${isFree ? "text-gray-400" : ""}`}
							>
								{reserverLabel(slot, isClosed)}
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}
