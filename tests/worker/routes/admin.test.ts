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
import { app } from "../../../src/worker/index";
import { signInAsNewUser, testEnv, useTestUsers } from "../../helpers/sign-in";
import { idAt, testData } from "../../helpers/test-data";
import { deleteSeminarDaysBetween } from "../../helpers/test-db";

// API の現在時刻を固定し、その前後の日を使う（実際の日付によって結果が変わらないように）。ほかのテストが使っていない年にする。
// 2039-03-04・03-11 は金曜、2039-03-10 は木曜
const TEST_RANGE = ["2039-03-01", "2039-03-31"] as const;
const NOW = new Date("2039-03-09T12:00:00+09:00");
const DAY = "2039-03-11";
const PAST_DAY = "2039-03-04";
const THURSDAY = "2039-03-10";
// app.request はパスだけを渡すと http://localhost に送る。ブラウザが同じオリジンから送るときと同じく、Origin を付ける
const SAME_ORIGIN = "http://localhost";

function patchDay(
	date: string,
	{ cookie, body }: { cookie?: string; body?: unknown } = {},
) {
	return app.request(
		`/api/admin/days/${date}`,
		{
			method: "PATCH",
			headers: {
				origin: SAME_ORIGIN,
				"content-type": "application/json",
				...(cookie ? { cookie } : {}),
			},
			body: JSON.stringify(body ?? { status: "closed", closedReason: null }),
		},
		testEnv(),
	);
}

describe("PATCH /api/admin/days/:date（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const {
		insertDay,
		insertUser,
		insertReservation,
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

	describe("権限", () => {
		test("未ログインなら 401 を返す", async () => {
			const res = await patchDay(DAY);

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test.each(["student", "teacher"] as const)(
			"%s なら 403 を返し、開催日を作らない",
			async (role) => {
				const { cookie } = await signInWithProfile(role);

				const res = await patchDay(DAY, { cookie });

				expect(res.status).toBe(403);
				expect(await res.json()).toMatchObject({
					error: { code: "FORBIDDEN" },
				});
				const days = await app.request(
					"/api/days?month=2039-03",
					{ headers: { cookie } },
					testEnv(),
				);
				expect(await days.json()).toEqual({ days: [] });
			},
		);

		test("プロフィール未登録の student も 403 を返す", async () => {
			const cookie = await signInAsNewUser(testUsers.uniqueEmail());

			const res = await patchDay(DAY, { cookie });

			expect(res.status).toBe(403);
		});

		test("admin なら 200 を返す", async () => {
			const { cookie } = await signInWithProfile("admin");

			const res = await patchDay(DAY, { cookie });

			expect(res.status).toBe(200);
		});
	});

	describe("休止・再開", () => {
		test("休止すると、開催日の状態と消した予約の件数を返し、その日の開始前の予約を消す", async () => {
			const { cookie } = await signInWithProfile("admin");
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
			const userId = await insertUser("Shibata", "B3");
			const reservationId = await insertReservation(idAt(slotIds, 0), userId);

			const res = await patchDay(DAY, {
				cookie,
				body: { status: "closed", closedReason: "大学祭" },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				day: { date: DAY, status: "closed", closedReason: "大学祭" },
				deletedReservationCount: 1,
			});
			expect(await isReservationExisting(reservationId)).toBe(false);
		});

		test("休止したあと、月の開催日の一覧に休講と理由が出る", async () => {
			const { cookie } = await signInWithProfile("admin");

			await patchDay(DAY, {
				cookie,
				body: { status: "closed", closedReason: "大学祭" },
			});

			const res = await app.request(
				"/api/days?month=2039-03",
				{ headers: { cookie } },
				testEnv(),
			);
			expect(await res.json()).toEqual({
				days: [
					{
						date: DAY,
						status: "closed",
						closedReason: "大学祭",
						availableSlotCount: 0,
					},
				],
			});
		});

		test("再開すると、open にして理由を消す", async () => {
			const { cookie } = await signInWithProfile("admin");
			await insertDay(DAY, { status: "closed", closedReason: "大学祭" });

			const res = await patchDay(DAY, {
				cookie,
				body: { status: "open", closedReason: null },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				day: { date: DAY, status: "open", closedReason: null },
				deletedReservationCount: 0,
			});
		});

		test("理由の前後の空白は取り除いて保存する", async () => {
			const { cookie } = await signInWithProfile("admin");

			const res = await patchDay(DAY, {
				cookie,
				body: { status: "closed", closedReason: "  大学祭　" },
			});

			expect(await res.json()).toMatchObject({
				day: { closedReason: "大学祭" },
			});
		});

		test("理由は100文字まで（絵文字1つは1文字と数える）", async () => {
			const { cookie } = await signInWithProfile("admin");
			const closedReason = "🎉".repeat(100);

			const res = await patchDay(DAY, {
				cookie,
				body: { status: "closed", closedReason },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ day: { closedReason } });
		});

		test("今日より前の日付は 409 SEMINAR_DAY_PAST を返す", async () => {
			const { cookie } = await signInWithProfile("admin");
			await insertDay(PAST_DAY);

			const res = await patchDay(PAST_DAY, { cookie });

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "SEMINAR_DAY_PAST" },
			});
		});
	});

	describe("入力の検証", () => {
		test.each([
			["木曜", THURSDAY],
			["実在しない日付", "2039-02-30"],
			["日付の形でない", "2039-3-11"],
		])("%s（%s）は 400 を返す", async (_, date) => {
			const { cookie } = await signInWithProfile("admin");

			const res = await patchDay(date, { cookie });

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});

		test.each([
			["再開なのに理由がある", { status: "open", closedReason: "大学祭" }],
			["理由が101文字", { status: "closed", closedReason: "あ".repeat(101) }],
			["理由に改行がある", { status: "closed", closedReason: "大学祭\n休講" }],
			["理由が空文字", { status: "closed", closedReason: "" }],
			["理由が空白だけ", { status: "closed", closedReason: "　 " }],
			["理由が無い", { status: "closed" }],
			["状態が無い", { closedReason: null }],
			["状態が open / closed 以外", { status: "deleted", closedReason: null }],
			["余計なキーがある", { status: "closed", closedReason: null, date: DAY }],
		])("本文の%sなら 400 を返し、開催日を作らない", async (_, body) => {
			const { cookie } = await signInWithProfile("admin");

			const res = await patchDay(DAY, { cookie, body });

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
			const days = await app.request(
				"/api/days?month=2039-03",
				{ headers: { cookie } },
				testEnv(),
			);
			expect(await days.json()).toEqual({ days: [] });
		});
	});
});

function patchSlot(
	slotId: string,
	{ cookie, body }: { cookie?: string; body?: unknown } = {},
) {
	return app.request(
		`/api/admin/slots/${slotId}`,
		{
			method: "PATCH",
			headers: {
				origin: SAME_ORIGIN,
				"content-type": "application/json",
				...(cookie ? { cookie } : {}),
			},
			body: JSON.stringify(
				body ?? { kind: "break", startTime: "13:00", endTime: "13:10" },
			),
		},
		testEnv(),
	);
}

describe("PATCH /api/admin/slots/:id（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const {
		insertDay,
		insertUser,
		insertReservation,
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

	// その日の枠（日別の表の API で読む。管理画面もこの API で枠を表示するため）
	async function fetchDaySlots(date: string, cookie: string) {
		const res = await app.request(
			`/api/days/${date}`,
			{ headers: { cookie } },
			testEnv(),
		);
		const body = (await res.json()) as {
			slots: { startTime: string; endTime: string; kind: string }[];
		};
		return body.slots.map(({ startTime, endTime, kind }) => ({
			startTime,
			endTime,
			kind,
		}));
	}

	describe("権限", () => {
		test("未ログインなら 401 を返す", async () => {
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });

			const res = await patchSlot(idAt(slotIds, 0));

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test.each(["student", "teacher"] as const)(
			"%s なら 403 を返し、枠を変えない",
			async (role) => {
				const { cookie } = await signInWithProfile(role);
				const slotIds = await insertDay(DAY, { kinds: ["presentation"] });

				const res = await patchSlot(idAt(slotIds, 0), { cookie });

				expect(res.status).toBe(403);
				expect(await res.json()).toMatchObject({
					error: { code: "FORBIDDEN" },
				});
				expect(await fetchDaySlots(DAY, cookie)).toEqual([
					{ startTime: "13:00", endTime: "13:10", kind: "presentation" },
				]);
			},
		);

		test("プロフィール未登録の student も 403 を返す", async () => {
			const cookie = await signInAsNewUser(testUsers.uniqueEmail());
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });

			const res = await patchSlot(idAt(slotIds, 0), { cookie });

			expect(res.status).toBe(403);
		});
	});

	describe("変更", () => {
		test("種類と時刻を変え、変えた枠（時刻は HH:MM）と消した予約の件数を返す", async () => {
			const { cookie } = await signInWithProfile("admin");
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
			const slotId = idAt(slotIds, 0);
			const userId = await insertUser("Shibata", "B3");
			const reservationId = await insertReservation(slotId, userId);

			const res = await patchSlot(slotId, {
				cookie,
				body: { kind: "teacher_share", startTime: "13:05", endTime: "13:25" },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				slot: {
					id: slotId,
					period: 3,
					startTime: "13:05",
					endTime: "13:25",
					kind: "teacher_share",
				},
				deletedReservationCount: 1,
			});
			expect(await isReservationExisting(reservationId)).toBe(false);
		});

		test("時刻だけを変えると予約は残り、日別の表に変えた時刻で出る", async () => {
			const { cookie } = await signInWithProfile("admin");
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
			const slotId = idAt(slotIds, 0);
			const userId = await insertUser("Shibata", "B3");
			const reservationId = await insertReservation(slotId, userId);

			const res = await patchSlot(slotId, {
				cookie,
				body: { kind: "presentation", startTime: "13:30", endTime: "13:50" },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ deletedReservationCount: 0 });
			expect(await isReservationExisting(reservationId)).toBe(true);
			expect(await fetchDaySlots(DAY, cookie)).toEqual([
				{ startTime: "13:30", endTime: "13:50", kind: "presentation" },
			]);
		});
	});

	describe("変えられない枠", () => {
		test("存在しない枠なら 404 SLOT_NOT_FOUND を返す", async () => {
			const { cookie } = await signInWithProfile("admin");

			const res = await patchSlot("0".repeat(32), { cookie });

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "SLOT_NOT_FOUND" },
			});
		});

		test("開始時刻を過ぎた枠なら 409 SLOT_STARTED を返す", async () => {
			const { cookie } = await signInWithProfile("admin");
			const slotIds = await insertDay(PAST_DAY, { kinds: ["presentation"] });

			const res = await patchSlot(idAt(slotIds, 0), { cookie });

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "SLOT_STARTED" },
			});
		});

		test("開始時刻が同じ日の別の枠と同じなら 409 SLOT_START_TIME_TAKEN を返し、枠を変えない", async () => {
			const { cookie } = await signInWithProfile("admin");
			// 1つ目は 13:00〜13:10、2つ目は 13:10〜13:20
			const slotIds = await insertDay(DAY, {
				kinds: ["presentation", "break"],
			});

			const res = await patchSlot(idAt(slotIds, 1), {
				cookie,
				body: { kind: "break", startTime: "13:00", endTime: "13:20" },
			});

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "SLOT_START_TIME_TAKEN" },
			});
			expect(await fetchDaySlots(DAY, cookie)).toEqual([
				{ startTime: "13:00", endTime: "13:10", kind: "presentation" },
				{ startTime: "13:10", endTime: "13:20", kind: "break" },
			]);
		});
	});

	describe("入力の検証", () => {
		test.each([
			["英数字32文字でない", "abc"],
			["記号を含む", `${"a".repeat(31)}%`],
		])("枠の id が%sなら 400 を返す", async (_, slotId) => {
			const { cookie } = await signInWithProfile("admin");

			const res = await patchSlot(slotId, { cookie });

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});

		test.each([
			[
				"開始時刻と終了時刻が同じ",
				{ kind: "break", startTime: "13:00", endTime: "13:00" },
			],
			[
				"開始時刻が終了時刻より後",
				{ kind: "break", startTime: "13:30", endTime: "13:00" },
			],
			["時刻の分が1桁", { kind: "break", startTime: "13:3", endTime: "13:40" }],
			["時刻が 24:00", { kind: "break", startTime: "23:00", endTime: "24:00" }],
			[
				"時刻に秒がある",
				{ kind: "break", startTime: "13:30:00", endTime: "13:40" },
			],
			[
				"種類が一覧に無い",
				{ kind: "lunch", startTime: "13:00", endTime: "13:10" },
			],
			["種類が無い", { startTime: "13:00", endTime: "13:10" }],
			["終了時刻が無い", { kind: "break", startTime: "13:00" }],
			[
				"余計なキーがある",
				{ kind: "break", startTime: "13:00", endTime: "13:10", period: 4 },
			],
		])("本文の%sなら 400 を返し、枠を変えない", async (_, body) => {
			const { cookie } = await signInWithProfile("admin");
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });

			const res = await patchSlot(idAt(slotIds, 0), { cookie, body });

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
			expect(await fetchDaySlots(DAY, cookie)).toEqual([
				{ startTime: "13:00", endTime: "13:10", kind: "presentation" },
			]);
		});
	});
});
