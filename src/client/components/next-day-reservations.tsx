import { useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { tokyoDate } from "../../shared/date";
import { ApiError, api, isRetryable, readErrorCode } from "../lib/api";
import { formatDate } from "../lib/format-date";
import { reserverName } from "./day-slot-table";

// 形は、GET /api/days/next の成功時のレスポンスの型から作る（手で書くと、API を変えたときに食い違うため）
type NextDay = InferResponseType<typeof api.api.days.next.$get, 200>;

// 今日（日本時間）、今日が開催日でなければ次の開催日の予約者一覧。teacher のマイページと、admin のマイページの「今日の予約すべて」で使う。
// 見るだけの一覧で、予約・取消は日別の表で行う（2026-11-14, Issue #28 で決定）
export function NextDayReservations() {
	const nextDayQuery = useQuery({
		// キーを ["day", ...] にするのは、マイページの取消や表示名の変更で ["day"] を取り直すときに、この一覧も一緒に取り直すため
		queryKey: ["day", "next"],
		queryFn: async () => {
			const res = await api.api.days.next.$get();
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`予約者を取得できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return res.json();
		},
		retry: isRetryable,
	});
	const data = nextDayQuery.data;

	return (
		<section className="mt-8">
			<h2 className="font-bold">今日の予約者</h2>

			{nextDayQuery.isPending && (
				<p className="mt-2 text-sm text-gray-600">読み込み中…</p>
			)}
			{nextDayQuery.isError && (
				<div role="alert" className="mt-2 text-sm text-red-700">
					予約者を読み込めませんでした
					<button
						type="button"
						onClick={() => nextDayQuery.refetch()}
						className="ml-2 underline"
					>
						再読み込み
					</button>
				</div>
			)}

			{/* 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中は一覧を出さない（day.tsx と同じ理由） */}
			{data && !nextDayQuery.isError && <NextDaySummary data={data} />}
		</section>
	);
}

function NextDaySummary({ data }: { data: NextDay }) {
	const { day } = data;
	if (day === null) {
		return (
			<p className="mt-2 text-sm text-gray-600">
				予定されている開催日はありません
			</p>
		);
	}

	// 今日かどうかは画面の時計で決める。API は日本時間の今日以降で一番近い日を返すため、今日でなければ次の開催日
	const isToday = day.date === tokyoDate(new Date());
	// 予約のある枠だけを、API が返す開始時刻の順のまま並べる
	const reservedSlots = data.slots.flatMap((slot) =>
		slot.reservation ? [{ ...slot, reservation: slot.reservation }] : [],
	);

	return (
		<>
			<p className="mt-2 text-sm">
				{isToday
					? `今日：${formatDate(day.date)}`
					: `次の開催日：${formatDate(day.date)}`}
			</p>
			{/* 休講の日は理由だけを出す（今日・次の開催日を、休止日を飛ばさずに出すため。Issue #28 で決定） */}
			{day.status === "closed" ? (
				<p className="mt-1 text-sm text-gray-600">
					休講
					{day.closedReason && `（${day.closedReason}）`}
				</p>
			) : reservedSlots.length === 0 ? (
				<p className="mt-1 text-sm text-gray-600">予約はありません</p>
			) : (
				<ul className="mt-1 divide-y divide-gray-200 border-y border-gray-200">
					{reservedSlots.map((slot) => (
						<li key={slot.id} className="flex gap-3 py-2 text-sm">
							<Link
								to={`/days/${day.date}`}
								className="shrink-0 text-blue-700 underline underline-offset-2"
							>
								{slot.startTime}〜{slot.endTime}
							</Link>
							<span>{reserverName(slot.reservation)}</span>
						</li>
					))}
				</ul>
			)}
		</>
	);
}
