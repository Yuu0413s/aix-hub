import { eq, sql } from "drizzle-orm";
import {
	SCHEDULE_TEMPLATE,
	type SlotKind,
} from "../../shared/schedule-template";
import type { Db } from "../db/client";
import { createId } from "../db/id";
import { seminarDays, slots } from "../db/schema";

// 今週の金曜から何回分を用意しておくか
const GENERATE_WEEKS = 4;
const FRIDAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const tokyoDateFormat = new Intl.DateTimeFormat("en-US", {
	timeZone: "Asia/Tokyo",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

// 日本時間の日付（YYYY-MM-DD）。Workers も Cron も UTC で動くため、日付は必ず日本時間で決める（設計メモ リスク6）。
// 並び順はロケールによって変わるため、format の文字列ではなく部品から組み立てる
function tokyoDate(now: Date): string {
	const parts = Object.fromEntries(
		tokyoDateFormat.formatToParts(now).map((part) => [part.type, part.value]),
	);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

// 日本時間の今日以降で一番近い金曜（今日が金曜なら今日）から、count 回分の日付を返す
export function upcomingFridays(now: Date, count: number): string[] {
	// 日本時間の日付を UTC の 0:00 として持ち、以降は UTC の値だけで曜日と日付を計算する。
	// 実行環境のタイムゾーンに左右されないようにするため
	const today = new Date(`${tokyoDate(now)}T00:00:00Z`);
	const daysUntilFriday = (FRIDAY - today.getUTCDay() + 7) % 7;

	return Array.from({ length: count }, (_, week) =>
		new Date(today.getTime() + (daysUntilFriday + week * 7) * DAY_MS)
			.toISOString()
			.slice(0, 10),
	);
}

// GENERATE_WEEKS 回分の金曜の開催日と、その枠を作る。作った日付を返す（すでにあった日は含まない）。
// 何度実行しても結果が同じになるよう、すでにある日（closed も含む）には触らない
export async function generateSeminarDays(
	db: Db,
	now: Date,
): Promise<string[]> {
	const days = upcomingFridays(now, GENERATE_WEEKS).map((date) => ({
		id: createId(),
		date,
	}));
	const slotRows = days.flatMap((day) =>
		SCHEDULE_TEMPLATE.map((slot) => ({
			id: createId(),
			seminarDayId: day.id,
			...slot,
		})),
	);

	// 開催日と枠を batch で1回で送る。batch は1つのトランザクションとして動くため、
	// - 2つ目の SQL からは、1つ目の SQL で入れた開催日が見える（inner join で照合できる）
	// - 途中で失敗すると全体が取り消され、枠の無い開催日が残らない
	// 枠は「今回作った id の開催日」があるときだけ入れる。すでにある日は id が違うため枠が入らない。
	// すでにある日の枠を足し直すと、管理者が時刻を変えた枠と元の時刻の枠が両方残るため
	const [createdDays] = await db.batch([
		db
			.insert(seminarDays)
			.values(days)
			.onConflictDoNothing({ target: seminarDays.date })
			.returning({ date: seminarDays.date }),
		// SQL の文字列ではなく select のビルダーで渡す。Drizzle が「キーの名前と順番が slots の列と同じか」を確かめ、
		// ずれていれば例外を投げる（SQL の文字列だと列は順番だけで対応し、schema.ts を並べ替えると値が入れ違う）
		db.insert(slots).select((qb) =>
			qb
				.select({
					id: sql<string>`v.id`.as("id"),
					seminarDayId: sql<string>`v."seminarDayId"`.as("seminarDayId"),
					period: sql<number>`v.period`.as("period"),
					startTime: sql<string>`v."startTime"`.as("startTime"),
					endTime: sql<string>`v."endTime"`.as("endTime"),
					kind: sql<SlotKind>`v.kind`.as("kind"),
				})
				// 列の型は jsonb_to_recordset で1か所にまとめて指定する（値を1つずつ型変換しなくて済むように）。
				// 型は schema.ts の slots に合わせる
				.from(
					sql`jsonb_to_recordset(${JSON.stringify(slotRows)}::jsonb) as v(
						id text, "seminarDayId" text, period smallint, "startTime" time, "endTime" time, kind "slotKind"
					)`,
				)
				.innerJoin(seminarDays, eq(seminarDays.id, sql`v."seminarDayId"`)),
		),
	]);

	// RETURNING の順番は決まっていないため、日付の順にそろえる
	return createdDays.map((day) => day.date).sort();
}
