import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { addMonths, isMonth, tokyoDate } from "../../shared/date";
import { AnnouncementSection } from "../components/announcement-section";
import { Button } from "../components/button";
import { TEXT_LINK_CLASS } from "../components/class-names";
import { MonthCalendar } from "../components/month-calendar";
import { formatMonth } from "../lib/format-date";
import { monthDaysQueryOptions } from "../lib/month-days-query";
import { useWeekStart } from "../lib/week-start";

export function HomePage() {
	// 週の始まりはマイページで選ぶ（Issue #35）。ここでは保存された値を読むだけにする
	const [weekStart] = useWeekStart();

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
	const daysQuery = useQuery(monthDaysQueryOptions(month));

	return (
		<main className="mx-auto max-w-md p-4">
			{/* 次のゼミの連絡を先に読めるよう、カレンダーの上に置く */}
			<AnnouncementSection />
			<section className="mt-8">
				<div className="flex items-center justify-between">
					{/* 2000〜2099 年の外は API が受け付けないため、端の月ではボタンを押せなくする */}
					<Button
						type="button"
						variant="secondary"
						onClick={() => setSearchParams({ month: previousMonth })}
						disabled={!isMonth(previousMonth)}
						aria-label="前の月"
					>
						‹
					</Button>
					<h1 className="text-xl font-bold">{formatMonth(month)}</h1>
					<Button
						type="button"
						variant="secondary"
						onClick={() => setSearchParams({ month: nextMonth })}
						disabled={!isMonth(nextMonth)}
						aria-label="次の月"
					>
						›
					</Button>
				</div>

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
					<p className="mt-2 text-sm text-fg-muted">読み込み中…</p>
				)}
				{daysQuery.isError && (
					<div role="alert" className="mt-2 text-sm text-danger">
						開催日を読み込めませんでした
						<button
							type="button"
							onClick={() => daysQuery.refetch()}
							className={`ml-2 ${TEXT_LINK_CLASS}`}
						>
							再読み込み
						</button>
					</div>
				)}
			</section>
		</main>
	);
}
