import { createDb } from "./db/client";
import type { Bindings } from "./env";
import { formatLogValue, maskSecrets } from "./error-handler";
import { markPastReservationsDone } from "./services/reservation";
import { generateSeminarDays } from "./services/seminar-day";

// Cron Trigger（wrangler.jsonc の triggers.crons）で毎日動かす処理。
// scheduled のエラーは app.onError を通らないため、ここで DATABASE_URL を伏せてからログに出す（設計メモ リスク2）
export async function runScheduled(env: Bindings, now: Date): Promise<void> {
	const db = createDb(env.DATABASE_URL);
	const tasks = [
		{
			name: "開催日の作成",
			run: async () => {
				const created = await generateSeminarDays(db, now);
				console.log(
					`開催日を作成しました: ${created.length > 0 ? created.join(", ") : "なし"}`,
				);
			},
		},
		{
			name: "予約の「済」への更新",
			run: async () => {
				const count = await markPastReservationsDone(db, now);
				console.log(`予約を「済」にしました: ${count} 件`);
			},
		},
	];

	// 2つの処理は互いに関係が無いため、片方が失敗してももう片方は最後まで動かす
	const results = await Promise.allSettled(tasks.map((task) => task.run()));
	const failedNames: string[] = [];
	for (const [index, result] of results.entries()) {
		if (result.status === "rejected") {
			const name = tasks[index]?.name ?? "";
			failedNames.push(name);
			console.error(
				`${name}に失敗しました\n${maskSecrets(formatLogValue(result.reason), env.DATABASE_URL)}`,
			);
		}
	}

	if (failedNames.length > 0) {
		// 投げ直すのは、Cloudflare の Cron の履歴に失敗と残すため。
		// 元のエラーをそのまま投げたり cause に持たせたりすると、Workers のログに伏せていない文が出るため、中身を含まない Error にする
		throw new Error(`Cron の処理に失敗しました: ${failedNames.join("、")}`);
	}
}
