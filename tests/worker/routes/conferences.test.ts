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
import { signInAsNewUser, useTestUsers } from "../../helpers/sign-in";
import { testData } from "../../helpers/test-data";

// API の現在時刻を固定する（実際の日付によって結果が変わらないように）。ほかのテストが使っていない年にする
const NOW = new Date("2047-06-10T12:00:00+09:00");
const TODAY = "2047-06-10";
const YESTERDAY = "2047-06-09";

describe("学会の API（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const {
		insertUser,
		insertConferenceSeries,
		insertConference,
		insertParticipant,
		deleteInsertedConferences,
		signInWithProfile,
	} = testData(testUsers);
	let currentTimeSpy: Mock<typeof clock.currentTime>;

	beforeEach(() => {
		currentTimeSpy = spyOn(clock, "currentTime").mockReturnValue(NOW);
	});

	afterEach(async () => {
		currentTimeSpy.mockRestore();
		await deleteInsertedConferences();
	});

	function get(path: string, cookie?: string) {
		return app.request(
			path,
			{ headers: cookie ? { cookie } : {} },
			testUsers.env(),
		);
	}

	// テスト用 DB はほかのテストファイルと共有するため、一覧はこのテストで作った学会だけに絞って確かめる
	async function idsOf(res: Response, ids: string[]): Promise<string[]> {
		const json = (await res.json()) as { conferences: { id: string }[] };
		return json.conferences
			.map((conference) => conference.id)
			.filter((id) => ids.includes(id));
	}

	describe("GET /api/conferences", () => {
		test("未ログインなら 401 を返す", async () => {
			const res = await get("/api/conferences?status=open");

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test("status が無いなら 400 を返す", async () => {
			const { cookie } = await signInWithProfile();

			const res = await get("/api/conferences", cookie);

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});

		test("status が open / closed 以外なら 400 を返す", async () => {
			const { cookie } = await signInWithProfile();

			const res = await get("/api/conferences?status=all", cookie);

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});

		test("status=open は受付中の学会、status=closed は締切済みの学会を返す", async () => {
			const { cookie } = await signInWithProfile();
			const seriesId = await insertConferenceSeries();
			const open = await insertConference(seriesId, {
				submissionDeadline: TODAY,
			});
			const closed = await insertConference(seriesId, {
				submissionDeadline: YESTERDAY,
			});

			const openRes = await get("/api/conferences?status=open", cookie);
			const closedRes = await get("/api/conferences?status=closed", cookie);

			expect(openRes.status).toBe(200);
			expect(await idsOf(openRes, [open, closed])).toEqual([open]);
			expect(closedRes.status).toBe(200);
			expect(await idsOf(closedRes, [open, closed])).toEqual([closed]);
		});

		test("各学会を、一覧に出す項目・シリーズ名・参加者（表示名・状態）付きで返す", async () => {
			const { cookie } = await signInWithProfile();
			const seriesName = `テストシリーズ ${createId()}`;
			const seriesId = await insertConferenceSeries(seriesName);
			const title = `テスト学会 ${createId()}`;
			const conferenceId = await insertConference(seriesId, {
				title,
				venue: "福岡",
				submissionDeadline: TODAY,
				startDate: "2047-07-01",
				endDate: "2047-07-03",
			});
			const userId = await insertUser("Shibata", "B3");
			await insertParticipant(conferenceId, userId, "submitted");

			const res = await get("/api/conferences?status=open", cookie);
			const json = (await res.json()) as {
				conferences: Record<string, unknown>[];
			};

			expect(json.conferences.find(({ id }) => id === conferenceId)).toEqual({
				id: conferenceId,
				title,
				seriesName,
				venue: "福岡",
				submissionDeadline: TODAY,
				startDate: "2047-07-01",
				endDate: "2047-07-03",
				participants: [{ displayName: "Shibata", status: "submitted" }],
			});
		});

		// 日本時間 6/10 0:00 は UTC では 6/9 15:00。UTC の日付で判定すると、ここで切り替わらない
		describe("日本時間の 0 時の境目", () => {
			test("締切の日の 23:59:59（日本時間）は、まだ受付中", async () => {
				currentTimeSpy.mockReturnValue(new Date("2047-06-09T23:59:59+09:00"));
				const { cookie } = await signInWithProfile();
				const seriesId = await insertConferenceSeries();
				const conferenceId = await insertConference(seriesId, {
					submissionDeadline: YESTERDAY,
				});

				const openRes = await get("/api/conferences?status=open", cookie);
				const closedRes = await get("/api/conferences?status=closed", cookie);

				expect(await idsOf(openRes, [conferenceId])).toEqual([conferenceId]);
				expect(await idsOf(closedRes, [conferenceId])).toEqual([]);
			});

			test("締切の翌日の 0:00（日本時間）からは、締切済み", async () => {
				currentTimeSpy.mockReturnValue(new Date("2047-06-10T00:00:00+09:00"));
				const { cookie } = await signInWithProfile();
				const seriesId = await insertConferenceSeries();
				const conferenceId = await insertConference(seriesId, {
					submissionDeadline: YESTERDAY,
				});

				const openRes = await get("/api/conferences?status=open", cookie);
				const closedRes = await get("/api/conferences?status=closed", cookie);

				expect(await idsOf(openRes, [conferenceId])).toEqual([]);
				expect(await idsOf(closedRes, [conferenceId])).toEqual([conferenceId]);
			});
		});

		// プロフィール登録は求めない（全体連絡の一覧と同じ）。画面はもともとプロフィール登録済みの人しか開けない
		test("プロフィール未登録でも、ログインしていれば 200 を返す", async () => {
			const cookie = await signInAsNewUser(
				testUsers.uniqueEmail(),
				testUsers.env(),
			);

			const res = await get("/api/conferences?status=open", cookie);

			expect(res.status).toBe(200);
		});
	});

	describe("GET /api/conferences/:id", () => {
		test("未ログインなら 401 を返す", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId);

			const res = await get(`/api/conferences/${conferenceId}`);

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test("学会の全項目・シリーズ名・参加者（id・表示名・学年・状態）を返す", async () => {
			const { cookie } = await signInWithProfile();
			const seriesName = `テストシリーズ ${createId()}`;
			const seriesId = await insertConferenceSeries(seriesName);
			const title = `テスト学会 ${createId()}`;
			const updatedAt = new Date("2047-06-01T10:00:00+09:00");
			const conferenceId = await insertConference(seriesId, {
				title,
				venue: "福岡",
				url: "https://example.com/deim",
				submissionDeadline: TODAY,
				submissionNote: "アブスト締切は別",
				startDate: "2047-07-01",
				endDate: "2047-07-03",
				scheduleNote: "昨年は 2/28〜3/2",
				description: "説明",
				note: "メモ",
				updatedAt,
			});
			const userId = await insertUser("Shibata", "B3");
			const participantId = await insertParticipant(
				conferenceId,
				userId,
				"planning",
			);

			const res = await get(`/api/conferences/${conferenceId}`, cookie);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				conference: {
					id: conferenceId,
					title,
					seriesName,
					venue: "福岡",
					url: "https://example.com/deim",
					submissionDeadline: TODAY,
					submissionNote: "アブスト締切は別",
					startDate: "2047-07-01",
					endDate: "2047-07-03",
					scheduleNote: "昨年は 2/28〜3/2",
					description: "説明",
					note: "メモ",
					createdAt: expect.any(String),
					updatedAt: updatedAt.toISOString(),
					participants: [
						{
							id: participantId,
							displayName: "Shibata",
							grade: "B3",
							status: "planning",
						},
					],
				},
			});
		});

		test("存在しない id なら 404 を返す", async () => {
			const { cookie } = await signInWithProfile();

			const res = await get(`/api/conferences/${createId()}`, cookie);

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "CONFERENCE_NOT_FOUND" },
			});
		});

		test("id の形が違う（英数字32文字でない）なら 400 を返す", async () => {
			const { cookie } = await signInWithProfile();

			const res = await get(
				"/api/conferences/0b9a3c1e-5d2f-4a7b-9c8d-1e2f3a4b5c6d",
				cookie,
			);

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});
	});
});
