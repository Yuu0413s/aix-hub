import { API_ERROR_CODES } from "../../shared/api-errors";
import { ApiError, isClientError } from "./api";

// 予約・取消の失敗の文言。日別の表とマイページで、同じ失敗に同じ文言を出すため、ここにまとめる。
// 4xx は送り直しても結果が変わらないため、呼び出し側の確認ダイアログは「はい」を出さない（isResendable）。
// 文言でも送り直しを促さず、送り直しを促すのは、通信の失敗・5xx（一時的なことがある）のときだけにする
export function actionErrorMessage(error: unknown) {
	const message = knownActionErrorMessage(error);
	if (message) {
		return message;
	}
	return isClientError(error)
		? "送信できませんでした。ページを再読み込みしてください"
		: "送信できませんでした。時間をおいてもう一度お試しください";
}

// 理由が分かる失敗の文言。分からなければ null
function knownActionErrorMessage(error: unknown) {
	switch (error instanceof ApiError ? error.code : null) {
		case API_ERROR_CODES.UNAUTHORIZED:
			return "ログインの有効期限が切れました。ページを再読み込みして、ログインし直してください";
		case API_ERROR_CODES.PROFILE_REQUIRED:
			return "先にプロフィールを登録してください";
		case API_ERROR_CODES.SLOT_TAKEN:
			return "この枠はすでに予約されています";
		case API_ERROR_CODES.SLOT_NOT_RESERVABLE:
			return "この枠は予約できません（開始時刻を過ぎたか、予約を受け付けていない枠です）";
		case API_ERROR_CODES.SLOT_NOT_FOUND:
			return "この枠は見つかりませんでした";
		case API_ERROR_CODES.RESERVATION_NOT_FOUND:
			return "この予約はすでに取り消されています";
		case API_ERROR_CODES.RESERVATION_NOT_CANCELABLE:
			return "開始時刻を過ぎた予約・実施済みの予約は取り消せません";
		case API_ERROR_CODES.FORBIDDEN:
			return "この操作を行う権限がありません";
		default:
			return null;
	}
}
