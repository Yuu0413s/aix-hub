import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, asc, between, eq } from "drizzle-orm";
import { SCHEDULE_TEMPLATE } from "../../../src/shared/schedule-template";
import type { Db } from "../../../src/worker/db/client";
import { createId } from "../../../src/worker/db/id";
import { seminarDays, slots } from "../../../src/worker/db/schema";
import {
	generateSeminarDays,
	upcomingFridays,
} from "../../../src/worker/services/seminar-day";
import { deleteSeminarDaysBetween, setUpTestDb } from "../../helpers/test-db";

// 2030-01-01 は火曜。日本時間（+09:00）の時刻で書き、UTC との違いが分かるようにする
describe("upcomingFridays", () => {
	test("水曜なら、その週の金曜から4回分を返す", () => {
		expect(upcomingFridays(new Date("2030-01-02T12:00:00+09:00"), 4)).toEqual([
			"2030-01-04",
			"2030-01-11",
			"2030-01-18",
			"2030-01-25",
		]);
	});

	test("UTC では木曜 15:00 でも、日本時間で金曜 0:00 なら今日を含める", () => {
		const now = new Date("2030-01-03T15:00:00Z");
		expect(now.getUTCDay()).toBe(4);

		expect(upcomingFridays(now, 4)).toEqual([
			"2030-01-04",
			"2030-01-11",
			"2030-01-18",
			"2030-01-25",
		]);
	});

	test("日本時間で金曜 23:59 なら、まだ今日を含める", () => {
		expect(upcomingFridays(new Date("2030-01-04T23:59:59+09:00"), 4)).toEqual([
			"2030-01-04",
			"2030-01-11",
			"2030-01-18",
			"2030-01-25",
		]);
	});

	test("UTC ではまだ金曜でも、日本時間で土曜 0:00 なら翌週の金曜から", () => {
		const now = new Date("2030-01-04T15:00:00Z");
		expect(now.getUTCDay()).toBe(5);

		expect(upcomingFridays(now, 4)).toEqual([
			"2030-01-11",
			"2030-01-18",
			"2030-01-25",
			"2030-02-01",
		]);
	});

	test("月と年をまたいでも日付が正しい", () => {
		expect(upcomingFridays(new Date("2030-12-25T12:00:00+09:00"), 4)).toEqual([
			"2030-12-27",
			"2031-01-03",
			"2031-01-10",
			"2031-01-17",
		]);
	});
});

// テスト用 DB は共有されているため、ほかのデータを消さないよう、テストで使う期間だけを片付ける
const TEST_RANGE = ["2030-01-01", "2030-02-28"] as const;
const WEDNESDAY = new Date("2030-01-02T12:00:00+09:00");
const FRIDAYS = ["2030-01-04", "2030-01-11", "2030-01-18", "2030-01-25"];

// DB の time 型は秒まで付けて返す（13:10 → 13:10:00）
const EXPECTED_SLOTS = SCHEDULE_TEMPLATE.map((slot) => ({
	period: slot.period,
	startTime: `${slot.startTime}:00`,
	endTime: `${slot.endTime}:00`,
	kind: slot.kind,
}));

describe("generateSeminarDays（テスト用 DB）", () => {
	let db: Db;

	beforeAll(async () => {
		db = await setUpTestDb();
	});

	beforeEach(async () => {
		await deleteSeminarDaysBetween(db, TEST_RANGE);
	});

	async function findDays() {
		return db
			.select()
			.from(seminarDays)
			.where(between(seminarDays.date, ...TEST_RANGE))
			.orderBy(asc(seminarDays.date));
	}

	async function findSlots(date: string) {
		return db
			.select({
				period: slots.period,
				startTime: slots.startTime,
				endTime: slots.endTime,
				kind: slots.kind,
			})
			.from(slots)
			.innerJoin(seminarDays, eq(slots.seminarDayId, seminarDays.id))
			.where(eq(seminarDays.date, date))
			.orderBy(asc(slots.startTime));
	}

	test("4回分の金曜を open で作り、各日に時間割どおりの枠を作る", async () => {
		const created = await generateSeminarDays(db, WEDNESDAY);

		expect(created).toEqual(FRIDAYS);
		const days = await findDays();
		expect(days.map((day) => day.date)).toEqual(FRIDAYS);
		for (const day of days) {
			expect(day.status).toBe("open");
			expect(day.closedReason).toBeNull();
			expect(await findSlots(day.date)).toEqual(EXPECTED_SLOTS);
		}
	});

	test("2回実行しても、開催日も枠も増えない", async () => {
		await generateSeminarDays(db, WEDNESDAY);
		const created = await generateSeminarDays(db, WEDNESDAY);

		expect(created).toEqual([]);
		const days = await findDays();
		expect(days.map((day) => day.date)).toEqual(FRIDAYS);
		for (const day of days) {
			expect(await findSlots(day.date)).toEqual(EXPECTED_SLOTS);
		}
	});

	test("すでに closed の日は上書きせず、枠も作らない。ほかの日は作る", async () => {
		await db.insert(seminarDays).values({
			id: createId(),
			date: "2030-01-11",
			status: "closed",
			closedReason: "大学祭",
		});

		const created = await generateSeminarDays(db, WEDNESDAY);

		expect(created).toEqual(["2030-01-04", "2030-01-18", "2030-01-25"]);
		const closedDay = (await findDays()).find(
			(day) => day.date === "2030-01-11",
		);
		expect(closedDay).toMatchObject({
			status: "closed",
			closedReason: "大学祭",
		});
		expect(await findSlots("2030-01-11")).toEqual([]);
		expect(await findSlots("2030-01-04")).toEqual(EXPECTED_SLOTS);
	});

	test("すでにある日の枠を変えていても、時間割の枠を足し直さない", async () => {
		await generateSeminarDays(db, WEDNESDAY);
		const [day] = await db
			.select({ id: seminarDays.id })
			.from(seminarDays)
			.where(eq(seminarDays.date, "2030-01-04"));
		if (!day) {
			throw new Error("2030-01-04 の開催日が作られていません");
		}
		// 管理者が 13:30 の枠を 13:35 に動かした状態にする
		await db
			.update(slots)
			.set({ startTime: "13:35" })
			.where(and(eq(slots.seminarDayId, day.id), eq(slots.startTime, "13:30")));

		await generateSeminarDays(db, WEDNESDAY);

		const startTimes = (await findSlots("2030-01-04")).map(
			(slot) => slot.startTime,
		);
		expect(startTimes).toHaveLength(SCHEDULE_TEMPLATE.length);
		expect(startTimes).toContain("13:35:00");
		expect(startTimes).not.toContain("13:30:00");
	});

	test("1週間後に実行すると、新しい金曜の1日だけが増える", async () => {
		await generateSeminarDays(db, WEDNESDAY);

		const created = await generateSeminarDays(
			db,
			new Date("2030-01-09T12:00:00+09:00"),
		);

		expect(created).toEqual(["2030-02-01"]);
		expect((await findDays()).map((day) => day.date)).toEqual([
			...FRIDAYS,
			"2030-02-01",
		]);
		expect(await findSlots("2030-02-01")).toEqual(EXPECTED_SLOTS);
	});
});
