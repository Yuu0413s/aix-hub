import { hc } from "hono/client";
import type { AppType } from "../../worker/index";

export const api = hc<AppType>("/");

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
