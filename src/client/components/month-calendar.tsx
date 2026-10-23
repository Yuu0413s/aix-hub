import { useState } from "react";
import { Link } from "react-router";
import { addMonths } from "../../shared/date";
import type { WeekStart } from "../lib/week-start";

export type CalendarDay = {
	date: string;
	status: "open" | "closed";
	closedReason: string | null;
	availableSlotCount: number;
};

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const DAY_MS = 24 * 60 * 60 * 1000;

// 曜日と日数は、実行環境のタイムゾーンに左右されないよう UTC の値だけで計算する（shared/date.ts と同じ理由）
function utcDate(date: string) {
	return new Date(`${date}T00:00:00Z`);
}

function formatDate(date: string) {
	const day = utcDate(date);
	return `${day.getUTCMonth() + 1}月${day.getUTCDate()}日（${WEEKDAY_LABELS[day.getUTCDay()]}）`;
}

// days が undefined のとき（読み込み中・失敗時）は日付だけを表示し、どの日もクリックできないようにする。
// 前の月の開催日の印を残したまま、別の月を表示しないため
export function MonthCalendar({
	month,
	days,
	weekStart,
}: {
	month: string;
	days: CalendarDay[] | undefined;
	weekStart: WeekStart;
}) {
	const [selectedClosedDay, setSelectedClosedDay] =
		useState<CalendarDay | null>(null);

	const firstDay = utcDate(`${month}-01`);
	const dayCount =
		(utcDate(`${addMonths(month, 1)}-01`).getTime() - firstDay.getTime()) /
		DAY_MS;
	const weekStartIndex = weekStart === "sunday" ? 0 : 1;
	// 1日の前に空ける マスの数
	const leadingBlankCount = (firstDay.getUTCDay() - weekStartIndex + 7) % 7;
	const weekdayLabels = [
		...WEEKDAY_LABELS.slice(weekStartIndex),
		...WEEKDAY_LABELS.slice(0, weekStartIndex),
	];
	const dates = Array.from(
		{ length: dayCount },
		(_, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
	);
	const daysByDate = new Map(days?.map((day) => [day.date, day]));

	return (
		<div>
			<div className="grid grid-cols-7 text-center text-xs text-gray-500">
				{weekdayLabels.map((label) => (
					<div key={label} className="py-1">
						{label}
					</div>
				))}
			</div>
			<div className="grid grid-cols-7 gap-1">
				{Array.from({ length: leadingBlankCount }, (_, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 中身の無いマスで並び替わらないため、位置を key にしてよい
					<div key={`blank-${index}`} />
				))}
				{dates.map((date) => {
					const dayNumber = Number(date.slice(8));
					const day = daysByDate.get(date);

					if (day?.status === "open") {
						return (
							<Link
								key={date}
								to={`/days/${date}`}
								aria-label={`${formatDate(date)} 空き ${day.availableSlotCount} 枠`}
								className="flex h-14 flex-col items-center justify-center rounded border border-blue-300 bg-blue-50 text-sm hover:bg-blue-100"
							>
								<span className="font-bold">{dayNumber}</span>
								<span className="text-xs text-blue-700">
									<span className="hidden sm:inline">空き </span>
									{day.availableSlotCount}
								</span>
							</Link>
						);
					}

					if (day?.status === "closed") {
						return (
							<button
								key={date}
								type="button"
								onClick={() => setSelectedClosedDay(day)}
								aria-label={`${formatDate(date)} 休講日`}
								className="group relative flex h-14 flex-col items-center justify-center rounded bg-gray-200 text-sm text-gray-500"
							>
								<span>{dayNumber}</span>
								{/* hover: はマウスのある端末にだけ効く（Tailwind 4）。スマホでタップしたあとに出たままにならない */}
								<span className="pointer-events-none absolute -top-7 hidden rounded bg-gray-800 px-2 py-1 text-xs whitespace-nowrap text-white group-hover:block">
									休講日
								</span>
							</button>
						);
					}

					return (
						<div
							key={date}
							className="flex h-14 items-center justify-center text-sm text-gray-400"
						>
							{dayNumber}
						</div>
					);
				})}
			</div>
			{selectedClosedDay && (
				<p role="status" className="mt-3 rounded bg-gray-100 p-3 text-sm">
					{formatDate(selectedClosedDay.date)} 休講日
					{selectedClosedDay.closedReason
						? `：${selectedClosedDay.closedReason}`
						: "（理由は登録されていません）"}
				</p>
			)}
		</div>
	);
}
