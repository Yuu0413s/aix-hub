import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod";
import { API_ERROR_CODES, errorBody } from "../shared/api-errors";

// JSON の本文を zod で検証する。失敗したら、zod の既定の形ではなく共通の形の 400 を返す（api.md）
export function validateJson<Schema extends ZodType>(schema: Schema) {
	return zValidator("json", schema, (result, c) => {
		if (!result.success) {
			return c.json(
				errorBody(
					API_ERROR_CODES.VALIDATION_ERROR,
					"入力内容を確認してください",
				),
				400,
			);
		}
	});
}
