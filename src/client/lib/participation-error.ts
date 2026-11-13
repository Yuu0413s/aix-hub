import { API_ERROR_CODES } from "../../shared/api-errors";
import { ApiError, isClientError } from "./api";

// 学会への参加の表明・状態の変更・取消の失敗の文言。状態のボタンと取消の確認ダイアログで、同じ失敗に同じ文言を出すため、ここにまとめる。
// action-error.ts と同じく、4xx では送り直しを促さず、送り直しを促すのは通信の失敗・5xx のときだけにする。
// 参加済み・取消済みのときは、画面が詳細を取り直して今の状態を出し直す（participation-section.tsx）ため、そのことも伝える。
// 学会がすでに削除されていたときは、詳細を取り直さずにこの文言を残す（取り直すと 404 で詳細の中身が消えるため）
export function participationErrorMessage(error: unknown) {
	switch (error instanceof ApiError ? error.code : null) {
		case API_ERROR_CODES.UNAUTHORIZED:
			return "ログインの有効期限が切れました。ページを再読み込みして、ログインし直してください";
		case API_ERROR_CODES.PROFILE_REQUIRED:
			return "先にプロフィールを登録してください";
		case API_ERROR_CODES.CONFERENCE_NOT_FOUND:
			return "この学会はすでに削除されています";
		case API_ERROR_CODES.CONFERENCE_ALREADY_PARTICIPATING:
			return "この学会にはすでに参加しています。今の状態を表示し直しました";
		case API_ERROR_CODES.CONFERENCE_PARTICIPANT_NOT_FOUND:
			return "この参加はすでに取り消されています。今の状態を表示し直しました";
		case API_ERROR_CODES.FORBIDDEN:
			return "ほかの人の参加は変更できません";
	}
	return isClientError(error)
		? "送信できませんでした。ページを再読み込みしてください"
		: "送信できませんでした。時間をおいてもう一度お試しください";
}
