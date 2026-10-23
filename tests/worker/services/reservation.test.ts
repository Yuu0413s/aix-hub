import { beforeEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import type { SlotKind } from "../../../src/shared/schedule-template";
import { reservations } from "../../../src/worker/db/schema";
import {
	cancelReservation,
	createReservation,
	markPastReservationsDone,
} from "../../../src/worker/services/reservation";
import { useTestUsers } from "../../helpers/sign-in";
import { idAt, testData } from "../../helpers/test-data";
import { deleteSeminarDaysBetween } from "../../helpers/test-db";

// 予約・取消のテストで使う期間（毎回この期間だけを片付ける）。ほかのテストが使っていない 2034 年にする
const TEST_RANGE = ["2034-03-01", "2034-03-31"] as const;
// insertDay で作る枠は 13:00 開始から 10 分ずつ。時刻は日本時間（+09:00）で書き、UTC との違いが分かるようにする
const DAY = "2034-03-03";
const BEFORE_START = new Date("2034-03-03T12:59:00+09:00");
const AT_START = new Date("2034-03-03T13:00:00+09:00");
const NEXT_DAY = new Date("2034-03-04T09:00:00+09:00");

describe("createReservation（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const { insertDay, insertUser, insertReservation, findReservationsBySlot } =
		testData(testUsers);

	beforeEach(async () => {
		await deleteSeminarDaysBetween(testUsers.db(), TEST_RANGE);
	});

	test("空いている presentation の枠を予約でき、状態は reserved になる", async () => {
		const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
		const slotId = idAt(slotIds, 0);
		const userId = await insertUser("Shibata", "B3");

		const result = await createReservation(testUsers.db(), {
			slotId,
			userId,
			now: BEFORE_START,
		});

		expect(result).toEqual({
			ok: true,
			reservation: { id: expect.any(String), slotId, status: "reserved" },
		});
		expect(await findReservationsBySlot(slotId)).toEqual([
			{ userId, status: "reserved" },
		]);
	});

	test("予約済みの枠は SLOT_TAKEN を返し、予約は元のまま", async () => {
		const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
		const slotId = idAt(slotIds, 0);
		const firstUserId = await insertUser("Shibata", "B3");
		const secondUserId = await insertUser("Mori", "B3");
		await insertReservation(slotId, firstUserId);

		const result = await createReservation(testUsers.db(), {
			slotId,
			userId: secondUserId,
			now: BEFORE_START,
		});

		expect(result).toEqual({ ok: false, reason: "SLOT_TAKEN" });
		expect(await findReservationsBySlot(slotId)).toEqual([
			{ userId: firstUserId, status: "reserved" },
		]);
	});

	test("done の予約がある枠も SLOT_TAKEN を返す", async () => {
		const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
		const slotId = idAt(slotIds, 0);
		await insertReservation(slotId, await insertUser("Shibata", "B3"), "done");

		const result = await createReservation(testUsers.db(), {
			slotId,
			userId: await insertUser("Mori", "B3"),
			now: BEFORE_START,
		});

		expect(result).toEqual({ ok: false, reason: "SLOT_TAKEN" });
	});

	// 予約があっても、受け付けていない枠であることを理由にする（「済」になった過去の枠など）
	test("開始時刻を過ぎた予約済みの枠は SLOT_NOT_RESERVABLE を返す", async () => {
		const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
		const slotId = idAt(slotIds, 0);
		await insertReservation(slotId, await insertUser("Shibata", "B3"));

		const result = await createReservation(testUsers.db(), {
			slotId,
			userId: await insertUser("Mori", "B3"),
			now: AT_START,
		});

		expect(result).toEqual({ ok: false, reason: "SLOT_NOT_RESERVABLE" });
	});

	test("存在しない枠は SLOT_NOT_FOUND を返す", async () => {
		const result = await createReservation(testUsers.db(), {
			slotId: "no-such-slot",
			userId: await insertUser("Shibata", "B3"),
			now: BEFORE_START,
		});

		expect(result).toEqual({ ok: false, reason: "SLOT_NOT_FOUND" });
	});

	test.each<SlotKind>(["break", "teacher_share", "unavailable"])(
		"%s の枠は SLOT_NOT_RESERVABLE を返し、予約は作られない",
		async (kind) => {
			const slotIds = await insertDay(DAY, { kinds: [kind] });
			const slotId = idAt(slotIds, 0);

			const result = await createReservation(testUsers.db(), {
				slotId,
				userId: await insertUser("Shibata", "B3"),
				now: BEFORE_START,
			});

			expect(result).toEqual({ ok: false, reason: "SLOT_NOT_RESERVABLE" });
			expect(await findReservationsBySlot(slotId)).toEqual([]);
		},
	);

	test("休止日の枠は SLOT_NOT_RESERVABLE を返す", async () => {
		const slotIds = await insertDay(DAY, {
			status: "closed",
			closedReason: "大学祭",
			kinds: ["presentation"],
		});

		const result = await createReservation(testUsers.db(), {
			slotId: idAt(slotIds, 0),
			userId: await insertUser("Shibata", "B3"),
			now: BEFORE_START,
		});

		expect(result).toEqual({ ok: false, reason: "SLOT_NOT_RESERVABLE" });
	});

	// 開始時刻は日本時間で比べる。UTC として比べると 13:00 は日本時間の 22:00 になり、13:00 ちょうどでも予約できてしまう
	test("開始時刻ちょうど（日本時間 13:00）からは SLOT_NOT_RESERVABLE を返す", async () => {
		const slotIds = await insertDay(DAY, { kinds: ["presentation"] });

		const result = await createReservation(testUsers.db(), {
			slotId: idAt(slotIds, 0),
			userId: await insertUser("Shibata", "B3"),
			now: AT_START,
		});

		expect(result).toEqual({ ok: false, reason: "SLOT_NOT_RESERVABLE" });
	});

	test("当日でも、開始時刻より後の枠は予約できる", async () => {
		// 13:00 開始と 13:10 開始の枠。13:00 の時点で、13:10 開始の枠は予約できる
		const slotIds = await insertDay(DAY, {
			kinds: ["presentation", "presentation"],
		});

		const result = await createReservation(testUsers.db(), {
			slotId: idAt(slotIds, 1),
			userId: await insertUser("Shibata", "B3"),
			now: AT_START,
		});

		expect(result).toMatchObject({ ok: true });
	});

	test("開催日の翌日は SLOT_NOT_RESERVABLE を返す", async () => {
		const slotIds = await insertDay(DAY, { kinds: ["presentation"] });

		const result = await createReservation(testUsers.db(), {
			slotId: idAt(slotIds, 0),
			userId: await insertUser("Shibata", "B3"),
			now: NEXT_DAY,
		});

		expect(result).toEqual({ ok: false, reason: "SLOT_NOT_RESERVABLE" });
	});
});

describe("cancelReservation（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const { insertUser, insertReservedSlot, isReservationExisting } =
		testData(testUsers);

	beforeEach(async () => {
		await deleteSeminarDaysBetween(testUsers.db(), TEST_RANGE);
	});

	test("本人は、開始前の reserved の予約を取り消せ、行が消える", async () => {
		const ownerId = await insertUser("Shibata", "B3");
		const reservationId = await insertReservedSlot(DAY, ownerId);

		const result = await cancelReservation(testUsers.db(), {
			reservationId,
			actor: { id: ownerId, role: "student" },
			now: BEFORE_START,
		});

		expect(result).toEqual({ ok: true });
		expect(await isReservationExisting(reservationId)).toBe(false);
	});

	test("本人でも、開始時刻を過ぎた予約は RESERVATION_NOT_CANCELABLE を返し、行は残る", async () => {
		const ownerId = await insertUser("Shibata", "B3");
		const reservationId = await insertReservedSlot(DAY, ownerId);

		const result = await cancelReservation(testUsers.db(), {
			reservationId,
			actor: { id: ownerId, role: "student" },
			now: AT_START,
		});

		expect(result).toEqual({
			ok: false,
			reason: "RESERVATION_NOT_CANCELABLE",
		});
		expect(await isReservationExisting(reservationId)).toBe(true);
	});

	test("本人でも、done の予約は RESERVATION_NOT_CANCELABLE を返し、行は残る", async () => {
		const ownerId = await insertUser("Shibata", "B3");
		const reservationId = await insertReservedSlot(DAY, ownerId, "done");

		const result = await cancelReservation(testUsers.db(), {
			reservationId,
			actor: { id: ownerId, role: "student" },
			now: BEFORE_START,
		});

		expect(result).toEqual({
			ok: false,
			reason: "RESERVATION_NOT_CANCELABLE",
		});
		expect(await isReservationExisting(reservationId)).toBe(true);
	});

	test.each([
		["開始前の reserved", "reserved", BEFORE_START],
		["開始後の reserved", "reserved", NEXT_DAY],
		["done", "done", NEXT_DAY],
	] as const)(
		"admin は、他人の%sの予約を取り消せる",
		async (_, status, now) => {
			const ownerId = await insertUser("Shibata", "B3");
			const adminId = await insertUser("管理者", "M1", "admin");
			const reservationId = await insertReservedSlot(DAY, ownerId, status);

			const result = await cancelReservation(testUsers.db(), {
				reservationId,
				actor: { id: adminId, role: "admin" },
				now,
			});

			expect(result).toEqual({ ok: true });
			expect(await isReservationExisting(reservationId)).toBe(false);
		},
	);

	// 本人の予約でも、admin は本人向けの制限（開始後・done は取り消せない）を受けない
	test("admin は、自分の done の予約も取り消せる", async () => {
		const adminId = await insertUser("管理者", "M1", "admin");
		const reservationId = await insertReservedSlot(DAY, adminId, "done");

		const result = await cancelReservation(testUsers.db(), {
			reservationId,
			actor: { id: adminId, role: "admin" },
			now: NEXT_DAY,
		});

		expect(result).toEqual({ ok: true });
		expect(await isReservationExisting(reservationId)).toBe(false);
	});

	test.each(["student", "teacher"] as const)(
		"%s が他人の予約を取り消すと FORBIDDEN を返し、行は残る",
		async (role) => {
			const ownerId = await insertUser("Shibata", "B3");
			const otherId = await insertUser(
				"他人",
				role === "teacher" ? null : "B3",
				role,
			);
			const reservationId = await insertReservedSlot(DAY, ownerId);

			const result = await cancelReservation(testUsers.db(), {
				reservationId,
				actor: { id: otherId, role },
				now: BEFORE_START,
			});

			expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
			expect(await isReservationExisting(reservationId)).toBe(true);
		},
	);

	test("存在しない予約は RESERVATION_NOT_FOUND を返す", async () => {
		const result = await cancelReservation(testUsers.db(), {
			reservationId: "no-such-reservation",
			actor: { id: await insertUser("Shibata", "B3"), role: "admin" },
			now: BEFORE_START,
		});

		expect(result).toEqual({ ok: false, reason: "RESERVATION_NOT_FOUND" });
	});
});

// 「済」への更新は、今日より前のすべての開催日の予約に効く。テスト用 DB を共有しているほかのテストの予約まで
// 書き換えないよう、どのテストも使わない 2001 年の日付と、その時点の now を使う
const DONE_RANGE = ["2001-01-01", "2001-01-31"] as const;
// 本番の Cron と同じ、日本時間 0:05 に実行した場合
const CRON_NOW = new Date("2001-01-06T00:05:00+09:00");

describe("markPastReservationsDone（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const { insertDay, insertUser, insertReservation } = testData(testUsers);

	beforeEach(async () => {
		await deleteSeminarDaysBetween(testUsers.db(), DONE_RANGE);
	});

	async function statusesOf(reservationIds: string[]) {
		const rows = await testUsers
			.db()
			.select({ id: reservations.id, status: reservations.status })
			.from(reservations)
			.where(inArray(reservations.id, reservationIds));
		const statusById = new Map(rows.map((row) => [row.id, row.status]));
		return reservationIds.map((id) => statusById.get(id));
	}

	// 前日・当日・翌日に1件ずつ予約を入れ、予約の id をこの順で返す
	async function insertReservationsAroundToday() {
		const userId = await insertUser("Shibata", "B3");
		const ids: string[] = [];
		for (const date of ["2001-01-05", "2001-01-06", "2001-01-07"]) {
			const slotIds = await insertDay(date, { kinds: ["presentation"] });
			ids.push(await insertReservation(idAt(slotIds, 0), userId));
		}
		return ids;
	}

	// UTC ではまだ 1/5 の 15:05 だが、日本時間では 1/6 なので、1/5 の予約を done にする
	test("開催日が今日（日本時間）より前の reserved だけを done にし、件数を返す", async () => {
		const ids = await insertReservationsAroundToday();
		expect(CRON_NOW.toISOString().slice(0, 10)).toBe("2001-01-05");

		const count = await markPastReservationsDone(testUsers.db(), CRON_NOW);

		expect(count).toBe(1);
		expect(await statusesOf(ids)).toEqual(["done", "reserved", "reserved"]);
	});

	test("2回実行しても結果が同じで、2回目の件数は 0", async () => {
		const ids = await insertReservationsAroundToday();

		await markPastReservationsDone(testUsers.db(), CRON_NOW);
		const secondCount = await markPastReservationsDone(
			testUsers.db(),
			CRON_NOW,
		);

		expect(secondCount).toBe(0);
		expect(await statusesOf(ids)).toEqual(["done", "reserved", "reserved"]);
	});
});
