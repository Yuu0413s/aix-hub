import type { InferResponseType } from "hono/client";
import { useState } from "react";
import { Link } from "react-router";
import { daysInMonth, utcMidnight } from "../../shared/date";
import type { api } from "../lib/api";
import { formatDate, WEEKDAY_LABELS } from "../lib/format-date";
import type { WeekStart } from "../lib/week-start";

// 1日分の形は、GET /api/days の成功時のレスポンスの型から作る（手で書くと、API を変えたときに食い違うため）
type CalendarDay = InferResponseType<
	typeof api.api.days.$get,
	200
>["days"][number];

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
	// 日付だけを持ち、表示のたびに最新の days から引き直す。
	// 日のデータを丸ごと持つと、取り直しで休講が取り消されても、古い理由が出たままになるため
	const [selectedDate, setSelectedDate] = useState<string | null>(null);

	// 週の最初の曜日を、getUTCDay() の曜日の番号（日曜=0、月曜=1）で表す。WEEKDAY_LABELS の位置とも同じ
	const weekStartIndex = weekStart === "sunday" ? 0 : 1;
	// 1日の前に空けるマスの数
	const leadingBlankCount =
		(utcMidnight(`${month}-01`).getUTCDay() - weekStartIndex + 7) % 7;
	const weekdayLabels = [
		...WEEKDAY_LABELS.slice(weekStartIndex),
		...WEEKDAY_LABELS.slice(0, weekStartIndex),
	];
	const dates = Array.from(
		{ length: daysInMonth(month) },
		(_, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
	);
	const daysByDate = new Map(days?.map((day) => [day.date, day]));
	const selectedDay = selectedDate ? daysByDate.get(selectedDate) : undefined;

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
								onClick={() => setSelectedDate(date)}
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
			{/* 取り直した結果、休講でなくなった日（または読み込み中・失敗で days が無いとき）は出さない */}
			{selectedDay?.status === "closed" && (
				<p role="status" className="mt-3 rounded bg-gray-100 p-3 text-sm">
					{formatDate(selectedDay.date)} 休講日
					{selectedDay.closedReason
						? `：${selectedDay.closedReason}`
						: "（理由は登録されていません）"}
				</p>
			)}
		</div>
	);
}
