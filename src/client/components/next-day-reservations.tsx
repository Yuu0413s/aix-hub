import { useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { tokyoDate } from "../../shared/date";
import { ApiError, api, isRetryable, readErrorCode } from "../lib/api";
import { formatDate } from "../lib/format-date";
import { TEXT_LINK_CLASS } from "./class-names";
import { reserverName } from "./day-slot-table";

// 形は、GET /api/days/next の成功時のレスポンスの型から作る（手で書くと、API を変えたときに食い違うため）
type NextDay = InferResponseType<typeof api.api.days.next.$get, 200>;

// 予約者一覧のキャッシュのキー。取消や表示名の変更のあとに取り直すため、me.tsx でも使う
export const NEXT_DAY_QUERY_KEY = ["next-day"];

// 今日（日本時間）、今日が開催日でなければ次の開催日の予約者一覧。teacher のマイページと、admin のマイページの「今日の予約すべて」で使う。
// 見るだけの一覧で、予約・取消は日別の表で行う（2026-11-14, Issue #28 で決定）
export function NextDayReservations() {
	const nextDayQuery = useQuery({
		// 日別の表のキー（["day", 日付]）とは分ける。["day", "next"] にすると、URL の /days/next を開いた日別の表が、
		// このキャッシュを日別の表の結果として読んでしまうため。マイページの取消・表示名の変更のあとは、me.tsx でこのキーも取り直す
		queryKey: NEXT_DAY_QUERY_KEY,
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
				<p className="mt-2 text-sm text-fg-muted">読み込み中…</p>
			)}
			{nextDayQuery.isError && (
				<div role="alert" className="mt-2 text-sm text-danger">
					予約者を読み込めませんでした
					<button
						type="button"
						onClick={() => nextDayQuery.refetch()}
						className={`ml-2 ${TEXT_LINK_CLASS}`}
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
			<p className="mt-2 text-sm text-fg-muted">
				予定されている開催日はありません
			</p>
		);
	}

	// 今日かどうかは画面の時計で決める。API は日本時間の今日以降で一番近い日を返すが、画面の今日より前の日が来ることもある
	// （日付をまたいで、取り直す前の前日の結果が残っているとき。端末の時計がずれているとき）。
	// そのときは「次の開催日」と出さず、日付だけを出す
	const today = tokyoDate(new Date());
	const dateLabel =
		day.date === today
			? `今日：${formatDate(day.date)}`
			: day.date > today
				? `次の開催日：${formatDate(day.date)}`
				: formatDate(day.date);
	// 予約のある枠だけを、API が返す開始時刻の順のまま並べる
	const reservedSlots = data.slots.flatMap((slot) =>
		slot.reservation ? [{ ...slot, reservation: slot.reservation }] : [],
	);

	return (
		<>
			<p className="mt-2 text-sm">{dateLabel}</p>
			{/* 休講の日は理由だけを出す（今日・次の開催日を、休止日を飛ばさずに出すため。Issue #28 で決定） */}
			{day.status === "closed" ? (
				<p className="mt-1 text-sm text-fg-muted">
					休講
					{day.closedReason && `（${day.closedReason}）`}
				</p>
			) : reservedSlots.length === 0 ? (
				<p className="mt-1 text-sm text-fg-muted">予約はありません</p>
			) : (
				<ul className="mt-1 divide-y divide-line border-y border-line">
					{reservedSlots.map((slot) => (
						<li key={slot.id} className="flex gap-3 py-2 text-sm">
							<Link
								to={`/days/${day.date}`}
								className={`shrink-0 ${TEXT_LINK_CLASS}`}
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
