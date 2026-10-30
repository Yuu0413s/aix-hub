import { queryOptions } from "@tanstack/react-query";
import { ApiError, api, isRetryable } from "./api";

// 月の開催日の取得。カレンダー（home.tsx）と、連絡を書く開催日の候補（announcement-form.tsx）で同じキャッシュを使うため、
// キーと取り方を1か所にまとめる（片方だけ変えると、同じキーに違う形のデータが入るため）
export function monthDaysQueryOptions(month: string) {
	return queryOptions({
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
}
