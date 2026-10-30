import { eq, inArray, notExists, type SQL, sql } from "drizzle-orm";
import { FRIDAY, tokyoDate, utcMidnight } from "../../shared/date";
import {
	SCHEDULE_TEMPLATE,
	type ScheduleTemplateSlot,
	type SlotKind,
} from "../../shared/schedule-template";
import type { Db } from "../db/client";
import { createId } from "../db/id";
import { reservations, seminarDays, slots } from "../db/schema";
import { isNotStarted } from "./reservation";

// 日本時間の今日以降の金曜（今日が金曜なら今日を含む）を何回分用意しておくか
const GENERATE_WEEKS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

// 日本時間の今日以降で一番近い金曜（今日が金曜なら今日）から、count 回分の日付を返す
export function upcomingFridays(now: Date, count: number): string[] {
	// 日本時間の日付を UTC の 0:00 として持ち、以降は UTC の値だけで曜日と日付を計算する
	const today = utcMidnight(tokyoDate(now));
	const daysUntilFriday = (FRIDAY - today.getUTCDay() + 7) % 7;

	return Array.from({ length: count }, (_, week) =>
		new Date(today.getTime() + (daysUntilFriday + week * 7) * DAY_MS)
			.toISOString()
			.slice(0, 10),
	);
}

type SlotRow = ScheduleTemplateSlot & {
	id: string;
	// 入れる先の開催日。行ごとに決まっていないとき（再開する日に入れるとき）は null にし、on の条件で開催日を決める
	seminarDayId: string | null;
};

// rows の枠を、on の条件で結合した開催日に入れる INSERT。開催日の id は、結合した seminarDays から取る。
// 開催日の行を同じ batch の中で作る（id を先に知れない）ときにも使えるよう、開催日は値ではなく結合の条件で決める
function insertSlotsIntoDays(db: Db, rows: SlotRow[], on: SQL) {
	// SQL の文字列ではなく select のビルダーで渡す。Drizzle が「キーの名前と順番が slots の列と同じか」を確かめ、
	// ずれていれば例外を投げる（SQL の文字列だと列は順番だけで対応し、schema.ts を並べ替えると値が入れ違う）
	return db.insert(slots).select((qb) =>
		qb
			.select({
				id: sql<string>`v.id`.as("id"),
				seminarDayId: seminarDays.id,
				period: sql<number>`v.period`.as("period"),
				startTime: sql<string>`v."startTime"`.as("startTime"),
				endTime: sql<string>`v."endTime"`.as("endTime"),
				kind: sql<SlotKind>`v.kind`.as("kind"),
			})
			// 列の型は jsonb_to_recordset で1か所にまとめて指定する（値を1つずつ型変換しなくて済むように）。
			// 型は schema.ts の slots に合わせる
			.from(
				sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as v(
					id text, "seminarDayId" text, period smallint, "startTime" time, "endTime" time, kind "slotKind"
				)`,
			)
			.innerJoin(seminarDays, on),
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
		insertSlotsIntoDays(
			db,
			slotRows,
			eq(seminarDays.id, sql`v."seminarDayId"`),
		),
	]);

	// RETURNING の順番は決まっていないため、日付の順にそろえる
	return createdDays.map((day) => day.date).sort();
}

export type SeminarDayStatusInput =
	| { status: "closed"; closedReason: string | null }
	| { status: "open"; closedReason: null };

export type UpdateSeminarDayStatusResult =
	| {
			ok: true;
			day: {
				date: string;
				status: "open" | "closed";
				closedReason: string | null;
			};
			// 休止で消した予約の件数（再開では 0）
			deletedReservationCount: number;
	  }
	| { ok: false; reason: "SEMINAR_DAY_PAST" };

// 管理者が開催日を休止・再開する。行が無い日（Cron がまだ作っていない先の日）は、その状態で行を作る。
// - 休止：理由を入れ、その日の開始前の枠の予約を消す（枠は残し、再開したときにそのまま使う）
// - 再開：理由を消し、枠が1つも無い日だけ時間割の枠を作る
export async function updateSeminarDayStatus(
	db: Db,
	{
		date,
		input,
		now,
	}: { date: string; input: SeminarDayStatusInput; now: Date },
): Promise<UpdateSeminarDayStatusResult> {
	// 過去の記録を書き換えないため、今日より前の日は変えない（2026-10-30, Issue #11 で決定）。例えば、
	// - 実施した日を休止すると、「済」の予約と発表回数が残ったまま「休講」と表示され、記録が食い違う
	// - 再開すると、枠の無い過去の日に時間割の枠を作ってしまう
	// 過去の日はどの枠も開始済みのため、休止しても予約は消えない（下の DELETE は開始前の枠だけを対象にする）。
	// 引数の値どうしを比べるだけで DB は見ないため、確かめてから書き込むまでの間に結果が変わることはない
	if (date < tokyoDate(now)) {
		return { ok: false, reason: "SEMINAR_DAY_PAST" };
	}

	// 行が無ければ作り、あれば状態と理由を上書きする（Cron と同じく date の UNIQUE を使う）。
	// 行を更新するときに行ロックが掛かり、予約の INSERT（services/reservation.ts の FOR SHARE）はこの batch の終わりを待つ
	const upsertDay = db
		.insert(seminarDays)
		.values({ id: createId(), date, ...input })
		.onConflictDoUpdate({ target: seminarDays.date, set: input })
		.returning({
			date: seminarDays.date,
			status: seminarDays.status,
			closedReason: seminarDays.closedReason,
		});

	// 開催日の更新と予約の削除・枠の作成は batch で送り、両方成功するか両方失敗するかのどちらかにする（設計メモ リスク1）
	if (input.status === "closed") {
		const [days, deleted] = await db.batch([
			upsertDay,
			// 今日を休止するとき、開始時刻を過ぎた枠の予約は発表済みでもまだ reserved のまま（「済」にするのは翌日の Cron）で、
			// 消すと発表回数が減るため残す（2026-10-30, Issue #11 のレビューで決定）
			db
				.delete(reservations)
				.where(
					inArray(
						reservations.slotId,
						db
							.select({ id: slots.id })
							.from(slots)
							.innerJoin(seminarDays, eq(seminarDays.id, slots.seminarDayId))
							.where(
								sql`${eq(seminarDays.date, date)} and ${isNotStarted(now)}`,
							),
					),
				)
				.returning({ id: reservations.id }),
		]);
		return {
			ok: true,
			day: firstDay(days),
			deletedReservationCount: deleted.length,
		};
	}

	const slotRows = SCHEDULE_TEMPLATE.map((slot) => ({
		id: createId(),
		seminarDayId: null,
		...slot,
	}));
	const [days] = await db.batch([
		upsertDay,
		// 枠が1つでもある日には足さない（管理者が編集した枠と、時間割の元の枠が両方残らないように）。
		// 2人が同時に再開して両方が「枠が無い」と見ても、2回目の分は UNIQUE(seminarDayId, startTime) にぶつかって入らない。
		// and() は条件が無いと undefined を返す型のため、2つの条件を直接つなぐ（routes/announcements.ts と同じ）
		insertSlotsIntoDays(
			db,
			slotRows,
			sql`${eq(seminarDays.date, date)} and ${notExists(
				db
					.select({ id: slots.id })
					.from(slots)
					.where(eq(slots.seminarDayId, seminarDays.id)),
			)}`,
		).onConflictDoNothing(),
	]);
	return { ok: true, day: firstDay(days), deletedReservationCount: 0 };
}

// upsert は必ず1行を返すが、配列の要素は型の上では undefined がありうる（noUncheckedIndexedAccess）ため、ここで確かめる
function firstDay<Day>(days: Day[]): Day {
	const day = days[0];
	if (!day) {
		throw new Error("開催日の更新結果がありません");
	}
	return day;
}
