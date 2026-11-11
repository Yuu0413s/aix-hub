import { queryOptions } from "@tanstack/react-query";
import { ApiError, api, isRetryable, readErrorCode } from "./api";

// シリーズの一覧の取得。シリーズのプルダウン（series-select.tsx）が使う。
// 学会のフォーム（conference-form.tsx）も、シリーズが無くなったときに同じキー（["conference-series"]）で取り直すため、
// キーを変えるときは、series-select.tsx と conference-form.tsx の取り直しのキーも合わせて変える（作ったシリーズの書き足しは、ここのキーを使う）
export function conferenceSeriesQueryOptions() {
	return queryOptions({
		queryKey: ["conference-series"],
		queryFn: async () => {
			const res = await api.api["conference-series"].$get();
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`シリーズを取得できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return res.json();
		},
		retry: isRetryable,
	});
}
