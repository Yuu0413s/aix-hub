import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import * as clock from "../../../src/worker/clock";
import { createId } from "../../../src/worker/db/id";
import { app } from "../../../src/worker/index";
import { signInAsNewUser, testEnv, useTestUsers } from "../../helpers/sign-in";
import {
	idAt,
	type ReservationStatus,
	testData,
} from "../../helpers/test-data";
import { deleteSeminarDaysBetween } from "../../helpers/test-db";

// API の現在時刻を固定し、その前後の日を使う（実際の日付によって結果が変わらないように）。ほかのテストが使っていない年にする
const TEST_RANGE = ["2033-03-01", "2033-03-31"] as const;
const NOW = new Date("2033-03-03T12:00:00+09:00");
const FUTURE_DAY = "2033-03-04";
const PAST_DAY = "2033-03-02";
// app.request はパスだけを渡すと http://localhost に送る。ブラウザが同じオリジンから送るときと同じく、Origin を付ける
const SAME_ORIGIN = "http://localhost";

async function request(
	method: "POST" | "DELETE",
	path: string,
	cookie?: string,
	headers: Record<string, string> = { origin: SAME_ORIGIN },
) {
	return app.request(
		path,
		{ method, headers: cookie ? { ...headers, cookie } : headers },
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
	const {
		insertDay,
		insertUser,
		insertReservation,
		insertReservationOnNewSlot,
		findReservationsBySlot,
		isReservationExisting,
		signInWithProfile,
	} = testData(testUsers);
	let currentTimeSpy: Mock<typeof clock.currentTime>;

	beforeEach(async () => {
		currentTimeSpy = spyOn(clock, "currentTime").mockReturnValue(NOW);
		await deleteSeminarDaysBetween(testUsers.db(), TEST_RANGE);
	});

	afterEach(() => {
		currentTimeSpy.mockRestore();
	});

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
				expect(await findReservationsBySlot(slotId)).toEqual([
					{ userId, status: "reserved" },
				]);
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

			const res = await postReservation(createId(), cookie);

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "SLOT_NOT_FOUND" },
			});
		});

		test.each([
			["31文字", "a".repeat(31)],
			["記号を含む", `${"a".repeat(31)}-`],
			// PostgreSQL の text に渡せず、検証しないと 500 になる
			["NUL を含む", `${"a".repeat(31)}%00`],
		])(
			"枠の id の形が不正（%s）なら 400 と VALIDATION_ERROR を返す",
			async (_, slotId) => {
				const { cookie } = await signInWithProfile();

				const res = await postReservation(slotId, cookie);

				expect(res.status).toBe(400);
				expect(await res.json()).toMatchObject({
					error: { code: "VALIDATION_ERROR" },
				});
			},
		);

		test("未ログインなら、枠の id の形に関係なく 401 を返す", async () => {
			const res = await postReservation("not-an-id");

			expect(res.status).toBe(401);
		});

		test.each([
			[
				"別のサイトのフォーム",
				{
					origin: "https://evil.example",
					"content-type": "application/x-www-form-urlencoded",
				},
			],
			["Origin の無いフォーム", { "content-type": "text/plain" }],
		])(
			"%sから送られたら 403 と FORBIDDEN を返し、予約は作られない",
			async (_, headers) => {
				const slotId = await insertFreeSlot();
				const { cookie } = await signInWithProfile();

				const res = await request(
					"POST",
					`/api/slots/${slotId}/reservations`,
					cookie,
					headers,
				);

				expect(res.status).toBe(403);
				expect(await res.json()).toMatchObject({
					error: { code: "FORBIDDEN" },
				});
				expect(await findReservationsBySlot(slotId)).toEqual([]);
			},
		);

		// ブラウザは同じオリジンへの送信に Sec-Fetch-Site: same-origin を付ける（Origin を付けない古い場合も通す）
		test("Sec-Fetch-Site が same-origin なら、Origin が無くても予約できる", async () => {
			const slotId = await insertFreeSlot();
			const { cookie } = await signInWithProfile();

			const res = await request(
				"POST",
				`/api/slots/${slotId}/reservations`,
				cookie,
				{ "sec-fetch-site": "same-origin" },
			);

			expect(res.status).toBe(200);
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
			expect(rows).toEqual([{ userId: winner.userId, status: "reserved" }]);
		});
	});

	describe("DELETE /api/reservations/:id", () => {
		async function insertReservationOf(
			userId: string,
			{
				date = FUTURE_DAY,
				status = "reserved",
			}: { date?: string; status?: ReservationStatus } = {},
		) {
			return insertReservationOnNewSlot(date, userId, status);
		}

		test("未ログインなら 401 を返し、予約は残る", async () => {
			const reservationId = await insertReservationOf(
				await insertUser("Shibata", "B3"),
			);

			const res = await deleteReservation(reservationId);

			expect(res.status).toBe(401);
			expect(await isReservationExisting(reservationId)).toBe(true);
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
			expect(await isReservationExisting(reservationId)).toBe(false);
		});

		test("admin は他人の予約を取り消せる", async () => {
			const { cookie } = await signInWithProfile("admin");
			const reservationId = await insertReservationOf(
				await insertUser("Shibata", "B3"),
			);

			const res = await deleteReservation(reservationId, cookie);

			expect(res.status).toBe(200);
			expect(await isReservationExisting(reservationId)).toBe(false);
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
			expect(await isReservationExisting(reservationId)).toBe(true);
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
				expect(await isReservationExisting(reservationId)).toBe(true);
			},
		);

		test("存在しない予約なら 404 と RESERVATION_NOT_FOUND を返す", async () => {
			const { cookie } = await signInWithProfile();

			const res = await deleteReservation(createId(), cookie);

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "RESERVATION_NOT_FOUND" },
			});
		});

		test("予約の id の形が不正なら 400 と VALIDATION_ERROR を返す", async () => {
			const { cookie } = await signInWithProfile();

			const res = await deleteReservation(`${"a".repeat(31)}%00`, cookie);

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});

		test("別のサイトから送られたら 403 と FORBIDDEN を返し、予約は残る", async () => {
			const { cookie, userId } = await signInWithProfile();
			const reservationId = await insertReservationOf(userId);

			const res = await request(
				"DELETE",
				`/api/reservations/${reservationId}`,
				cookie,
				{ origin: "https://evil.example", "content-type": "text/plain" },
			);

			expect(res.status).toBe(403);
			expect(await isReservationExisting(reservationId)).toBe(true);
		});
	});
});
