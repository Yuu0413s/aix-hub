// API のエラーレスポンスの code の一覧。フロントはこの値を見て表示を分ける（api.md「エラーレスポンスの形」）
export const API_ERROR_CODES = {
	// ステータスから決まるもの（error-handler.ts が HTTPException・想定外のエラーに付ける。api.md「HTTPException」）
	BAD_REQUEST: "BAD_REQUEST",
	UNAUTHORIZED: "UNAUTHORIZED",
	FORBIDDEN: "FORBIDDEN",
	NOT_FOUND: "NOT_FOUND",
	CONFLICT: "CONFLICT",
	HTTP_ERROR: "HTTP_ERROR",
	INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
	// API が理由を区別して返すもの
	PROFILE_REQUIRED: "PROFILE_REQUIRED",
	VALIDATION_ERROR: "VALIDATION_ERROR",
	PROFILE_ALREADY_REGISTERED: "PROFILE_ALREADY_REGISTERED",
	PROFILE_NOT_REGISTERED: "PROFILE_NOT_REGISTERED",
	SEMINAR_DAY_NOT_FOUND: "SEMINAR_DAY_NOT_FOUND",
	SLOT_NOT_FOUND: "SLOT_NOT_FOUND",
	SLOT_TAKEN: "SLOT_TAKEN",
	// 発表以外の枠・休止日の枠・開始時刻を過ぎた枠
	SLOT_NOT_RESERVABLE: "SLOT_NOT_RESERVABLE",
	RESERVATION_NOT_FOUND: "RESERVATION_NOT_FOUND",
	// 本人の予約でも、開始時刻を過ぎたもの・done のもの（admin は取り消せる）
	RESERVATION_NOT_CANCELABLE: "RESERVATION_NOT_CANCELABLE",
	ANNOUNCEMENT_NOT_FOUND: "ANNOUNCEMENT_NOT_FOUND",
	CONFERENCE_NOT_FOUND: "CONFERENCE_NOT_FOUND",
	// 同じ学会名の学会がすでにある（登録・編集できない）
	CONFERENCE_TITLE_TAKEN: "CONFERENCE_TITLE_TAKEN",
	// 登録・編集で選んだシリーズが無い
	CONFERENCE_SERIES_NOT_FOUND: "CONFERENCE_SERIES_NOT_FOUND",
	// 同じ名前のシリーズがすでにある（作れない）
	CONFERENCE_SERIES_NAME_TAKEN: "CONFERENCE_SERIES_NAME_TAKEN",
	// 今日より前の開催日（休止・再開できない）
	SEMINAR_DAY_PAST: "SEMINAR_DAY_PAST",
	// 開始時刻を過ぎた枠（編集できない）
	SLOT_STARTED: "SLOT_STARTED",
	// 同じ日のほかの枠と開始時刻が同じ（編集できない）
	SLOT_START_TIME_TAKEN: "SLOT_START_TIME_TAKEN",
	// 画面で見ていた変更前の値が、今の枠と違う（ほかの管理者の変更や、応答が届かなかった自分の送信の反映など。編集できない）
	SLOT_CHANGED: "SLOT_CHANGED",
	USER_NOT_FOUND: "USER_NOT_FOUND",
	// 変更すると在籍中の admin が0人になる（役割を変更できない）
	LAST_ADMIN: "LAST_ADMIN",
	// 学年の無い人を、学年を送らずに student にしようとした（学生は学年を必ず持つ）
	GRADE_REQUIRED: "GRADE_REQUIRED",
	// 4月（日本時間）以外は学年更新を実行できない
	GRADE_PROMOTION_NOT_OPEN: "GRADE_PROMOTION_NOT_OPEN",
	// その年度の学年更新は実行済み（2回実行すると全員の学年が2つ上がるため）
	GRADE_PROMOTION_ALREADY_EXECUTED: "GRADE_PROMOTION_ALREADY_EXECUTED",
	// 進路を選ぶ人（B4・MIDS_B4・M2）の進路が抜けている
	GRADE_PROMOTION_PATH_REQUIRED: "GRADE_PROMOTION_PATH_REQUIRED",
} as const;

export function errorBody<Code extends string>(code: Code, message: string) {
	return { error: { code, message } };
}
