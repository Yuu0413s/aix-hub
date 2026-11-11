import { queryOptions } from "@tanstack/react-query";
import { API_ERROR_CODES } from "../../shared/api-errors";
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

// 詳細の取得の失敗のうち、理由が分かるものだけ文言を返す。それ以外（ログイン切れの 401・5xx・通信の失敗など）は null を返し、
// 画面は共通の「読み込めませんでした＋再読み込み」を出す（day.tsx と同じ）。
// id の形が違う URL（400）も、利用者から見れば無い学会と同じため、同じ文言にする
export function conferenceQueryErrorMessage(error: unknown) {
	switch (error instanceof ApiError ? error.code : null) {
		case API_ERROR_CODES.CONFERENCE_NOT_FOUND:
		case API_ERROR_CODES.VALIDATION_ERROR:
			return "学会が見つかりません";
		default:
			return null;
	}
}
