import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import * as clock from "../../../src/worker/clock";
import { createId } from "../../../src/worker/db/id";
import { reservations, users } from "../../../src/worker/db/schema";
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

// insertDay の1つ目の枠の値。画面で見ていた変更前の値（previous）として送る
const FIRST_SLOT = {
	kind: "presentation",
	startTime: "13:00",
	endTime: "13:10",
} as const;

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
				body ?? {
					kind: "break",
					startTime: "13:00",
					endTime: "13:10",
					previous: FIRST_SLOT,
				},
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
				body: {
					kind: "teacher_share",
					startTime: "13:05",
					endTime: "13:25",
					previous: FIRST_SLOT,
				},
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
				body: {
					kind: "presentation",
					startTime: "13:30",
					endTime: "13:50",
					previous: FIRST_SLOT,
				},
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
				body: {
					kind: "break",
					startTime: "13:00",
					endTime: "13:20",
					previous: { kind: "break", startTime: "13:10", endTime: "13:20" },
				},
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

		test("変更前の値が今の枠と違えば 409 SLOT_CHANGED を返し、枠を変えない", async () => {
			const { cookie } = await signInWithProfile("admin");
			// ほかの管理者が break にしたあとの枠を、presentation のままの古い画面から保存する
			const slotIds = await insertDay(DAY, { kinds: ["break"] });

			const res = await patchSlot(idAt(slotIds, 0), {
				cookie,
				body: {
					kind: "presentation",
					startTime: "13:00",
					endTime: "13:20",
					previous: FIRST_SLOT,
				},
			});

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "SLOT_CHANGED" },
			});
			expect(await fetchDaySlots(DAY, cookie)).toEqual([
				{ startTime: "13:00", endTime: "13:10", kind: "break" },
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
		])("本文の%sなら 400 を返し、枠を変えない", async (_, change) => {
			const { cookie } = await signInWithProfile("admin");
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });

			const res = await patchSlot(idAt(slotIds, 0), {
				cookie,
				body: { ...change, previous: FIRST_SLOT },
			});

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
			expect(await fetchDaySlots(DAY, cookie)).toEqual([
				{ startTime: "13:00", endTime: "13:10", kind: "presentation" },
			]);
		});

		test.each([
			[
				"変更前の値が無い",
				{ kind: "break", startTime: "13:00", endTime: "13:10" },
			],
			[
				"変更前の時刻の形が違う",
				{
					kind: "break",
					startTime: "13:00",
					endTime: "13:10",
					previous: { ...FIRST_SLOT, endTime: "13:10:00" },
				},
			],
			[
				"変更前の種類が一覧に無い",
				{
					kind: "break",
					startTime: "13:00",
					endTime: "13:10",
					previous: { ...FIRST_SLOT, kind: "lunch" },
				},
			],
			[
				"変更前の値に余計なキーがある",
				{
					kind: "break",
					startTime: "13:00",
					endTime: "13:10",
					previous: { ...FIRST_SLOT, period: 3 },
				},
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

type AdminUser = {
	id: string;
	displayName: string | null;
	email: string;
	grade: string | null;
	role: string;
	isEnrolled: boolean;
};

function getUsers(cookie?: string) {
	return app.request(
		"/api/admin/users",
		{ headers: cookie ? { cookie } : {} },
		testEnv(),
	);
}

// テスト用 DB はほかのテストと共有しているため、このテストで作った人（ids）だけを、レスポンスの順のまま取り出す
async function usersOf(res: Response, ids: string[]): Promise<AdminUser[]> {
	const json = (await res.json()) as { users: AdminUser[] };
	return json.users.filter((user) => ids.includes(user.id));
}

describe("GET /api/admin/users（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const { insertUser, signInWithProfile } = testData(testUsers);

	describe("権限", () => {
		test("未ログインなら 401 を返す", async () => {
			const res = await getUsers();

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test.each(["student", "teacher"] as const)(
			"%s なら 403 を返す",
			async (role) => {
				const { cookie } = await signInWithProfile(role);

				const res = await getUsers(cookie);

				expect(res.status).toBe(403);
				expect(await res.json()).toMatchObject({
					error: { code: "FORBIDDEN" },
				});
			},
		);

		test("admin なら 200 を返す", async () => {
			const { cookie } = await signInWithProfile("admin");

			const res = await getUsers(cookie);

			expect(res.status).toBe(200);
		});
	});

	describe("一覧", () => {
		test("1件ごとに id・表示名・メール・学年・役割・在籍中かだけを返す", async () => {
			const { cookie } = await signInWithProfile("admin");
			const userId = await insertUser("Shibata", "B3");
			const [user] = await testUsers
				.db()
				.select({ email: users.email })
				.from(users)
				.where(eq(users.id, userId));

			const res = await getUsers(cookie);

			expect(await usersOf(res, [userId])).toEqual([
				{
					id: userId,
					displayName: "Shibata",
					email: user?.email ?? "",
					grade: "B3",
					role: "student",
					isEnrolled: true,
				},
			]);
		});

		test("卒業生とプロフィール未登録の人も載せる", async () => {
			const { cookie } = await signInWithProfile("admin");
			const graduateId = await insertUser("卒業生", "B4");
			const unregisteredId = await insertUser("未登録", null);
			await testUsers
				.db()
				.update(users)
				.set({ isEnrolled: false })
				.where(eq(users.id, graduateId));
			await testUsers
				.db()
				.update(users)
				.set({ displayName: null })
				.where(eq(users.id, unregisteredId));

			const res = await getUsers(cookie);

			expect(await usersOf(res, [graduateId, unregisteredId])).toMatchObject([
				{ id: unregisteredId, displayName: null, isEnrolled: true },
				{ id: graduateId, displayName: "卒業生", isEnrolled: false },
			]);
		});

		test("在籍中 → 卒業生、学年の順（学年なしは後ろ）、表示名の順（未登録は後ろ）に並ぶ", async () => {
			const { cookie } = await signInWithProfile("admin");
			const graduateId = await insertUser("A卒業生", "B1");
			const unregisteredId = await insertUser("未登録", null);
			const teacherId = await insertUser("Z先生", null, "teacher");
			const b3SecondId = await insertUser("B", "B3");
			const b3FirstId = await insertUser("A", "B3");
			const b1Id = await insertUser("Z", "B1");
			await testUsers
				.db()
				.update(users)
				.set({ isEnrolled: false })
				.where(eq(users.id, graduateId));
			await testUsers
				.db()
				.update(users)
				.set({ displayName: null })
				.where(eq(users.id, unregisteredId));

			const res = await getUsers(cookie);

			const ids = [
				b1Id,
				b3FirstId,
				b3SecondId,
				teacherId,
				unregisteredId,
				graduateId,
			];
			expect((await usersOf(res, ids)).map((user) => user.id)).toEqual(ids);
		});
	});
});

describe("PATCH /api/admin/users/:id（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const { insertDay, insertUser, insertReservation, signInWithProfile } =
		testData(testUsers);
	let currentTimeSpy: Mock<typeof clock.currentTime>;

	beforeEach(async () => {
		currentTimeSpy = spyOn(clock, "currentTime").mockReturnValue(NOW);
		await deleteSeminarDaysBetween(testUsers.db(), TEST_RANGE);
	});

	afterEach(() => {
		currentTimeSpy.mockRestore();
	});

	function patchUser(
		userId: string,
		{ cookie, body }: { cookie?: string; body?: unknown } = {},
	) {
		return app.request(
			`/api/admin/users/${userId}`,
			{
				method: "PATCH",
				headers: {
					origin: SAME_ORIGIN,
					"content-type": "application/json",
					...(cookie ? { cookie } : {}),
				},
				body: JSON.stringify(body ?? { role: "teacher" }),
			},
			testEnv(),
		);
	}

	async function findUser(userId: string) {
		const [user] = await testUsers
			.db()
			.select()
			.from(users)
			.where(eq(users.id, userId));
		if (!user) {
			throw new Error(`${userId} のユーザーが見つかりません`);
		}
		return user;
	}

	function findReservationIds(userId: string) {
		return testUsers
			.db()
			.select({ id: reservations.id })
			.from(reservations)
			.where(eq(reservations.userId, userId))
			.then((rows) => rows.map((row) => row.id));
	}

	describe("権限", () => {
		test("未ログインなら 401 を返す", async () => {
			const userId = await insertUser("Shibata", "B3");

			const res = await patchUser(userId);

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
			expect((await findUser(userId)).role).toBe("student");
		});

		test.each(["student", "teacher"] as const)(
			"%s なら 403 を返し、役割を変えない",
			async (role) => {
				const { cookie } = await signInWithProfile(role);
				const userId = await insertUser("Shibata", "B3");

				const res = await patchUser(userId, { cookie });

				expect(res.status).toBe(403);
				expect(await res.json()).toMatchObject({
					error: { code: "FORBIDDEN" },
				});
				expect((await findUser(userId)).role).toBe("student");
			},
		);

		// 自分を admin にできないことも確かめる
		test("student が自分を admin にしようとしても 403 を返す", async () => {
			const { cookie, userId } = await signInWithProfile("student");

			const res = await patchUser(userId, { cookie, body: { role: "admin" } });

			expect(res.status).toBe(403);
			expect((await findUser(userId)).role).toBe("student");
		});
	});

	describe("入力の検証", () => {
		test.each([
			["形が違う", "abc"],
			["NUL を含む", "%00"],
		])("id が%sなら 400 を返す", async (_, id) => {
			const { cookie } = await signInWithProfile("admin");

			const res = await patchUser(id, { cookie });

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});

		test.each([
			["役割が一覧に無い値", { role: "owner" }],
			["役割が無い", {}],
			["役割が null", { role: null }],
			["余計なキーがある", { role: "teacher", grade: "B3" }],
		])("本文の%sなら 400 を返し、役割を変えない", async (_, body) => {
			const { cookie } = await signInWithProfile("admin");
			const userId = await insertUser("Shibata", "B3");

			const res = await patchUser(userId, { cookie, body });

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
			expect(await findUser(userId)).toMatchObject({
				role: "student",
				grade: "B3",
			});
		});

		test("利用者がいなければ 404 と USER_NOT_FOUND を返す", async () => {
			const { cookie } = await signInWithProfile("admin");

			const res = await patchUser(createId(), { cookie });

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "USER_NOT_FOUND" },
			});
		});
	});

	describe("役割の変更", () => {
		test("役割を変えて、利用者と消した予約の件数を返す", async () => {
			const { cookie } = await signInWithProfile("admin");
			const userId = await insertUser("Shibata", "B3");
			const { email } = await findUser(userId);

			const res = await patchUser(userId, { cookie, body: { role: "admin" } });

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				user: {
					id: userId,
					displayName: "Shibata",
					email,
					grade: "B3",
					role: "admin",
					isEnrolled: true,
				},
				deletedReservationCount: 0,
			});
			expect((await findUser(userId)).role).toBe("admin");
		});

		test("変更は、変えられた人の次のリクエストからすぐ効く", async () => {
			const admin = await signInWithProfile("admin");
			const target = await signInWithProfile("student");
			expect((await getUsers(target.cookie)).status).toBe(403);

			await patchUser(target.userId, {
				cookie: admin.cookie,
				body: { role: "admin" },
			});
			expect((await getUsers(target.cookie)).status).toBe(200);

			await patchUser(target.userId, {
				cookie: admin.cookie,
				body: { role: "student" },
			});
			expect((await getUsers(target.cookie)).status).toBe(403);
		});

		test("プロフィール未登録の人の役割も変えられる", async () => {
			const { cookie } = await signInWithProfile("admin");
			const userId = await insertUser("未登録", null);
			await testUsers
				.db()
				.update(users)
				.set({ displayName: null })
				.where(eq(users.id, userId));

			const res = await patchUser(userId, {
				cookie,
				body: { role: "teacher" },
			});

			expect(res.status).toBe(200);
			expect(await findUser(userId)).toMatchObject({
				role: "teacher",
				displayName: null,
			});
		});

		test.each([
			["student", "admin"],
			["admin", "student"],
		] as const)("%s → %s では学年を残す", async (from, to) => {
			const { cookie } = await signInWithProfile("admin");
			const userId = await insertUser("Shibata", "B3", from);

			const res = await patchUser(userId, { cookie, body: { role: to } });

			expect(res.status).toBe(200);
			expect(await findUser(userId)).toMatchObject({ role: to, grade: "B3" });
		});

		test("teacher を student に戻しても、学年は空のまま", async () => {
			const { cookie } = await signInWithProfile("admin");
			const userId = await insertUser("Shibata", "B3");

			await patchUser(userId, { cookie, body: { role: "teacher" } });
			await patchUser(userId, { cookie, body: { role: "student" } });

			expect(await findUser(userId)).toMatchObject({
				role: "student",
				grade: null,
			});
		});

		test("同じ役割を送っても 200 を返し、何も変わらない", async () => {
			const { cookie } = await signInWithProfile("admin");
			const userId = await insertUser("Shibata", "B3");
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
			await insertReservation(idAt(slotIds, 0), userId);

			const res = await patchUser(userId, {
				cookie,
				body: { role: "student" },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ deletedReservationCount: 0 });
			expect(await findUser(userId)).toMatchObject({
				role: "student",
				grade: "B3",
			});
			expect(await findReservationIds(userId)).toHaveLength(1);
		});
	});

	describe("teacher への変更", () => {
		// NOW（2039-03-09 12:00）を挟むように、開始前と開始後の予約を作る
		async function insertReservationsAroundNow(userId: string) {
			const pastSlotIds = await insertDay(PAST_DAY, {
				kinds: ["presentation", "presentation"],
			});
			const futureSlotIds = await insertDay(DAY, {
				kinds: ["presentation", "presentation"],
			});
			return {
				// 過去の予約は「済」と、Cron の実行前で reserved のままのものの両方を作る
				doneId: await insertReservation(idAt(pastSlotIds, 0), userId, "done"),
				startedId: await insertReservation(idAt(pastSlotIds, 1), userId),
				futureIds: [
					await insertReservation(idAt(futureSlotIds, 0), userId),
					await insertReservation(idAt(futureSlotIds, 1), userId),
				],
			};
		}

		test("学年を null にし、開始前の予約だけを消して、消した件数を返す", async () => {
			const { cookie } = await signInWithProfile("admin");
			const userId = await insertUser("Shibata", "B3");
			const { doneId, startedId } = await insertReservationsAroundNow(userId);

			const res = await patchUser(userId, {
				cookie,
				body: { role: "teacher" },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				user: { role: "teacher", grade: null },
				deletedReservationCount: 2,
			});
			expect(await findUser(userId)).toMatchObject({
				role: "teacher",
				grade: null,
			});
			expect((await findReservationIds(userId)).sort()).toEqual(
				[doneId, startedId].sort(),
			);
		});

		test("admin を teacher にしても、学年を null にして開始前の予約を消す", async () => {
			const { cookie } = await signInWithProfile("admin");
			const userId = await insertUser("Shibata", "B3", "admin");
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
			await insertReservation(idAt(slotIds, 0), userId);

			const res = await patchUser(userId, {
				cookie,
				body: { role: "teacher" },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ deletedReservationCount: 1 });
			expect((await findUser(userId)).grade).toBeNull();
			expect(await findReservationIds(userId)).toEqual([]);
		});

		test("ほかの人の予約は消さない", async () => {
			const { cookie } = await signInWithProfile("admin");
			const userId = await insertUser("Shibata", "B3");
			const otherUserId = await insertUser("Mori", "B3");
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
			const otherReservationId = await insertReservation(
				idAt(slotIds, 0),
				otherUserId,
			);

			const res = await patchUser(userId, {
				cookie,
				body: { role: "teacher" },
			});

			expect(await res.json()).toMatchObject({ deletedReservationCount: 0 });
			expect(await findReservationIds(otherUserId)).toEqual([
				otherReservationId,
			]);
		});

		test.each(["student", "admin"] as const)(
			"%s への変更では予約を消さない",
			async (role) => {
				const { cookie } = await signInWithProfile("admin");
				const userId = await insertUser("Shibata", "B3");
				const { doneId, startedId, futureIds } =
					await insertReservationsAroundNow(userId);

				const res = await patchUser(userId, { cookie, body: { role } });

				expect(await res.json()).toMatchObject({ deletedReservationCount: 0 });
				expect((await findReservationIds(userId)).sort()).toEqual(
					[doneId, startedId, ...futureIds].sort(),
				);
			},
		);

		// 応答が届かず送り直したときも、すでに teacher だったときも結果を同じにする
		test("すでに teacher の人に teacher を送っても、学年を null にして開始前の予約を消す", async () => {
			const { cookie } = await signInWithProfile("admin");
			const userId = await insertUser("Shibata", "B3", "teacher");
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
			await insertReservation(idAt(slotIds, 0), userId);

			const res = await patchUser(userId, {
				cookie,
				body: { role: "teacher" },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ deletedReservationCount: 1 });
			expect((await findUser(userId)).grade).toBeNull();
		});

		// 変更と予約がどちらの順で確定しても、teacher に開始前の予約が残らない
		test("teacher への変更と同時に予約が来ても、開始前の予約が残らない", async () => {
			const admin = await signInWithProfile("admin");
			const target = await signInWithProfile("student");
			const slotIds = await insertDay(DAY, {
				kinds: ["presentation", "presentation", "presentation", "presentation"],
			});
			const postReservation = (slotId: string) =>
				app.request(
					`/api/slots/${slotId}/reservations`,
					{
						method: "POST",
						headers: { origin: SAME_ORIGIN, cookie: target.cookie },
					},
					testEnv(),
				);

			// 同時でなければ予約が通ることを先に確かめる（リクエストが別の理由で弾かれたまま、「予約が残らない」が空振りしないように）
			expect((await postReservation(idAt(slotIds, 0))).status).toBe(200);

			for (const slotId of slotIds.slice(1)) {
				await testUsers
					.db()
					.update(users)
					.set({ role: "student" })
					.where(eq(users.id, target.userId));

				const [patchRes, postRes] = await Promise.all([
					patchUser(target.userId, {
						cookie: admin.cookie,
						body: { role: "teacher" },
					}),
					postReservation(slotId),
				]);

				expect(patchRes.status).toBe(200);
				// 予約が先なら成功（そのあと変更で消える）、変更が先なら 403
				expect([200, 403]).toContain(postRes.status);
				expect(
					await testUsers
						.db()
						.select({ id: reservations.id })
						.from(reservations)
						.where(
							and(
								eq(reservations.userId, target.userId),
								inArray(reservations.slotId, slotIds),
							),
						),
				).toEqual([]);
			}
			// 3回分の往復があり、既定の上限（5秒）では足りないことがある
		}, 60_000);
	});
});
