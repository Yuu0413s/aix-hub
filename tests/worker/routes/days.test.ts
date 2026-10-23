import { beforeEach, describe, expect, test } from "bun:test";
import { between, inArray } from "drizzle-orm";
import type { SlotKind } from "../../../src/shared/schedule-template";
import { createId } from "../../../src/worker/db/id";
import { seminarDays, slots } from "../../../src/worker/db/schema";
import { app } from "../../../src/worker/index";
import { signInAsNewUser, testEnv, useTestUsers } from "../../helpers/sign-in";

// テスト用 DB は共有されているため、ほかのデータを消さないよう、テストで使う期間だけを片付ける。
// ほかのテストが使っていない 2032 年にし、2032-03 の前後の月の境目も含める
const TEST_RANGE = ["2032-02-01", "2032-04-30"] as const;

function request(path: string, cookie?: string) {
	return app.request(path, { headers: cookie ? { cookie } : {} }, testEnv());
}

describe("GET /api/days（テスト用 DB）", () => {
	const testUsers = useTestUsers();

	beforeEach(async () => {
		const db = testUsers.db();
		const days = db
			.select({ id: seminarDays.id })
			.from(seminarDays)
			.where(between(seminarDays.date, ...TEST_RANGE));
		await db.delete(slots).where(inArray(slots.seminarDayId, days));
		await db
			.delete(seminarDays)
			.where(between(seminarDays.date, ...TEST_RANGE));
	});

	async function signIn() {
		return signInAsNewUser(testUsers.uniqueEmail());
	}

	// 開催日と、kinds の順に枠を作る。開始時刻は同じ日の中で重ならないよう 10 分ずつずらす
	async function insertDay(
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
		const db = testUsers.db();
		await db.insert(seminarDays).values({ id, date, status, closedReason });
		if (kinds.length > 0) {
			await db.insert(slots).values(
				kinds.map((kind, index) => ({
					id: createId(),
					seminarDayId: id,
					period: 3,
					startTime: `13:${String(index * 10).padStart(2, "0")}`,
					endTime: `13:${String(index * 10 + 10).padStart(2, "0")}`,
					kind,
				})),
			);
		}
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
