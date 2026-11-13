import { type QueryClient, queryOptions } from "@tanstack/react-query";
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

// 学会が消えたとき（削除した・すでに削除されていた）に、一覧と詳細に古い印を付け、次に開いたときに取り直させる
// （「戻る」などで開き直したときに、消えた学会がそのまま見えないようにするため。詳細画面の staleTime の間でも取り直す）。
// いま表示中の詳細はここでは取り直さない。取り直すと 404 で中身と文言が消えるため。
// 同じ理由で、呼ぶ画面は、画面に戻ったときと通信が戻ったときの取り直しも止めておく（edit.tsx・detail.tsx）。
// ただし participation-section.tsx は止めなくてよい。取り直して 404 になっても、詳細画面が「自分の状態」を描き続けるため、文言は残る
export function markConferenceGone(queryClient: QueryClient, id: string) {
	queryClient.invalidateQueries({ queryKey: ["conferences"] });
	queryClient.invalidateQueries({
		queryKey: conferenceQueryOptions(id).queryKey,
		refetchType: "none",
	});
}
