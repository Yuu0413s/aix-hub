import { API_ERROR_CODES } from "../../shared/api-errors";
import { ApiError, isClientError } from "./api";

// 連絡の作成・編集・削除の失敗の文言。入力欄と削除の確認ダイアログで、同じ失敗に同じ文言を出すため、ここにまとめる。
// action-error.ts と同じく、4xx では送り直しを促さず、送り直しを促すのは通信の失敗・5xx のときだけにする
export function announcementErrorMessage(error: unknown) {
	switch (error instanceof ApiError ? error.code : null) {
		case API_ERROR_CODES.UNAUTHORIZED:
			return "ログインの有効期限が切れました。ページを再読み込みして、ログインし直してください";
		case API_ERROR_CODES.VALIDATION_ERROR:
			return "入力内容を確認してください";
		case API_ERROR_CODES.SEMINAR_DAY_NOT_FOUND:
			return "選んだ日は開催日ではなくなりました。開催日を選び直してください";
		case API_ERROR_CODES.ANNOUNCEMENT_NOT_FOUND:
			return "この連絡はすでに削除されています";
		case API_ERROR_CODES.FORBIDDEN:
			return "この連絡を変更する権限がありません";
	}
	return isClientError(error)
		? "送信できませんでした。ページを再読み込みしてください"
		: "送信できませんでした。時間をおいてもう一度お試しください";
}
