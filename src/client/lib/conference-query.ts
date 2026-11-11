import { queryOptions } from "@tanstack/react-query";
import { ApiError, api, isRetryable, readErrorCode } from "./api";

// 学会の詳細の取得。詳細画面（conferences/detail.tsx）と編集画面（conferences/edit.tsx）で同じキャッシュを使うため、
// キーと取り方を1か所にまとめる（day-query.ts と同じ理由）
export function conferenceQueryOptions(id: string) {
	return queryOptions({
		queryKey: ["conference", id],
		queryFn: async () => {
			const res = await api.api.conferences[":id"].$get({ param: { id } });
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`学会を取得できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return res.json();
		},
		retry: isRetryable,
	});
}
