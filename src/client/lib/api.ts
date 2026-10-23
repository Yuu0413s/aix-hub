import { hc } from "hono/client";
import type { AppType } from "../../worker/index";

export const api = hc<AppType>("/");

// 取得の失敗を、ステータスを付けて投げる（shouldRetry がステータスでやり直すかを決めるため）
export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

// TanStack Query の既定（3回、待ち時間を延ばしながらやり直す）に任せず、やり直す条件を明示する。
// 4xx（ログイン切れの 401 など）は何度送っても結果が変わらないため、やり直さずにすぐ失敗を表示する。
// 通信の失敗や 5xx は一時的なことがあるため、1回だけやり直す
export function shouldRetry(failureCount: number, error: unknown) {
	if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
		return false;
	}
	return failureCount < 1;
}

// エラーレスポンスの code を読む。ミドルウェアが返すエラー（401 など）は RPC の型に表れないため、型に頼らずに読む。
// 本文が共通の形でないとき（Cloudflare のエラー画面など）は null
export async function readErrorCode(res: Response): Promise<string | null> {
	try {
		const body: unknown = await res.json();
		if (
			typeof body === "object" &&
			body !== null &&
			"error" in body &&
			typeof body.error === "object" &&
			body.error !== null &&
			"code" in body.error &&
			typeof body.error.code === "string"
		) {
			return body.error.code;
		}
	} catch {
		// JSON でない本文
	}
	return null;
}
