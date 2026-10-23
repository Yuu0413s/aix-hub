import { createDb } from "./db/client";
import type { Bindings } from "./env";
import { formatLogValue, maskSecrets } from "./error-handler";
import { generateSeminarDays } from "./services/seminar-day";

// Cron Trigger（wrangler.jsonc の triggers.crons）で毎日動かす処理。
// scheduled のエラーは app.onError を通らないため、ここで DATABASE_URL を伏せてからログに出す（設計メモ リスク2）
export async function runScheduled(env: Bindings, now: Date): Promise<void> {
	try {
		const created = await generateSeminarDays(createDb(env.DATABASE_URL), now);
		console.log(
			`開催日を作成しました: ${created.length > 0 ? created.join(", ") : "なし"}`,
		);
	} catch (error) {
		console.error(maskSecrets(formatLogValue(error), env.DATABASE_URL));
		// 投げ直すのは、Cloudflare の Cron の履歴に失敗と残すため。
		// 元のエラーをそのまま投げたり cause に持たせたりすると、Workers のログに伏せていない文が出るため、中身を含まない Error にする
		throw new Error("開催日の生成に失敗しました");
	}
}
