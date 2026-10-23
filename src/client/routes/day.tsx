import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { API_ERROR_CODES } from "../../shared/api-errors";
import { isDate, isMonth } from "../../shared/date";
import { DaySlotTable } from "../components/day-slot-table";
import { ApiError, api, readErrorCode, shouldRetry } from "../lib/api";
import { formatDate } from "../lib/format-date";

// 理由ごとの文言を返す。null なら、やり直しで直るかもしれないエラーとして「再読み込み」を出す
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
		retry: shouldRetry,
	});
	const data = dayQuery.data;

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

			{data && (
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
							/>
						) : (
							<p className="text-sm text-gray-600">この日の枠はありません</p>
						)}
					</div>
				</>
			)}
		</main>
	);
}
