import { queryOptions } from "@tanstack/react-query";
import { ApiError, api, isRetryable, readErrorCode } from "./api";

// その日の枠の取得。日別の表（day.tsx）と、管理画面の枠の編集（admin/day-slots.tsx）で同じキャッシュを使うため、
// キーと取り方を1か所にまとめる（month-days-query.ts と同じ理由）
export function dayQueryOptions(date: string) {
	return queryOptions({
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
		retry: isRetryable,
	});
}
