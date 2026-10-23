import { beforeEach, describe, expect, test } from "bun:test";
import type { Grade } from "../../../src/shared/grade";
import type {
	ScheduleTemplateSlot,
	SlotKind,
} from "../../../src/shared/schedule-template";
import { createId } from "../../../src/worker/db/id";
import {
	reservations,
	seminarDays,
	slots,
	users,
} from "../../../src/worker/db/schema";
import { app } from "../../../src/worker/index";
import { signInAsNewUser, testEnv, useTestUsers } from "../../helpers/sign-in";
import { deleteSeminarDaysBetween } from "../../helpers/test-db";

// テストで使う期間（毎回この期間だけを片付ける）。
// ほかのテストが使っていない 2032 年にし、2032-03 の前後の月の境目も含める
const TEST_RANGE = ["2032-02-01", "2032-04-30"] as const;

function request(path: string, cookie?: string) {
	return app.request(path, { headers: cookie ? { cookie } : {} }, testEnv());
}

// テストのデータを DB に直接入れる。ユーザーは testUsers のアドレスで作り、テストごとに片付けられるようにする
function testData(testUsers: ReturnType<typeof useTestUsers>) {
	async function insertSlots(
		seminarDayId: string,
		slotRows: ScheduleTemplateSlot[],
	): Promise<string[]> {
		const ids = slotRows.map(() => createId());
		if (slotRows.length > 0) {
			await testUsers
				.db()
				.insert(slots)
				.values(
					slotRows.map((slot, index) => ({
						id: ids[index] ?? createId(),
						seminarDayId,
						...slot,
					})),
				);
		}
		return ids;
	}

	return {
		// 開催日と、kinds の順に枠を作り、枠の id を kinds の順で返す。開始時刻は同じ日の中で重ならないよう 13:00 から 10 分ずつずらす。
		// 時刻は「13 時台」の文字列で作るため、kinds は5個まで（6個目は終了が 13:60 になり、DB のエラーになる）
		async insertDay(
			date: string,
			{
				status = "open",
				closedReason = null,
				kinds = [],
			}: {
				status?: "open" | "closed";
				closedReason?: string | null;
				kinds?: SlotKind[];
			} = {},
		) {
			const id = createId();
			await testUsers
				.db()
				.insert(seminarDays)
				.values({ id, date, status, closedReason });
			return insertSlots(
				id,
				kinds.map((kind, index) => ({
					period: 3,
					startTime: `13:${String(index * 10).padStart(2, "0")}`,
					endTime: `13:${String(index * 10 + 10).padStart(2, "0")}`,
					kind,
				})),
			);
		},

		// 時刻を指定して枠を作る。枠の id を slotRows の順で返す
		async insertDayWithSlots(
			date: string,
			slotRows: ScheduleTemplateSlot[],
			{
				status = "open",
				closedReason = null,
			}: { status?: "open" | "closed"; closedReason?: string | null } = {},
		) {
			const id = createId();
			await testUsers
				.db()
				.insert(seminarDays)
				.values({ id, date, status, closedReason });
			return insertSlots(id, slotRows);
		},

		// プロフィール登録済みのユーザーを作り、id を返す
		async insertUser(displayName: string, grade: Grade | null) {
			const id = createId();
			await testUsers.db().insert(users).values({
				id,
				name: "テスト",
				email: testUsers.uniqueEmail(),
				displayName,
				grade,
			});
			return id;
		},

		async insertReservation(
			slotId: string,
			userId: string,
			status: "reserved" | "done" = "reserved",
		) {
			await testUsers
				.db()
				.insert(reservations)
				.values({ id: createId(), slotId, userId, status });
		},
	};
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
		const [takenSlotId] = await insertDay("2032-03-05", {
			kinds: ["presentation", "presentation", "presentation"],
		});
		const userId = await insertUser("Shibata", "B3");
		await insertReservation(takenSlotId ?? "", userId);

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
		const [doneSlotId] = await insertDay("2032-03-05", {
			kinds: ["presentation", "presentation"],
		});
		const userId = await insertUser("Shibata", "B3");
		await insertReservation(doneSlotId ?? "", userId, "done");

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

describe("GET /api/days/:date（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const { insertDay, insertDayWithSlots, insertUser, insertReservation } =
		testData(testUsers);

	beforeEach(async () => {
		await deleteSeminarDaysBetween(testUsers.db(), TEST_RANGE);
	});

	async function signIn() {
		return signInAsNewUser(testUsers.uniqueEmail());
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
					reservation: null,
				},
				{
					id: presentationId,
					period: 3,
					startTime: "13:30",
					endTime: "13:50",
					kind: "presentation",
					reservation: null,
				},
				{
					id: breakId,
					period: 3,
					startTime: "13:50",
					endTime: "14:00",
					kind: "break",
					reservation: null,
				},
				{
					id: unavailableId,
					period: 4,
					startTime: "15:00",
					endTime: "15:20",
					kind: "unavailable",
					reservation: null,
				},
			],
		});
	});

	test("予約のある枠は予約者の表示名・学年を返し、予約の無い枠は reservation を null で返す", async () => {
		const cookie = await signIn();
		const [takenSlotId, freeSlotId] = await insertDay("2032-03-05", {
			kinds: ["presentation", "presentation"],
		});
		const userId = await insertUser("Shibata", "B3");
		await insertReservation(takenSlotId ?? "", userId);

		const res = await request("/api/days/2032-03-05", cookie);

		// id は insertDay の戻り値（配列の要素なので型の上では undefined がありうる）と比べるため、同じ型にしておく
		const body = (await res.json()) as {
			slots: { id: string | undefined; reservation: unknown }[];
		};
		// 予約あり・なしの両方が1件ずつあることを確かめてから、中身を見る（空振りで通らないように）
		expect(body.slots.map((slot) => slot.id)).toEqual([
			takenSlotId,
			freeSlotId,
		]);
		expect(body.slots.map((slot) => slot.reservation)).toEqual([
			{ displayName: "Shibata", grade: "B3" },
			null,
		]);
	});

	test("教員（学年なし）の予約は grade を null で返す", async () => {
		const cookie = await signIn();
		const [slotId] = await insertDay("2032-03-05", { kinds: ["presentation"] });
		const userId = await insertUser("森谷", null);
		await insertReservation(slotId ?? "", userId);

		const res = await request("/api/days/2032-03-05", cookie);

		expect(await res.json()).toMatchObject({
			slots: [{ reservation: { displayName: "森谷", grade: null } }],
		});
	});

	// 過去の日を開いても、誰が発表したかが分かるようにする
	test("done の予約も予約者を返す", async () => {
		const cookie = await signIn();
		const [slotId] = await insertDay("2032-03-05", { kinds: ["presentation"] });
		const userId = await insertUser("Shibata", "MIDS_B3");
		await insertReservation(slotId ?? "", userId, "done");

		const res = await request("/api/days/2032-03-05", cookie);

		expect(await res.json()).toMatchObject({
			slots: [{ reservation: { displayName: "Shibata", grade: "MIDS_B3" } }],
		});
	});

	test("別の日の枠・予約は含まない", async () => {
		const cookie = await signIn();
		const [slotId] = await insertDay("2032-03-05", { kinds: ["presentation"] });
		const [otherDaySlotId] = await insertDay("2032-03-12", {
			kinds: ["presentation", "break"],
		});
		const userId = await insertUser("Shibata", "B3");
		await insertReservation(otherDaySlotId ?? "", userId);

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
});
