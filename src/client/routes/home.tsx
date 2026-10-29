import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { addMonths, isMonth, splitMonth, tokyoDate } from "../../shared/date";
import { MonthCalendar } from "../components/month-calendar";
import { ApiError, api, isRetryable } from "../lib/api";
import { useWeekStart, type WeekStart } from "../lib/week-start";

const WEEK_START_OPTIONS: { value: WeekStart; label: string }[] = [
	{ value: "sunday", label: "日曜始まり" },
	{ value: "monday", label: "月曜始まり" },
];

function formatMonth(month: string) {
	const { year, monthNumber } = splitMonth(month);
	return `${year}年${monthNumber}月`;
}

export function HomePage() {
	const [weekStart, setWeekStart] = useWeekStart();

	// 表示中の月は URL に持つ（日別の表から「戻る」で、見ていた月に戻れるように）。
	// 無いときや形式が不正なときは、日本時間の今月を表示する
	const [searchParams, setSearchParams] = useSearchParams();
	const monthParam = searchParams.get("month");
	const month = isMonth(monthParam)
		? monthParam
		: tokyoDate(new Date()).slice(0, 7);
	const previousMonth = addMonths(month, -1);
	const nextMonth = addMonths(month, 1);

	// 月ごとに別のキーで取る。前の月の結果を表示し続ける設定（placeholderData）は使わない。
	// 読み込み中・失敗時に、前の月の開催日の印が今の月に付いて見えないようにするため
	const daysQuery = useQuery({
		queryKey: ["days", month],
		queryFn: async () => {
			const res = await api.api.days.$get({ query: { month } });
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`開催日を取得できませんでした: ${res.status}`,
				);
			}
			return res.json();
		},
		retry: isRetryable,
	});

	return (
		<main className="mx-auto max-w-md p-4">
			<section>
				<div className="flex items-center justify-between">
					{/* 2000〜2099 年の外は API が受け付けないため、端の月ではボタンを押せなくする */}
					<button
						type="button"
						onClick={() => setSearchParams({ month: previousMonth })}
						disabled={!isMonth(previousMonth)}
						aria-label="前の月"
						className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-40"
					>
						‹
					</button>
					<h1 className="font-bold">{formatMonth(month)}</h1>
					<button
						type="button"
						onClick={() => setSearchParams({ month: nextMonth })}
						disabled={!isMonth(nextMonth)}
						aria-label="次の月"
						className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-40"
					>
						›
					</button>
				</div>

				<fieldset className="mt-2 flex justify-end gap-1 text-xs">
					<legend className="sr-only">週の始まり</legend>
					{WEEK_START_OPTIONS.map((option) => (
						<button
							key={option.value}
							type="button"
							onClick={() => setWeekStart(option.value)}
							aria-pressed={weekStart === option.value}
							className="rounded border border-gray-300 px-2 py-1 aria-pressed:bg-gray-800 aria-pressed:text-white"
						>
							{option.label}
						</button>
					))}
				</fieldset>

				<div className="mt-2">
					{/* 月が変わったら選んでいた休講日の理由を消すため、月ごとに作り直す */}
					<MonthCalendar
						key={month}
						month={month}
						days={daysQuery.data?.days}
						weekStart={weekStart}
					/>
				</div>
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
			</section>
		</main>
	);
}
