import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, asc, between, eq, inArray } from "drizzle-orm";
import { SCHEDULE_TEMPLATE } from "../../../src/shared/schedule-template";
import type { Db } from "../../../src/worker/db/client";
import { createId } from "../../../src/worker/db/id";
import {
	reservations,
	seminarDays,
	slots,
} from "../../../src/worker/db/schema";
import {
	generateSeminarDays,
	upcomingFridays,
	updateSeminarDayStatus,
} from "../../../src/worker/services/seminar-day";
import { useTestUsers } from "../../helpers/sign-in";
import { idAt, testData } from "../../helpers/test-data";
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

// テストで使う期間（毎回この期間だけを片付ける）
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

// 休止・再開のテストで使う期間。ほかのテストが使っていない 2038 年にする。
// Cron を動かすテストが4週先（4月）まで作るため、4月も片付ける。
// 2038-03-05・03-12・03-19 は金曜。現在時刻は日本時間（+09:00）で書き、UTC との違いが分かるようにする
const STATUS_TEST_RANGE = ["2038-03-01", "2038-04-30"] as const;
const DAY = "2038-03-12";
const OTHER_DAY = "2038-03-19";
const PREVIOUS_DAY = "2038-03-05";
// DAY の前の水曜。DAY も OTHER_DAY も今日より後
const BEFORE_DAY = new Date("2038-03-10T12:00:00+09:00");

describe("updateSeminarDayStatus（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const { insertDay, insertDayWithSlots, insertUser, insertReservation } =
		testData(testUsers);

	beforeEach(async () => {
		await deleteSeminarDaysBetween(testUsers.db(), STATUS_TEST_RANGE);
	});

	async function findDay(date: string) {
		const [day] = await testUsers
			.db()
			.select({
				date: seminarDays.date,
				status: seminarDays.status,
				closedReason: seminarDays.closedReason,
			})
			.from(seminarDays)
			.where(eq(seminarDays.date, date));
		return day;
	}

	async function findSlots(date: string) {
		return testUsers
			.db()
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

	function close(date: string, closedReason: string | null, now = BEFORE_DAY) {
		return updateSeminarDayStatus(testUsers.db(), {
			date,
			input: { status: "closed", closedReason },
			now,
		});
	}

	function reopen(date: string, now = BEFORE_DAY) {
		return updateSeminarDayStatus(testUsers.db(), {
			date,
			input: { status: "open", closedReason: null },
			now,
		});
	}

	describe("休止", () => {
		test("行が無い日を休止すると、理由付きの closed の行を作り、枠は作らない", async () => {
			const result = await close(DAY, "大学祭");

			expect(result).toEqual({
				ok: true,
				day: { date: DAY, status: "closed", closedReason: "大学祭" },
				deletedReservationCount: 0,
			});
			expect(await findDay(DAY)).toEqual({
				date: DAY,
				status: "closed",
				closedReason: "大学祭",
			});
			expect(await findSlots(DAY)).toEqual([]);
		});

		test("行が無い日を休止したあとに Cron が動いても、closed のままで枠も作らない", async () => {
			await close(DAY, "大学祭");

			// DAY を含む4回分の金曜を作る時刻
			const created = await generateSeminarDays(testUsers.db(), BEFORE_DAY);

			expect(created).not.toContain(DAY);
			expect(created).toContain(OTHER_DAY);
			expect(await findDay(DAY)).toEqual({
				date: DAY,
				status: "closed",
				closedReason: "大学祭",
			});
			expect(await findSlots(DAY)).toEqual([]);
		});

		test("開催中の日を休止すると、その日の予約をすべて消し、消した件数を返す", async () => {
			const slotIds = await insertDay(DAY, {
				kinds: ["presentation", "presentation", "presentation"],
			});
			const userId = await insertUser("Shibata", "B3");
			await insertReservation(idAt(slotIds, 0), userId);
			await insertReservation(idAt(slotIds, 1), userId);

			const result = await close(DAY, "先生出張のため休講");

			expect(result).toEqual({
				ok: true,
				day: {
					date: DAY,
					status: "closed",
					closedReason: "先生出張のため休講",
				},
				deletedReservationCount: 2,
			});
			const remaining = await testUsers
				.db()
				.select({ id: reservations.id })
				.from(reservations)
				.where(inArray(reservations.slotId, slotIds));
			expect(remaining).toEqual([]);
			// 枠は消さない（再開したときにそのまま使えるように）
			expect(await findSlots(DAY)).toHaveLength(3);
		});

		test("ほかの日の予約は消さない", async () => {
			const daySlotIds = await insertDay(DAY, { kinds: ["presentation"] });
			const otherSlotIds = await insertDay(OTHER_DAY, {
				kinds: ["presentation"],
			});
			const userId = await insertUser("Shibata", "B3");
			await insertReservation(idAt(daySlotIds, 0), userId);
			const otherReservationId = await insertReservation(
				idAt(otherSlotIds, 0),
				userId,
			);

			await close(DAY, null);

			const remaining = await testUsers
				.db()
				.select({ id: reservations.id })
				.from(reservations)
				.where(inArray(reservations.slotId, [...daySlotIds, ...otherSlotIds]));
			expect(remaining).toEqual([{ id: otherReservationId }]);
		});

		test("理由が null なら、理由なしで休止する", async () => {
			await insertDay(DAY);

			const result = await close(DAY, null);

			expect(result).toMatchObject({
				ok: true,
				day: { date: DAY, status: "closed", closedReason: null },
			});
			expect(await findDay(DAY)).toMatchObject({
				status: "closed",
				closedReason: null,
			});
		});

		test("休止中の日をもう一度休止すると、理由だけを変える", async () => {
			await insertDay(DAY, {
				kinds: ["presentation"],
				status: "closed",
				closedReason: "大学祭",
			});

			const result = await close(DAY, "入試のため休講");

			expect(result).toEqual({
				ok: true,
				day: { date: DAY, status: "closed", closedReason: "入試のため休講" },
				deletedReservationCount: 0,
			});
			expect(await findSlots(DAY)).toHaveLength(1);
		});
	});

	describe("再開", () => {
		test("枠のある休止中の日を再開すると、open にして理由を消し、枠は足さない", async () => {
			await insertDay(DAY, {
				kinds: ["presentation", "break"],
				status: "closed",
				closedReason: "大学祭",
			});

			const result = await reopen(DAY);

			expect(result).toEqual({
				ok: true,
				day: { date: DAY, status: "open", closedReason: null },
				deletedReservationCount: 0,
			});
			expect(await findDay(DAY)).toEqual({
				date: DAY,
				status: "open",
				closedReason: null,
			});
			expect(await findSlots(DAY)).toHaveLength(2);
		});

		test("枠の無い休止中の日を再開すると、時間割どおりの枠を作る", async () => {
			await insertDay(DAY, { status: "closed", closedReason: "大学祭" });

			await reopen(DAY);

			expect(await findSlots(DAY)).toEqual(EXPECTED_SLOTS);
		});

		test("行が無い日を再開すると、open の行と時間割どおりの枠を作る", async () => {
			const result = await reopen(DAY);

			expect(result).toMatchObject({
				ok: true,
				day: { date: DAY, status: "open", closedReason: null },
			});
			expect(await findDay(DAY)).toEqual({
				date: DAY,
				status: "open",
				closedReason: null,
			});
			expect(await findSlots(DAY)).toEqual(EXPECTED_SLOTS);
		});

		test("開催中の日を再開しても、何も変わらない", async () => {
			await insertDayWithSlots(DAY, [
				{
					period: 3,
					startTime: "13:35",
					endTime: "13:55",
					kind: "presentation",
				},
			]);

			await reopen(DAY);

			expect(await findDay(DAY)).toMatchObject({ status: "open" });
			expect(await findSlots(DAY)).toEqual([
				{
					period: 3,
					startTime: "13:35:00",
					endTime: "13:55:00",
					kind: "presentation",
				},
			]);
		});

		test("ほかの日には枠を作らない", async () => {
			await insertDay(OTHER_DAY, { status: "closed" });

			await reopen(DAY);

			expect(await findSlots(OTHER_DAY)).toEqual([]);
		});
	});

	describe("日付の範囲", () => {
		test("今日（日本時間）の開催日は休止できる", async () => {
			await insertDay(DAY);

			const result = await close(
				DAY,
				null,
				new Date("2038-03-12T23:59:59+09:00"),
			);

			expect(result).toMatchObject({ ok: true });
			expect(await findDay(DAY)).toMatchObject({ status: "closed" });
		});

		test("UTC ではまだ前日でも、日本時間で今日なら休止できる", async () => {
			await insertDay(DAY);
			// 日本時間では 2038-03-12 0:00
			const now = new Date("2038-03-11T15:00:00Z");
			expect(now.getUTCDate()).toBe(11);

			const result = await close(DAY, null, now);

			expect(result).toMatchObject({ ok: true });
		});

		test("今日より前の日の休止は SEMINAR_DAY_PAST を返し、予約も開催日も変えない", async () => {
			const slotIds = await insertDay(PREVIOUS_DAY, {
				kinds: ["presentation"],
			});
			const userId = await insertUser("Shibata", "B3");
			await insertReservation(idAt(slotIds, 0), userId, "done");

			// 日本時間で PREVIOUS_DAY の翌日 0:00
			const result = await close(
				PREVIOUS_DAY,
				"大学祭",
				new Date("2038-03-06T00:00:00+09:00"),
			);

			expect(result).toEqual({ ok: false, reason: "SEMINAR_DAY_PAST" });
			expect(await findDay(PREVIOUS_DAY)).toEqual({
				date: PREVIOUS_DAY,
				status: "open",
				closedReason: null,
			});
			const remaining = await testUsers
				.db()
				.select({ id: reservations.id })
				.from(reservations)
				.where(inArray(reservations.slotId, slotIds));
			expect(remaining).toHaveLength(1);
		});

		test("今日より前の日の再開も SEMINAR_DAY_PAST を返し、行も枠も作らない", async () => {
			const result = await reopen(
				PREVIOUS_DAY,
				new Date("2038-03-06T00:00:00+09:00"),
			);

			expect(result).toEqual({ ok: false, reason: "SEMINAR_DAY_PAST" });
			expect(await findDay(PREVIOUS_DAY)).toBeUndefined();
			expect(await findSlots(PREVIOUS_DAY)).toEqual([]);
		});
	});
});
