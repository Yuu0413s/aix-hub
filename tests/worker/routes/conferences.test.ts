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
// app.request はパスだけを渡すと http://localhost に送る。ブラウザが同じオリジンから送るときと同じく、Origin を付ける
const SAME_ORIGIN = "http://localhost";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

describe("学会の API（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const {
		insertUser,
		insertConferenceSeries,
		insertConference,
		insertParticipant,
		deleteInsertedConferences,
		signInWithProfile,
		trackConferenceSeries,
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

	function request(
		method: Method,
		path: string,
		{ cookie, body }: { cookie?: string; body?: unknown } = {},
	) {
		return app.request(
			path,
			{
				method,
				headers: {
					origin: SAME_ORIGIN,
					...(cookie ? { cookie } : {}),
					...(body !== undefined ? { "content-type": "application/json" } : {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			},
			testUsers.env(),
		);
	}

	// 登録・編集で送る値。POST と PATCH は同じ形で、すべての項目を送る（空欄は空文字）。
	// title は UNIQUE で、テスト用 DB はほかのテストファイルと共有するため、毎回別の名前にする
	function input(seriesId: string, overrides: Record<string, unknown> = {}) {
		return {
			seriesId,
			title: `テスト学会 ${createId()}`,
			venue: "",
			url: "",
			submissionDeadline: "",
			submissionNote: "",
			startDate: "",
			endDate: "",
			scheduleNote: "",
			description: "",
			note: "",
			...overrides,
		};
	}

	// 学会の詳細を API で取る（登録・編集で保存された値を確かめるため）
	async function fetchConference(conferenceId: string, cookie: string) {
		const res = await get(`/api/conferences/${conferenceId}`, cookie);
		if (res.status !== 200) {
			throw new Error(`学会を取得できませんでした: ${res.status}`);
		}
		const json = (await res.json()) as {
			conference: Record<string, unknown>;
		};
		return json.conference;
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

		test("学会の全項目・シリーズの id と名前・参加者（id・表示名・学年・状態）を返す", async () => {
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
					seriesId,
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

	describe("POST /api/conferences", () => {
		function postConference(body: unknown, cookie?: string) {
			return request("POST", "/api/conferences", { cookie, body });
		}

		test("未ログインなら 401 を返す", async () => {
			const seriesId = await insertConferenceSeries();

			const res = await postConference(input(seriesId));

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test("プロフィール未登録なら 403 と PROFILE_REQUIRED を返す", async () => {
			const seriesId = await insertConferenceSeries();
			const cookie = await signInAsNewUser(
				testUsers.uniqueEmail(),
				testUsers.env(),
			);

			const res = await postConference(input(seriesId), cookie);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: { code: "PROFILE_REQUIRED" },
			});
		});

		test.each(["student", "teacher", "admin"] as const)(
			"%s は学会を登録でき、200 と id を返す",
			async (role) => {
				const { cookie } = await signInWithProfile(role);
				const seriesId = await insertConferenceSeries();
				const body = input(seriesId, {
					venue: "福岡",
					url: "https://example.com/deim",
					submissionDeadline: TODAY,
					submissionNote: "アブスト締切は別",
					startDate: "2047-07-01",
					endDate: "2047-07-03",
					scheduleNote: "昨年は 2/28〜3/2",
					description: "説明",
					note: "メモ",
				});

				const res = await postConference(body, cookie);

				expect(res.status).toBe(200);
				const { id } = (await res.json()) as { id: string };
				expect(await fetchConference(id, cookie)).toMatchObject(body);
			},
		);

		test("http:// で始まる URL も受け付ける", async () => {
			const { cookie } = await signInWithProfile();
			const seriesId = await insertConferenceSeries();

			const res = await postConference(
				input(seriesId, { url: "http://example.com/deim" }),
				cookie,
			);

			expect(res.status).toBe(200);
		});

		test("空欄（空文字・空白だけ）の項目と空の日付は、空文字ではなく null で保存する", async () => {
			const { cookie } = await signInWithProfile();
			const seriesId = await insertConferenceSeries();

			const res = await postConference(
				input(seriesId, { venue: "   ", note: " \n " }),
				cookie,
			);

			expect(res.status).toBe(200);
			const { id } = (await res.json()) as { id: string };
			expect(await fetchConference(id, cookie)).toMatchObject({
				venue: null,
				url: null,
				submissionDeadline: null,
				submissionNote: null,
				startDate: null,
				endDate: null,
				scheduleNote: null,
				description: null,
				note: null,
			});
		});

		test("文字の項目は前後の空白を取り除いて保存する。複数行の項目の中の改行とタブは残す", async () => {
			const { cookie } = await signInWithProfile();
			const seriesId = await insertConferenceSeries();
			const title = `テスト学会 ${createId()}`;

			const res = await postConference(
				input(seriesId, {
					title: `  ${title}  `,
					venue: " 福岡 ",
					description: "\n1行目\n\t2行目\n",
				}),
				cookie,
			);

			expect(res.status).toBe(200);
			const { id } = (await res.json()) as { id: string };
			expect(await fetchConference(id, cookie)).toMatchObject({
				title,
				venue: "福岡",
				description: "1行目\n\t2行目",
			});
		});

		test("存在しないシリーズなら 404 と CONFERENCE_SERIES_NOT_FOUND を返す", async () => {
			const { cookie } = await signInWithProfile();

			const res = await postConference(input(createId()), cookie);

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "CONFERENCE_SERIES_NOT_FOUND" },
			});
		});

		test("同じ学会名の学会があれば 409 と CONFERENCE_TITLE_TAKEN を返す", async () => {
			const { cookie } = await signInWithProfile();
			const seriesId = await insertConferenceSeries();
			const title = `テスト学会 ${createId()}`;
			await insertConference(seriesId, { title });

			const res = await postConference(input(seriesId, { title }), cookie);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "CONFERENCE_TITLE_TAKEN" },
			});
		});

		describe("入力の検証（登録と編集で同じ。通らなければ 400 と VALIDATION_ERROR を返す）", () => {
			// overrides の値が undefined のキーは、JSON にすると消える（キーの省略）
			async function expectValidationError(
				overrides: Record<string, unknown>,
				{ seriesId }: { seriesId?: string } = {},
			) {
				const { cookie } = await signInWithProfile();
				const validSeriesId = seriesId ?? (await insertConferenceSeries());

				const res = await postConference(
					input(validSeriesId, overrides),
					cookie,
				);

				expect(res.status).toBe(400);
				expect(await res.json()).toMatchObject({
					error: { code: "VALIDATION_ERROR" },
				});
			}

			test.each([
				["title が無い", { title: undefined }],
				["title が空", { title: "" }],
				["title が空白だけ", { title: "   " }],
				["seriesId が無い", { seriesId: undefined }],
				["seriesId の形が違う", { seriesId: "deim" }],
				["任意の項目のキーが無い（空欄も空文字で送る）", { venue: undefined }],
				["余計なキーがある", { createdAt: "2047-06-01T00:00:00Z" }],
				["文字の項目が null", { venue: null }],
			])("%s", async (_, overrides) => {
				await expectValidationError(overrides);
			});

			test.each([
				["javascript: の URL", "javascript:alert(1)"],
				["ftp:// の URL", "ftp://example.com"],
				["https:// だけ（URL として読めない）", "https://"],
				["前に文字がある", "see https://example.com"],
			])("url が %s", async (_, url) => {
				await expectValidationError({ url });
			});

			test.each([
				["submissionDeadline", { submissionDeadline: "2047-02-30" }],
				["startDate", { startDate: "2047/07/01" }],
				["endDate", { endDate: "明日" }],
			])("%s が日付として正しくない", async (_, overrides) => {
				await expectValidationError(overrides);
			});

			test("endDate が startDate より前", async () => {
				await expectValidationError({
					startDate: "2047-07-03",
					endDate: "2047-07-02",
				});
			});

			test.each([
				["同じ日", { startDate: "2047-07-01", endDate: "2047-07-01" }],
				["startDate だけ", { startDate: "2047-07-01" }],
				["endDate だけ", { endDate: "2047-07-01" }],
			])("startDate と endDate が %s なら登録できる", async (_, overrides) => {
				const { cookie } = await signInWithProfile();
				const seriesId = await insertConferenceSeries();

				const res = await postConference(input(seriesId, overrides), cookie);

				expect(res.status).toBe(200);
			});

			// 1行の項目（一覧や詳細に1行で出す）は、改行・NUL などの制御文字や、ゼロ幅スペースなどの書式文字を受け付けない
			test.each([
				["title", "改行", "学会\n2047"],
				["title", "NUL", "学会\u00002047"],
				["title", "ゼロ幅スペース", "学会\u200b2047"],
				["venue", "改行", "福岡\n博多"],
				["url", "改行", "https://example.com/\nx"],
			])("%s に %s がある", async (key, _, value) => {
				await expectValidationError({ [key]: value });
			});

			// 複数行の項目も、改行とタブ以外の制御文字は受け付けない
			test("description に NUL がある", async () => {
				await expectValidationError({ description: "説明\u0000" });
			});

			// 上限ちょうどは登録でき、1文字超えると 400。絵文字は1つを1文字と数える
			describe.each([
				["title", 100],
				["venue", 100],
				["submissionNote", 1000],
				["scheduleNote", 1000],
				["description", 1000],
				["note", 1000],
			])("%s は %d 文字まで", (key, maxLength) => {
				// title は UNIQUE のため、ほかの学会と重ならない文字列で上限まで埋める
				function text(length: number) {
					const head = key === "title" ? createId() : "";
					return head + "😀".repeat(length - head.length);
				}

				test("上限ちょうどなら登録できる", async () => {
					const { cookie } = await signInWithProfile();
					const seriesId = await insertConferenceSeries();

					const res = await postConference(
						input(seriesId, { [key]: text(maxLength) }),
						cookie,
					);

					expect(res.status).toBe(200);
				});

				test("1文字超えると 400", async () => {
					await expectValidationError({ [key]: text(maxLength + 1) });
				});
			});

			test("url は 2000 文字まで", async () => {
				const { cookie } = await signInWithProfile();
				const seriesId = await insertConferenceSeries();
				const prefix = "https://example.com/";
				const url = (length: number) =>
					prefix + "a".repeat(length - prefix.length);

				const ok = await postConference(
					input(seriesId, { url: url(2000) }),
					cookie,
				);
				expect(ok.status).toBe(200);

				await expectValidationError({ url: url(2001) }, { seriesId });
			});
		});
	});

	describe("PATCH /api/conferences/:id", () => {
		function patchConference(id: string, body: unknown, cookie?: string) {
			return request("PATCH", `/api/conferences/${id}`, { cookie, body });
		}

		test("未ログインなら 401 を返す", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId);

			const res = await patchConference(conferenceId, input(seriesId));

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test("プロフィール未登録なら 403 と PROFILE_REQUIRED を返す", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId);
			const cookie = await signInAsNewUser(
				testUsers.uniqueEmail(),
				testUsers.env(),
			);

			const res = await patchConference(conferenceId, input(seriesId), cookie);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: { code: "PROFILE_REQUIRED" },
			});
		});

		test("student でも、すべての項目を書き換えられ、200 と id を返す。空欄は null にし、更新日時は新しくなる", async () => {
			const { cookie } = await signInWithProfile("student");
			const seriesId = await insertConferenceSeries();
			const otherSeriesId = await insertConferenceSeries();
			// 更新後の更新日時は実際の今になるため、元の更新日時は実際の今より前にしておく
			const updatedAt = new Date("2020-01-01T10:00:00+09:00");
			const conferenceId = await insertConference(seriesId, {
				venue: "福岡",
				note: "元のメモ",
				updatedAt,
			});
			const body = input(otherSeriesId, {
				url: "https://example.com/new",
				submissionDeadline: TODAY,
				description: "新しい説明",
			});

			const res = await patchConference(conferenceId, body, cookie);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ id: conferenceId });
			const after = await fetchConference(conferenceId, cookie);
			expect(after).toMatchObject({
				...body,
				venue: null,
				submissionNote: null,
				startDate: null,
				endDate: null,
				scheduleNote: null,
				note: null,
			});
			expect(new Date(String(after.updatedAt)).getTime()).toBeGreaterThan(
				updatedAt.getTime(),
			);
		});

		test("学会名を今のままにして書き換えられる", async () => {
			const { cookie } = await signInWithProfile();
			const seriesId = await insertConferenceSeries();
			const title = `テスト学会 ${createId()}`;
			const conferenceId = await insertConference(seriesId, { title });

			const res = await patchConference(
				conferenceId,
				input(seriesId, { title, venue: "東京" }),
				cookie,
			);

			expect(res.status).toBe(200);
		});

		test("存在しない id なら 404 と CONFERENCE_NOT_FOUND を返す", async () => {
			const { cookie } = await signInWithProfile();
			const seriesId = await insertConferenceSeries();

			const res = await patchConference(createId(), input(seriesId), cookie);

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "CONFERENCE_NOT_FOUND" },
			});
		});

		test("id の形が違うなら 400 と VALIDATION_ERROR を返す", async () => {
			const { cookie } = await signInWithProfile();
			const seriesId = await insertConferenceSeries();

			const res = await patchConference("deim-2047", input(seriesId), cookie);

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});

		test("存在しないシリーズなら 404 と CONFERENCE_SERIES_NOT_FOUND を返し、学会は変わらない", async () => {
			const { cookie } = await signInWithProfile();
			const seriesId = await insertConferenceSeries();
			const title = `テスト学会 ${createId()}`;
			const conferenceId = await insertConference(seriesId, { title });

			const res = await patchConference(
				conferenceId,
				input(createId(), { venue: "東京" }),
				cookie,
			);

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "CONFERENCE_SERIES_NOT_FOUND" },
			});
			expect(await fetchConference(conferenceId, cookie)).toMatchObject({
				seriesId,
				title,
				venue: null,
			});
		});

		test("ほかの学会と同じ学会名なら 409 と CONFERENCE_TITLE_TAKEN を返す", async () => {
			const { cookie } = await signInWithProfile();
			const seriesId = await insertConferenceSeries();
			const otherTitle = `テスト学会 ${createId()}`;
			await insertConference(seriesId, { title: otherTitle });
			const conferenceId = await insertConference(seriesId);

			const res = await patchConference(
				conferenceId,
				input(seriesId, { title: otherTitle }),
				cookie,
			);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "CONFERENCE_TITLE_TAKEN" },
			});
		});

		// 検証は登録と同じスキーマを使う。代表として、変えない項目の省略と開催日の前後を確かめる
		test.each([
			["項目が欠けている（変えない項目も送る）", { note: undefined }],
			["endDate が startDate より前", { startDate: TODAY, endDate: YESTERDAY }],
		])("%s なら 400 と VALIDATION_ERROR を返す", async (_, overrides) => {
			const { cookie } = await signInWithProfile();
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId);

			const res = await patchConference(
				conferenceId,
				input(seriesId, overrides),
				cookie,
			);

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});
	});

	describe("DELETE /api/conferences/:id", () => {
		function deleteConference(id: string, cookie?: string) {
			return request("DELETE", `/api/conferences/${id}`, { cookie });
		}

		test("未ログインなら 401 を返し、学会は残る", async () => {
			const { cookie } = await signInWithProfile();
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId);

			const res = await deleteConference(conferenceId);

			expect(res.status).toBe(401);
			expect(await fetchConference(conferenceId, cookie)).toMatchObject({
				id: conferenceId,
			});
		});

		test("プロフィール未登録なら 403 と PROFILE_REQUIRED を返す", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId);
			const cookie = await signInAsNewUser(
				testUsers.uniqueEmail(),
				testUsers.env(),
			);

			const res = await deleteConference(conferenceId, cookie);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: { code: "PROFILE_REQUIRED" },
			});
		});

		test("student でも、参加者のいる学会を削除でき、200 と id を返す", async () => {
			const { cookie } = await signInWithProfile("student");
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId);
			const userId = await insertUser("Shibata", "B3");
			await insertParticipant(conferenceId, userId, "planning");

			const res = await deleteConference(conferenceId, cookie);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ id: conferenceId });
			const detail = await get(`/api/conferences/${conferenceId}`, cookie);
			expect(detail.status).toBe(404);
		});

		test("存在しない id なら 404 と CONFERENCE_NOT_FOUND を返す", async () => {
			const { cookie } = await signInWithProfile();

			const res = await deleteConference(createId(), cookie);

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "CONFERENCE_NOT_FOUND" },
			});
		});

		test("id の形が違うなら 400 と VALIDATION_ERROR を返す", async () => {
			const { cookie } = await signInWithProfile();

			const res = await deleteConference("deim-2047", cookie);

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});
	});

	describe("GET /api/conference-series", () => {
		test("未ログインなら 401 を返す", async () => {
			const res = await get("/api/conference-series");

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test("シリーズの id と名前を、名前の順に返す", async () => {
			const { cookie } = await signInWithProfile();
			const prefix = `テストシリーズ ${createId()}`;
			const b = await insertConferenceSeries(`${prefix} B`);
			const a = await insertConferenceSeries(`${prefix} A`);

			const res = await get("/api/conference-series", cookie);

			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				series: { id: string; name: string }[];
			};
			// テスト用 DB はほかのテストファイルと共有するため、このテストで作ったシリーズだけに絞って確かめる
			expect(json.series.filter(({ id }) => [a, b].includes(id))).toEqual([
				{ id: a, name: `${prefix} A` },
				{ id: b, name: `${prefix} B` },
			]);
		});
	});

	describe("POST /api/conference-series", () => {
		function postSeries(body: unknown, cookie?: string) {
			return request("POST", "/api/conference-series", { cookie, body });
		}

		test("未ログインなら 401 を返す", async () => {
			const res = await postSeries({ name: `テストシリーズ ${createId()}` });

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test("プロフィール未登録なら 403 と PROFILE_REQUIRED を返す", async () => {
			const cookie = await signInAsNewUser(
				testUsers.uniqueEmail(),
				testUsers.env(),
			);

			const res = await postSeries(
				{ name: `テストシリーズ ${createId()}` },
				cookie,
			);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: { code: "PROFILE_REQUIRED" },
			});
		});

		test("student でもシリーズを作れ、作ったシリーズ（id と、前後の空白を除いた名前）を返す", async () => {
			const { cookie } = await signInWithProfile("student");
			const name = `テストシリーズ ${createId()}`;

			const res = await postSeries({ name: `  ${name}  ` }, cookie);

			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				series: { id: string; name: string };
			};
			trackConferenceSeries(json.series.id);
			expect(json).toEqual({ series: { id: expect.any(String), name } });
			// 作ったシリーズは一覧に出て、そのまま学会の登録に使える
			const list = (await (
				await get("/api/conference-series", cookie)
			).json()) as { series: { id: string; name: string }[] };
			expect(list.series).toContainEqual(json.series);
			const conference = await request("POST", "/api/conferences", {
				cookie,
				body: input(json.series.id),
			});
			expect(conference.status).toBe(200);
		});

		test("同じ名前のシリーズがあれば 409 と CONFERENCE_SERIES_NAME_TAKEN を返す", async () => {
			const { cookie } = await signInWithProfile();
			const name = `テストシリーズ ${createId()}`;
			await insertConferenceSeries(name);

			const res = await postSeries({ name }, cookie);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "CONFERENCE_SERIES_NAME_TAKEN" },
			});
		});

		test.each([
			["name が無い", {}],
			["name が空", { name: "" }],
			["name が空白だけ", { name: "   " }],
			["name に改行がある", { name: "DEIM\n2047" }],
			["name が 101 文字", { name: "😀".repeat(101) }],
			[
				"余計なキーがある",
				{ name: `テストシリーズ ${createId()}`, id: createId() },
			],
		])("%s なら 400 と VALIDATION_ERROR を返す", async (_, body) => {
			const { cookie } = await signInWithProfile();

			const res = await postSeries(body, cookie);

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});

		test("name は 100 文字まで作れる", async () => {
			const { cookie } = await signInWithProfile();
			const head = createId();
			const name = head + "😀".repeat(100 - head.length);

			const res = await postSeries({ name }, cookie);

			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				series: { id: string; name: string };
			};
			trackConferenceSeries(json.series.id);
			expect(json.series.name).toBe(name);
		});
	});
});
