import { queryOptions } from "@tanstack/react-query";
import { API_ERROR_CODES } from "../../shared/api-errors";
import { isDate } from "../../shared/date";
import { ApiError, api, isRetryable, readErrorCode } from "./api";

// その日の枠の取得。日別の表（day.tsx）と、管理画面の枠の編集（admin/day-slots.tsx）で同じキャッシュを使うため、
// キーと取り方を1か所にまとめる（month-days-query.ts と同じ理由）
export function dayQueryOptions(date: string) {
	return queryOptions({
		queryKey: ["day", date],
		queryFn: async () => {
			// 日付でない文字列（URL の /days/next など）は API に送らず、API の日付の検証と同じ 400 にする。
			// 送ると GET /api/days/next などの文字が決まったパスに当たり、別の日の枠を日別の表として返してしまうため
			if (!isDate(date)) {
				throw new ApiError(
					400,
					`日付が正しくありません: ${date}`,
					API_ERROR_CODES.VALIDATION_ERROR,
				);
			}
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
