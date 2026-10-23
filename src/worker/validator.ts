import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import type { ZodType } from "zod";
import { API_ERROR_CODES, errorBody } from "../shared/api-errors";

// 失敗したら、zod の既定の形ではなく共通の形の 400 を返す（api.md）
function onValidationError(result: { success: boolean }, c: Context) {
	if (!result.success) {
		return c.json(
			errorBody(API_ERROR_CODES.VALIDATION_ERROR, "入力内容を確認してください"),
			400,
		);
	}
}

// JSON の本文を zod で検証する
export function validateJson<Schema extends ZodType>(schema: Schema) {
	return zValidator("json", schema, onValidationError);
}

// クエリ（?month=... など）を zod で検証する。
// 同じ名前が2つ以上あると配列で渡るため、文字列を期待するスキーマでは検証エラーになる
export function validateQuery<Schema extends ZodType>(schema: Schema) {
	return zValidator("query", schema, onValidationError);
}
