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
} as const;

export function errorBody<Code extends string>(code: Code, message: string) {
	return { error: { code, message } };
}
