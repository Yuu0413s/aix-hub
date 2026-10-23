import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { reservations } from "../../../src/worker/db/schema";
import { app } from "../../../src/worker/index";
import { signInAsNewUser, testEnv, useTestUsers } from "../../helpers/sign-in";
import { idAt, testData } from "../../helpers/test-data";
import { deleteSeminarDaysBetween } from "../../helpers/test-db";

// API は実際の現在時刻で判定するため、まだ来ない日と、もう過ぎた日を使う。どちらもほかのテストが使っていない年にする
const FUTURE_RANGE = ["2033-03-01", "2033-03-31"] as const;
const FUTURE_DAY = "2033-03-04";
const PAST_RANGE = ["2021-03-01", "2021-03-31"] as const;
const PAST_DAY = "2021-03-05";

async function request(
	method: "POST" | "DELETE",
	path: string,
	cookie?: string,
) {
	return app.request(
		path,
		{ method, headers: cookie ? { cookie } : {} },
		testEnv(),
	);
}

function postReservation(slotId: string, cookie?: string) {
	return request("POST", `/api/slots/${slotId}/reservations`, cookie);
}

function deleteReservation(reservationId: string, cookie?: string) {
	return request("DELETE", `/api/reservations/${reservationId}`, cookie);
}

describe("予約・取消の API（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const { insertDay, insertUser, insertReservation, signInWithProfile } =
		testData(testUsers);

	beforeEach(async () => {
		await deleteSeminarDaysBetween(testUsers.db(), FUTURE_RANGE);
		await deleteSeminarDaysBetween(testUsers.db(), PAST_RANGE);
	});

	async function findReservationsBySlot(slotId: string) {
		return testUsers
			.db()
			.select({ userId: reservations.userId })
			.from(reservations)
			.where(eq(reservations.slotId, slotId));
	}

	async function existsReservation(reservationId: string) {
		const rows = await testUsers
			.db()
			.select({ id: reservations.id })
			.from(reservations)
			.where(eq(reservations.id, reservationId));
		return rows.length > 0;
	}

	async function insertFreeSlot() {
		return idAt(await insertDay(FUTURE_DAY, { kinds: ["presentation"] }), 0);
	}

	describe("POST /api/slots/:slotId/reservations", () => {
		test("未ログインなら 401 を返す", async () => {
			const slotId = await insertFreeSlot();

			const res = await postReservation(slotId);

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test("プロフィール未登録なら 403 と PROFILE_REQUIRED を返し、予約は作られない", async () => {
			const slotId = await insertFreeSlot();
			const cookie = await signInAsNewUser(testUsers.uniqueEmail());

			const res = await postReservation(slotId, cookie);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: { code: "PROFILE_REQUIRED" },
			});
			expect(await findReservationsBySlot(slotId)).toEqual([]);
		});

		test("teacher なら 403 と FORBIDDEN を返し、予約は作られない", async () => {
			const slotId = await insertFreeSlot();
			const { cookie } = await signInWithProfile("teacher");

			const res = await postReservation(slotId, cookie);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: { code: "FORBIDDEN" },
			});
			expect(await findReservationsBySlot(slotId)).toEqual([]);
		});

		test.each(["student", "admin"] as const)(
			"%s は空いている枠を予約でき、200 と予約を返す",
			async (role) => {
				const slotId = await insertFreeSlot();
				const { cookie, userId } = await signInWithProfile(role);

				const res = await postReservation(slotId, cookie);

				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({
					reservation: {
						id: expect.any(String),
						slotId,
						status: "reserved",
					},
				});
				expect(await findReservationsBySlot(slotId)).toEqual([{ userId }]);
			},
		);

		test("埋まっている枠なら 409 と SLOT_TAKEN を返す", async () => {
			const slotId = await insertFreeSlot();
			await insertReservation(slotId, await insertUser("Shibata", "B3"));
			const { cookie } = await signInWithProfile();

			const res = await postReservation(slotId, cookie);

			expect(res.status).toBe(409);
			expect(await res.json()).toEqual({
				error: { code: "SLOT_TAKEN", message: expect.any(String) },
			});
		});

		test.each([
			["presentation 以外の枠", FUTURE_DAY, "break", "open"],
			["休止日の枠", FUTURE_DAY, "presentation", "closed"],
			["開始時刻を過ぎた枠", PAST_DAY, "presentation", "open"],
		] as const)(
			"%sなら 409 と SLOT_NOT_RESERVABLE を返し、予約は作られない",
			async (_, date, kind, status) => {
				const slotId = idAt(
					await insertDay(date, { kinds: [kind], status }),
					0,
				);
				const { cookie } = await signInWithProfile();

				const res = await postReservation(slotId, cookie);

				expect(res.status).toBe(409);
				expect(await res.json()).toMatchObject({
					error: { code: "SLOT_NOT_RESERVABLE" },
				});
				expect(await findReservationsBySlot(slotId)).toEqual([]);
			},
		);

		test("存在しない枠なら 404 と SLOT_NOT_FOUND を返す", async () => {
			const { cookie } = await signInWithProfile();

			const res = await postReservation("no-such-slot", cookie);

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "SLOT_NOT_FOUND" },
			});
		});

		test("同じ枠に同時に2件の予約が来ても、成功するのは1件だけ", async () => {
			const slotId = await insertFreeSlot();
			const first = await signInWithProfile();
			const second = await signInWithProfile();

			const responses = await Promise.all([
				postReservation(slotId, first.cookie),
				postReservation(slotId, second.cookie),
			]);

			expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
			const rows = await findReservationsBySlot(slotId);
			expect(rows).toHaveLength(1);
			// 残った予約は、200 を受け取った人のもの
			const winner = responses[0]?.status === 200 ? first : second;
			expect(rows).toEqual([{ userId: winner.userId }]);
		});
	});

	describe("DELETE /api/reservations/:id", () => {
		async function insertReservationOf(
			userId: string,
			{
				date = FUTURE_DAY,
				status = "reserved",
			}: { date?: string; status?: "reserved" | "done" } = {},
		) {
			const slotId = idAt(
				await insertDay(date, { kinds: ["presentation"] }),
				0,
			);
			return insertReservation(slotId, userId, status);
		}

		test("未ログインなら 401 を返し、予約は残る", async () => {
			const reservationId = await insertReservationOf(
				await insertUser("Shibata", "B3"),
			);

			const res = await deleteReservation(reservationId);

			expect(res.status).toBe(401);
			expect(await existsReservation(reservationId)).toBe(true);
		});

		test("プロフィール未登録なら 403 と PROFILE_REQUIRED を返す", async () => {
			const reservationId = await insertReservationOf(
				await insertUser("Shibata", "B3"),
			);
			const cookie = await signInAsNewUser(testUsers.uniqueEmail());

			const res = await deleteReservation(reservationId, cookie);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: { code: "PROFILE_REQUIRED" },
			});
		});

		test("本人は取り消せ、200 と予約の id を返し、予約が消える", async () => {
			const { cookie, userId } = await signInWithProfile();
			const reservationId = await insertReservationOf(userId);

			const res = await deleteReservation(reservationId, cookie);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ id: reservationId });
			expect(await existsReservation(reservationId)).toBe(false);
		});

		test("admin は他人の予約を取り消せる", async () => {
			const { cookie } = await signInWithProfile("admin");
			const reservationId = await insertReservationOf(
				await insertUser("Shibata", "B3"),
			);

			const res = await deleteReservation(reservationId, cookie);

			expect(res.status).toBe(200);
			expect(await existsReservation(reservationId)).toBe(false);
		});

		test("他人の予約なら 403 と FORBIDDEN を返し、予約は残る", async () => {
			const { cookie } = await signInWithProfile();
			const reservationId = await insertReservationOf(
				await insertUser("Shibata", "B3"),
			);

			const res = await deleteReservation(reservationId, cookie);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: { code: "FORBIDDEN" },
			});
			expect(await existsReservation(reservationId)).toBe(true);
		});

		test.each([
			["done の予約", { status: "done" }],
			["開始時刻を過ぎた予約", { date: PAST_DAY }],
		] as const)(
			"本人でも%sなら 409 と RESERVATION_NOT_CANCELABLE を返し、予約は残る",
			async (_, options) => {
				const { cookie, userId } = await signInWithProfile();
				const reservationId = await insertReservationOf(userId, options);

				const res = await deleteReservation(reservationId, cookie);

				expect(res.status).toBe(409);
				expect(await res.json()).toMatchObject({
					error: { code: "RESERVATION_NOT_CANCELABLE" },
				});
				expect(await existsReservation(reservationId)).toBe(true);
			},
		);

		test("存在しない予約なら 404 と RESERVATION_NOT_FOUND を返す", async () => {
			const { cookie } = await signInWithProfile();

			const res = await deleteReservation("no-such-reservation", cookie);

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "RESERVATION_NOT_FOUND" },
			});
		});
	});
});
