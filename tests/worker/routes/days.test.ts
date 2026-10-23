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

// テストで使う期間（毎回この期間だけを片付ける）。
// ほかのテストが使っていない 2032 年にし、2032-03 の前後の月の境目も含める
const TEST_RANGE = ["2032-02-01", "2032-04-30"] as const;

function request(path: string, cookie?: string) {
	return app.request(path, { headers: cookie ? { cookie } : {} }, testEnv());
}

describe("GET /api/days（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const { insertDay, insertUser, insertReservation } = testData(testUsers);

	beforeEach(async () => {
		await deleteSeminarDaysBetween(testUsers.db(), TEST_RANGE);
	});

	async function signIn() {
		return signInAsNewUser(testUsers.uniqueEmail());
	}

	test("未ログインなら 401 を返す", async () => {
		const res = await request("/api/days?month=2032-03");

		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({
			error: { code: "UNAUTHORIZED" },
		});
	});

	test("month が無いなら 400 と VALIDATION_ERROR を返す", async () => {
		const cookie = await signIn();

		const res = await request("/api/days", cookie);

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: { code: "VALIDATION_ERROR" },
		});
	});

	test.each([
		["月が1桁", "2032-3"],
		["13月", "2032-13"],
		["0月", "2032-00"],
		// 年は 2000〜2099 に絞る（西暦 0 年などを通すと DB でエラーになり 500 になるため）
		["1999年", "1999-12"],
		["2100年", "2100-01"],
		["区切りが無い", "203203"],
		["日付まで含む", "2032-03-01"],
		["空文字", ""],
		// どちらの月を返すか決められないため、黙ってどちらかを選ばずにエラーにする
		["month が2つある", "2032-03&month=2032-04"],
	])(
		"month が不正（%s）なら 400 と VALIDATION_ERROR を返す",
		async (_, month) => {
			const cookie = await signIn();

			const res = await request(`/api/days?month=${month}`, cookie);

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		},
	);

	test.each([
		"2000-01",
		// 翌月の 1 日が 2100 年になっても、DB のエラーにならない
		"2099-12",
	])("範囲の端の %s は 200 を返す", async (month) => {
		const cookie = await signIn();

		const res = await request(`/api/days?month=${month}`, cookie);

		expect(res.status).toBe(200);
	});

	test("その月の開催日だけを日付の順に返す。前月の末日と翌月の 1 日は含まない", async () => {
		const cookie = await signIn();
		// 並び順を確かめるため、日付の順ではなく入れる
		await insertDay("2032-03-31");
		await insertDay("2032-04-01");
		await insertDay("2032-03-01");
		await insertDay("2032-02-29");
		await insertDay("2032-03-12");

		const res = await request("/api/days?month=2032-03", cookie);

		expect(res.status).toBe(200);
		const body = (await res.json()) as { days: { date: string }[] };
		expect(body.days.map((day) => day.date)).toEqual([
			"2032-03-01",
			"2032-03-12",
			"2032-03-31",
		]);
	});

	test("空き枠の数は、presentation の枠だけを数える", async () => {
		const cookie = await signIn();
		await insertDay("2032-03-05", {
			kinds: [
				"teacher_share",
				"presentation",
				"break",
				"presentation",
				"unavailable",
			],
		});

		const res = await request("/api/days?month=2032-03", cookie);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			days: [
				{
					date: "2032-03-05",
					status: "open",
					closedReason: null,
					availableSlotCount: 2,
				},
			],
		});
	});

	test("予約のある presentation の枠は、空き枠の数に数えない", async () => {
		const cookie = await signIn();
		const slotIds = await insertDay("2032-03-05", {
			kinds: ["presentation", "presentation", "presentation"],
		});
		const userId = await insertUser("Shibata", "B3");
		await insertReservation(idAt(slotIds, 0), userId);

		const res = await request("/api/days?month=2032-03", cookie);

		expect(await res.json()).toEqual({
			days: [
				{
					date: "2032-03-05",
					status: "open",
					closedReason: null,
					availableSlotCount: 2,
				},
			],
		});
	});

	// 実施済みの枠も埋まっている（過去の日に空きがあるように見せない）
	test("done の予約がある枠も、空き枠の数に数えない", async () => {
		const cookie = await signIn();
		const slotIds = await insertDay("2032-03-05", {
			kinds: ["presentation", "presentation"],
		});
		const userId = await insertUser("Shibata", "B3");
		await insertReservation(idAt(slotIds, 0), userId, "done");

		const res = await request("/api/days?month=2032-03", cookie);

		expect(await res.json()).toMatchObject({
			days: [{ date: "2032-03-05", availableSlotCount: 1 }],
		});
	});

	test("枠が1つも無い開催日は、空き枠の数を 0 で返す", async () => {
		const cookie = await signIn();
		await insertDay("2032-03-19");

		const res = await request("/api/days?month=2032-03", cookie);

		expect(await res.json()).toEqual({
			days: [
				{
					date: "2032-03-19",
					status: "open",
					closedReason: null,
					availableSlotCount: 0,
				},
			],
		});
	});

	test("休止日は、休止理由を返し、presentation の枠があっても空き枠の数を 0 で返す", async () => {
		const cookie = await signIn();
		await insertDay("2032-03-12", {
			status: "closed",
			closedReason: "大学祭",
			kinds: ["presentation", "presentation"],
		});

		const res = await request("/api/days?month=2032-03", cookie);

		expect(await res.json()).toEqual({
			days: [
				{
					date: "2032-03-12",
					status: "closed",
					closedReason: "大学祭",
					availableSlotCount: 0,
				},
			],
		});
	});

	// 休止を取り消したあとに古い理由が残っていても、画面に出ないようにする
	test("開いている日は、DB に休止理由が残っていても closedReason を null で返す", async () => {
		const cookie = await signIn();
		await insertDay("2032-03-26", {
			closedReason: "古い理由",
			kinds: ["presentation"],
		});

		const res = await request("/api/days?month=2032-03", cookie);

		expect(await res.json()).toEqual({
			days: [
				{
					date: "2032-03-26",
					status: "open",
					closedReason: null,
					availableSlotCount: 1,
				},
			],
		});
	});

	test("開催日の無い月は、空の配列を返す", async () => {
		const cookie = await signIn();
		await insertDay("2032-02-27");
		await insertDay("2032-04-02");

		const res = await request("/api/days?month=2032-03", cookie);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ days: [] });
	});
});

// 予約できるか・取り消せるかは API の現在時刻で決まるため、現在時刻を固定する（実際の日付によって結果が変わらないように）。
// 2032-03-05 などの日はこれより後になる
const NOW = new Date("2032-03-01T12:00:00+09:00");
// 開始時刻を過ぎた枠を確かめるための過去の日（NOW より前）。TEST_RANGE の中にし、片付けを1回で済ませる
const PAST_DAY = "2032-02-27";

describe("GET /api/days/:date（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const {
		insertDay,
		insertDayWithSlots,
		insertUser,
		insertReservation,
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

	// 予約できるか（isReservable）を確かめられるよう、プロフィール登録済みの学生としてログインする
	async function signIn() {
		const { cookie } = await signInWithProfile();
		return cookie;
	}

	test("未ログインなら 401 を返す", async () => {
		await insertDay("2032-03-05");

		const res = await request("/api/days/2032-03-05");

		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({
			error: { code: "UNAUTHORIZED" },
		});
	});

	test.each([
		["月日が1桁", "2032-3-5"],
		// 形式は合っていても実在しない日（通すと DB でエラーになり 500 になるため）
		["2月30日", "2032-02-30"],
		["うるう年でない2月29日", "2031-02-29"],
		["1999年", "1999-12-31"],
		["2100年", "2100-01-01"],
		["区切りが無い", "20320305"],
		["日付でない文字列", "today"],
	])("日付が不正（%s）なら 400 と VALIDATION_ERROR を返す", async (_, date) => {
		const cookie = await signIn();

		const res = await request(`/api/days/${date}`, cookie);

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: { code: "VALIDATION_ERROR" },
		});
	});

	test("開催日でない日なら 404 と SEMINAR_DAY_NOT_FOUND を返す", async () => {
		const cookie = await signIn();
		// 前後の日に開催日があっても、その日だけを見る
		await insertDay("2032-03-04");
		await insertDay("2032-03-06");

		const res = await request("/api/days/2032-03-05", cookie);

		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({
			error: { code: "SEMINAR_DAY_NOT_FOUND" },
		});
	});

	test("開催日の枠を開始時刻の順に、時刻を HH:MM で返す。presentation 以外の枠も返す", async () => {
		const cookie = await signIn();
		// 並び順を確かめるため、開始時刻の順ではなく入れる
		const [presentationId, teacherShareId, unavailableId, breakId] =
			await insertDayWithSlots("2032-03-05", [
				{
					period: 3,
					startTime: "13:30",
					endTime: "13:50",
					kind: "presentation",
				},
				{
					period: 3,
					startTime: "13:10",
					endTime: "13:30",
					kind: "teacher_share",
				},
				{
					period: 4,
					startTime: "15:00",
					endTime: "15:20",
					kind: "unavailable",
				},
				{ period: 3, startTime: "13:50", endTime: "14:00", kind: "break" },
			]);

		const res = await request("/api/days/2032-03-05", cookie);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			day: { date: "2032-03-05", status: "open", closedReason: null },
			slots: [
				{
					id: teacherShareId,
					period: 3,
					startTime: "13:10",
					endTime: "13:30",
					kind: "teacher_share",
					isReservable: false,
					reservation: null,
				},
				{
					id: presentationId,
					period: 3,
					startTime: "13:30",
					endTime: "13:50",
					kind: "presentation",
					isReservable: true,
					reservation: null,
				},
				{
					id: breakId,
					period: 3,
					startTime: "13:50",
					endTime: "14:00",
					kind: "break",
					isReservable: false,
					reservation: null,
				},
				{
					id: unavailableId,
					period: 4,
					startTime: "15:00",
					endTime: "15:20",
					kind: "unavailable",
					isReservable: false,
					reservation: null,
				},
			],
		});
	});

	test("予約のある枠は予約の id・予約者の表示名・学年を返し、予約の無い枠は reservation を null で返す", async () => {
		const cookie = await signIn();
		const slotIds = await insertDay("2032-03-05", {
			kinds: ["presentation", "presentation"],
		});
		const takenSlotId = idAt(slotIds, 0);
		const freeSlotId = idAt(slotIds, 1);
		const userId = await insertUser("Shibata", "B3");
		const reservationId = await insertReservation(takenSlotId, userId);

		const res = await request("/api/days/2032-03-05", cookie);

		const body = (await res.json()) as {
			slots: { id: string; reservation: unknown }[];
		};
		// 予約あり・なしの両方が1件ずつあることを確かめてから、中身を見る（空振りで通らないように）
		expect(body.slots.map((slot) => slot.id)).toEqual([
			takenSlotId,
			freeSlotId,
		]);
		expect(body.slots.map((slot) => slot.reservation)).toEqual([
			{
				id: reservationId,
				displayName: "Shibata",
				grade: "B3",
				isCancelable: false,
			},
			null,
		]);
	});

	test("教員（学年なし）の予約は grade を null で返す", async () => {
		const cookie = await signIn();
		const slotIds = await insertDay("2032-03-05", { kinds: ["presentation"] });
		const userId = await insertUser("森谷", null);
		await insertReservation(idAt(slotIds, 0), userId);

		const res = await request("/api/days/2032-03-05", cookie);

		expect(await res.json()).toMatchObject({
			slots: [{ reservation: { displayName: "森谷", grade: null } }],
		});
	});

	// 過去の日を開いても、誰が発表したかが分かるようにする
	test("done の予約も予約者を返す", async () => {
		const cookie = await signIn();
		const slotIds = await insertDay("2032-03-05", { kinds: ["presentation"] });
		const userId = await insertUser("Shibata", "MIDS_B3");
		await insertReservation(idAt(slotIds, 0), userId, "done");

		const res = await request("/api/days/2032-03-05", cookie);

		expect(await res.json()).toMatchObject({
			slots: [{ reservation: { displayName: "Shibata", grade: "MIDS_B3" } }],
		});
	});

	test("別の日の枠・予約は含まない", async () => {
		const cookie = await signIn();
		const [slotId] = await insertDay("2032-03-05", { kinds: ["presentation"] });
		const otherDaySlotIds = await insertDay("2032-03-12", {
			kinds: ["presentation", "break"],
		});
		const userId = await insertUser("Shibata", "B3");
		await insertReservation(idAt(otherDaySlotIds, 0), userId);

		const res = await request("/api/days/2032-03-05", cookie);

		const body = (await res.json()) as {
			day: { date: string };
			slots: { id: string; reservation: unknown }[];
		};
		expect(body.day.date).toBe("2032-03-05");
		expect(body.slots).toEqual([
			expect.objectContaining({ id: slotId, reservation: null }),
		]);
	});

	test("休止日は、休止理由と枠を返す", async () => {
		const cookie = await signIn();
		const [slotId] = await insertDay("2032-03-05", {
			status: "closed",
			closedReason: "大学祭",
			kinds: ["presentation"],
		});

		const res = await request("/api/days/2032-03-05", cookie);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			day: { date: "2032-03-05", status: "closed", closedReason: "大学祭" },
			slots: [
				{
					id: slotId,
					period: 3,
					startTime: "13:00",
					endTime: "13:10",
					kind: "presentation",
					// 休止日は予約できない
					isReservable: false,
					reservation: null,
				},
			],
		});
	});

	// 休止を取り消したあとに古い理由が残っていても、画面に出ないようにする（GET /api/days と同じ）
	test("開いている日は、DB に休止理由が残っていても closedReason を null で返す", async () => {
		const cookie = await signIn();
		await insertDay("2032-03-05", { closedReason: "古い理由" });

		const res = await request("/api/days/2032-03-05", cookie);

		expect(await res.json()).toMatchObject({
			day: { status: "open", closedReason: null },
		});
	});

	test("枠が1つも無い開催日は、slots を空の配列で返す", async () => {
		const cookie = await signIn();
		await insertDay("2032-03-05");

		const res = await request("/api/days/2032-03-05", cookie);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			day: { date: "2032-03-05", status: "open", closedReason: null },
			slots: [],
		});
	});

	type SlotBody = {
		isReservable: boolean;
		reservation: { isCancelable: boolean } | null;
	};

	async function fetchSlots(date: string, cookie: string) {
		const res = await request(`/api/days/${date}`, cookie);
		expect(res.status).toBe(200);
		return ((await res.json()) as { slots: SlotBody[] }).slots;
	}

	describe("isReservable（予約できるか）", () => {
		test("予約済みの枠は false を返す", async () => {
			const cookie = await signIn();
			const slotIds = await insertDay("2032-03-05", {
				kinds: ["presentation", "presentation"],
			});
			const userId = await insertUser("Shibata", "B3");
			await insertReservation(idAt(slotIds, 0), userId);

			const slots = await fetchSlots("2032-03-05", cookie);

			expect(slots.map((slot) => slot.isReservable)).toEqual([false, true]);
		});

		test("開始時刻を過ぎた枠は false を返す", async () => {
			const cookie = await signIn();
			await insertDay(PAST_DAY, { kinds: ["presentation"] });

			const slots = await fetchSlots(PAST_DAY, cookie);

			expect(slots.map((slot) => slot.isReservable)).toEqual([false]);
		});

		test("teacher には、空いている枠も false を返す", async () => {
			const { cookie } = await signInWithProfile("teacher");
			await insertDay("2032-03-05", { kinds: ["presentation"] });

			const slots = await fetchSlots("2032-03-05", cookie);

			expect(slots.map((slot) => slot.isReservable)).toEqual([false]);
		});

		test("プロフィール未登録の人には、空いている枠も false を返す", async () => {
			const cookie = await signInAsNewUser(testUsers.uniqueEmail());
			await insertDay("2032-03-05", { kinds: ["presentation"] });

			const slots = await fetchSlots("2032-03-05", cookie);

			expect(slots.map((slot) => slot.isReservable)).toEqual([false]);
		});

		test("admin には、空いている枠で true を返す", async () => {
			const { cookie } = await signInWithProfile("admin");
			await insertDay("2032-03-05", { kinds: ["presentation"] });

			const slots = await fetchSlots("2032-03-05", cookie);

			expect(slots.map((slot) => slot.isReservable)).toEqual([true]);
		});
	});

	describe("isCancelable（取り消せるか）", () => {
		test("本人の、開始前の reserved の予約は true、他人の予約は false を返す", async () => {
			const { cookie, userId } = await signInWithProfile();
			const slotIds = await insertDay("2032-03-05", {
				kinds: ["presentation", "presentation"],
			});
			const otherUserId = await insertUser("Shibata", "B3");
			await insertReservation(idAt(slotIds, 0), userId);
			await insertReservation(idAt(slotIds, 1), otherUserId);

			const slots = await fetchSlots("2032-03-05", cookie);

			expect(slots.map((slot) => slot.reservation?.isCancelable)).toEqual([
				true,
				false,
			]);
		});

		test("本人の予約でも、done なら false を返す", async () => {
			const { cookie, userId } = await signInWithProfile();
			const slotIds = await insertDay("2032-03-05", {
				kinds: ["presentation"],
			});
			await insertReservation(idAt(slotIds, 0), userId, "done");

			const slots = await fetchSlots("2032-03-05", cookie);

			expect(slots.map((slot) => slot.reservation?.isCancelable)).toEqual([
				false,
			]);
		});

		test("本人の予約でも、開始時刻を過ぎていれば false を返す", async () => {
			const { cookie, userId } = await signInWithProfile();
			const slotIds = await insertDay(PAST_DAY, {
				kinds: ["presentation"],
			});
			await insertReservation(idAt(slotIds, 0), userId);

			const slots = await fetchSlots(PAST_DAY, cookie);

			expect(slots.map((slot) => slot.reservation?.isCancelable)).toEqual([
				false,
			]);
		});

		test("admin には、他人の予約も、done・開始後の予約も true を返す", async () => {
			const { cookie } = await signInWithProfile("admin");
			const futureSlotIds = await insertDay("2032-03-05", {
				kinds: ["presentation", "presentation"],
			});
			const pastSlotIds = await insertDay(PAST_DAY, {
				kinds: ["presentation"],
			});
			const otherUserId = await insertUser("Shibata", "B3");
			await insertReservation(idAt(futureSlotIds, 0), otherUserId);
			await insertReservation(idAt(futureSlotIds, 1), otherUserId, "done");
			await insertReservation(idAt(pastSlotIds, 0), otherUserId);

			const futureSlots = await fetchSlots("2032-03-05", cookie);
			const pastSlots = await fetchSlots(PAST_DAY, cookie);

			expect(futureSlots.map((slot) => slot.reservation?.isCancelable)).toEqual(
				[true, true],
			);
			expect(pastSlots.map((slot) => slot.reservation?.isCancelable)).toEqual([
				true,
			]);
		});
	});
});
