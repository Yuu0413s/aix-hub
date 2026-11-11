import { API_ERROR_CODES } from "../../shared/api-errors";
import { ApiError, isClientError } from "./api";

// 学会の登録・編集・削除と、シリーズの作成の失敗の文言。フォームと削除の確認ダイアログで、同じ失敗に同じ文言を出すため、ここにまとめる。
// action-error.ts と同じく、4xx では送り直しを促さず、送り直しを促すのは通信の失敗・5xx のときだけにする
// 学会がすでに削除されていた失敗か。詳細の削除ダイアログと、編集のフォームで同じ扱いにするため、ここにまとめる
export function isConferenceGone(error: unknown) {
	return (
		error instanceof ApiError &&
		error.code === API_ERROR_CODES.CONFERENCE_NOT_FOUND
	);
}

export function conferenceErrorMessage(error: unknown) {
	switch (error instanceof ApiError ? error.code : null) {
		case API_ERROR_CODES.UNAUTHORIZED:
			return "ログインの有効期限が切れました。ページを再読み込みして、ログインし直してください";
		case API_ERROR_CODES.PROFILE_REQUIRED:
			return "先にプロフィールを登録してください";
		case API_ERROR_CODES.VALIDATION_ERROR:
			return "入力内容を確認してください";
		case API_ERROR_CODES.CONFERENCE_NOT_FOUND:
			return "この学会はすでに削除されています";
		case API_ERROR_CODES.CONFERENCE_TITLE_TAKEN:
			return "同じ名前の学会がすでにあります。学会名を変えてください";
		case API_ERROR_CODES.CONFERENCE_SERIES_NOT_FOUND:
			return "選んだシリーズが見つかりません。シリーズを選び直してください";
		case API_ERROR_CODES.CONFERENCE_SERIES_NAME_TAKEN:
			return "同じ名前のシリーズがすでにあります。プルダウンから選んでください";
	}
	return isClientError(error)
		? "送信できませんでした。ページを再読み込みしてください"
		: "送信できませんでした。時間をおいてもう一度お試しください";
}
