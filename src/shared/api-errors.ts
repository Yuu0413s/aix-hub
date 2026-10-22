// API のエラーレスポンスの code。フロントはこの値を見て表示を分ける（api.md「エラーレスポンスの形」）
export const API_ERROR_CODES = {
	UNAUTHORIZED: "UNAUTHORIZED",
	FORBIDDEN: "FORBIDDEN",
	PROFILE_REQUIRED: "PROFILE_REQUIRED",
	VALIDATION_ERROR: "VALIDATION_ERROR",
	PROFILE_ALREADY_REGISTERED: "PROFILE_ALREADY_REGISTERED",
	PROFILE_NOT_REGISTERED: "PROFILE_NOT_REGISTERED",
} as const;

export function errorBody<Code extends string>(code: Code, message: string) {
	return { error: { code, message } };
}
