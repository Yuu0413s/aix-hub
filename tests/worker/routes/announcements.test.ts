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
import { testData } from "../../helpers/test-data";
import { deleteSeminarDaysBetween } from "../../helpers/test-db";

// API の現在時刻を固定し、その前後の日を使う（実際の日付によって結果が変わらないように）。ほかのテストが使っていない年にする
const TEST_RANGE = ["2036-03-01", "2036-03-31"] as const;
const NOW = new Date("2036-03-12T12:00:00+09:00");
const TODAY = "2036-03-12";
const YESTERDAY = "2036-03-11";
const TOMORROW = "2036-03-13";
// 連絡を書く開催日（今日より後）
const DAY = "2036-03-20";
const OTHER_DAY = "2036-03-27";
const PAST_DAY = "2036-03-06";
// 開催日ではない日（開催日を作らない）
const NOT_SEMINAR_DAY = "2036-03-21";
// 連絡の作成日時。表示期間に関係しないテストで使う（今日より前）
const CREATED_AT = new Date("2036-03-01T10:00:00+09:00");
// app.request はパスだけを渡すと http://localhost に送る。ブラウザが同じオリジンから送るときと同じく、Origin を付ける
const SAME_ORIGIN = "http://localhost";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

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
		testEnv(),
	);
}

// 作成・編集で送る値。POST と PATCH は同じ形で、すべての項目を送る（空は null）
function input(overrides: Record<string, unknown> = {}) {
	return {
		date: DAY,
		body: "来週は発表順を変更します",
		displayFrom: null,
		displayUntil: null,
		...overrides,
	};
}

async function idsOf(res: Response): Promise<string[]> {
	const json = (await res.json()) as { announcements: { id: string }[] };
	return json.announcements.map((announcement) => announcement.id);
}

describe("全体連絡の API（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const {
		insertDay,
		insertUser,
		insertAnnouncement,
		findAnnouncement,
		findAnnouncementsByAuthor,
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

	describe("announcements テーブルの CHECK 制約", () => {
		test("開始日が終了日より後の行は DB に入れられない", async () => {
			await insertDay(DAY);
			const authorId = await insertUser("森谷", null, "teacher");

			await expect(
				insertAnnouncement({
					date: DAY,
					authorId,
					createdAt: CREATED_AT,
					displayFrom: TOMORROW,
					displayUntil: TODAY,
				}),
			).rejects.toThrow();
			expect(await findAnnouncementsByAuthor(authorId)).toEqual([]);
		});

		test("開始日と終了日が同じ日なら入れられる", async () => {
			await insertDay(DAY);
			const authorId = await insertUser("森谷", null, "teacher");

			const id = await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: CREATED_AT,
				displayFrom: TODAY,
				displayUntil: TODAY,
			});

			expect(await findAnnouncement(id)).toBeDefined();
		});
	});

	describe("POST /api/announcements", () => {
		function postAnnouncement(body: unknown, cookie?: string) {
			return request("POST", "/api/announcements", { cookie, body });
		}

		test("未ログインなら 401 を返す", async () => {
			await insertDay(DAY);

			const res = await postAnnouncement(input());

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test("プロフィール未登録なら 403 と PROFILE_REQUIRED を返す", async () => {
			await insertDay(DAY);
			const cookie = await signInAsNewUser(testUsers.uniqueEmail());

			const res = await postAnnouncement(input(), cookie);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: { code: "PROFILE_REQUIRED" },
			});
		});

		test("student なら 403 と FORBIDDEN を返し、連絡は作られない", async () => {
			await insertDay(DAY);
			const { cookie, userId } = await signInWithProfile("student");

			const res = await postAnnouncement(input(), cookie);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: { code: "FORBIDDEN" },
			});
			expect(await findAnnouncementsByAuthor(userId)).toEqual([]);
		});

		test.each(["teacher", "admin"] as const)(
			"%s は作成でき、200 と id を返す。作成日時は API の現在時刻になる",
			async (role) => {
				await insertDay(DAY);
				const { cookie, userId } = await signInWithProfile(role);

				const res = await postAnnouncement(input(), cookie);

				expect(res.status).toBe(200);
				const { id } = (await res.json()) as { id: string };
				expect(await findAnnouncement(id)).toMatchObject({
					authorId: userId,
					body: "来週は発表順を変更します",
					displayFrom: null,
					displayUntil: null,
					createdAt: NOW,
				});
			},
		);

		test("開始日・終了日を指定すると、その値で保存する", async () => {
			await insertDay(DAY);
			const { cookie } = await signInWithProfile("teacher");

			const res = await postAnnouncement(
				input({ displayFrom: TOMORROW, displayUntil: DAY }),
				cookie,
			);

			expect(res.status).toBe(200);
			const { id } = (await res.json()) as { id: string };
			expect(await findAnnouncement(id)).toMatchObject({
				displayFrom: TOMORROW,
				displayUntil: DAY,
			});
		});

		test("片方だけ指定しても保存できる", async () => {
			await insertDay(DAY);
			const { cookie } = await signInWithProfile("teacher");

			const fromOnly = await postAnnouncement(
				input({ displayFrom: TOMORROW }),
				cookie,
			);
			const untilOnly = await postAnnouncement(
				input({ displayUntil: DAY }),
				cookie,
			);

			expect(fromOnly.status).toBe(200);
			expect(untilOnly.status).toBe(200);
		});

		test("選んだ開催日に紐づけて保存する", async () => {
			await insertDay(DAY);
			await insertDay(OTHER_DAY);
			const { cookie } = await signInWithProfile("teacher");

			const res = await postAnnouncement(input({ date: OTHER_DAY }), cookie);

			expect(res.status).toBe(200);
			const { id } = (await res.json()) as { id: string };
			// 開催日の日付は GET の date で確かめる（DB には開催日の id で入る）
			const current = await request("GET", "/api/announcements?current", {
				cookie,
			});
			expect(await current.json()).toMatchObject({
				announcements: [{ id, date: OTHER_DAY }],
			});
		});

		test("過去の開催日でも作成できる（候補を今日以降に絞るのは画面）", async () => {
			await insertDay(PAST_DAY);
			const { cookie } = await signInWithProfile("teacher");

			const res = await postAnnouncement(input({ date: PAST_DAY }), cookie);

			expect(res.status).toBe(200);
		});

		test("開催日でない日付なら 404 と SEMINAR_DAY_NOT_FOUND を返し、連絡は作られない", async () => {
			const { cookie, userId } = await signInWithProfile("teacher");

			const res = await postAnnouncement(
				input({ date: NOT_SEMINAR_DAY }),
				cookie,
			);

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "SEMINAR_DAY_NOT_FOUND" },
			});
			expect(await findAnnouncementsByAuthor(userId)).toEqual([]);
		});

		test.each([
			["開始日が終了日より後", { displayFrom: TOMORROW, displayUntil: TODAY }],
			["開催日が実在しない日付", { date: "2036-02-30" }],
			["開始日が実在しない日付", { displayFrom: "2036-02-30" }],
			["終了日が日付の形でない", { displayUntil: "3月20日" }],
			["本文が空", { body: "" }],
			["本文が空白だけ", { body: "  \n\t " }],
			["本文が 1001 文字", { body: "あ".repeat(1001) }],
			["本文に NUL を含む", { body: "連絡\u0000" }],
			["本文にゼロ幅スペースを含む", { body: "連​絡" }],
			["本文に改行以外の制御文字（CR）を含む", { body: "連絡\r\n" }],
		])(
			"%s なら 400 と VALIDATION_ERROR を返し、連絡は作られない",
			async (_, overrides) => {
				await insertDay(DAY);
				const { cookie, userId } = await signInWithProfile("teacher");

				const res = await postAnnouncement(input(overrides), cookie);

				expect(res.status).toBe(400);
				expect(await res.json()).toMatchObject({
					error: { code: "VALIDATION_ERROR" },
				});
				expect(await findAnnouncementsByAuthor(userId)).toEqual([]);
			},
		);

		test("開始日と終了日が同じ日なら作成できる", async () => {
			await insertDay(DAY);
			const { cookie } = await signInWithProfile("teacher");

			const res = await postAnnouncement(
				input({ displayFrom: TOMORROW, displayUntil: TOMORROW }),
				cookie,
			);

			expect(res.status).toBe(200);
		});

		test("本文は 1000 文字まで作成できる。絵文字は1つを1文字と数える", async () => {
			await insertDay(DAY);
			const { cookie } = await signInWithProfile("teacher");

			const kana = await postAnnouncement(
				input({ body: "あ".repeat(1000) }),
				cookie,
			);
			// UTF-16 では 2000 になるが、1000 文字として通る
			const emoji = await postAnnouncement(
				input({ body: "😀".repeat(1000) }),
				cookie,
			);

			expect(kana.status).toBe(200);
			expect(emoji.status).toBe(200);
		});

		test("本文の改行とタブはそのまま保存し、前後の空白は取り除く", async () => {
			await insertDay(DAY);
			const { cookie } = await signInWithProfile("teacher");

			const res = await postAnnouncement(
				input({ body: "  1行目\n\t2行目  \n" }),
				cookie,
			);

			expect(res.status).toBe(200);
			const { id } = (await res.json()) as { id: string };
			expect(await findAnnouncement(id)).toMatchObject({
				body: "1行目\n\t2行目",
			});
		});

		test.each([
			["知らない項目がある", { ...input(), title: "件名" }],
			[
				"項目が欠けている（空の項目も null で送る）",
				{ date: DAY, body: "連絡" },
			],
		])("%s なら 400 と VALIDATION_ERROR を返す", async (_, body) => {
			await insertDay(DAY);
			const { cookie } = await signInWithProfile("teacher");

			const res = await postAnnouncement(body, cookie);

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});
	});

	describe("GET /api/announcements?current", () => {
		function getCurrent(cookie?: string) {
			return request("GET", "/api/announcements?current", { cookie });
		}

		test("未ログインなら 401 を返す", async () => {
			const res = await getCurrent();

			expect(res.status).toBe(401);
		});

		test("current が無いなら 400 と VALIDATION_ERROR を返す", async () => {
			const { cookie } = await signInWithProfile("student");

			const res = await request("GET", "/api/announcements", { cookie });

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});

		test("連絡が無いなら空の一覧を返す", async () => {
			const { cookie } = await signInWithProfile("student");

			const res = await getCurrent(cookie);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ announcements: [] });
		});

		test("返す項目: id・開催日・本文・開始日・終了日・書いた人の表示名・編集できるか", async () => {
			await insertDay(DAY);
			const authorId = await insertUser("森谷", null, "teacher");
			const id = await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: CREATED_AT,
				body: "1行目\n2行目",
				displayFrom: YESTERDAY,
				displayUntil: DAY,
			});
			const { cookie } = await signInWithProfile("student");

			const res = await getCurrent(cookie);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				announcements: [
					{
						id,
						date: DAY,
						body: "1行目\n2行目",
						displayFrom: YESTERDAY,
						displayUntil: DAY,
						authorDisplayName: "森谷",
						isEditable: false,
					},
				],
			});
		});

		test("開始日の当日・終了日の当日は返し、開始日が明日・終了日が昨日の連絡は返さない", async () => {
			await insertDay(DAY);
			const authorId = await insertUser("森谷", null, "teacher");
			const startsToday = await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: CREATED_AT,
				displayFrom: TODAY,
				displayUntil: DAY,
			});
			const endsToday = await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: CREATED_AT,
				displayFrom: YESTERDAY,
				displayUntil: TODAY,
			});
			await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: CREATED_AT,
				displayFrom: TOMORROW,
				displayUntil: DAY,
			});
			await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: CREATED_AT,
				displayFrom: "2036-03-05",
				displayUntil: YESTERDAY,
			});
			const { cookie } = await signInWithProfile("student");

			const res = await getCurrent(cookie);

			expect((await idsOf(res)).sort()).toEqual(
				[startsToday, endsToday].sort(),
			);
		});

		test("開始日が空なら、作成日（日本時間）から返す", async () => {
			await insertDay(DAY);
			const authorId = await insertUser("森谷", null, "teacher");
			// 日本時間の今日の 0:00（UTC では前日の 15:00）に作成。日本時間では今日なので返す
			const createdTodayInTokyo = await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: new Date("2036-03-12T00:00:00+09:00"),
			});
			// 日本時間の明日の 0:00（UTC ではまだ今日の 15:00）に作成。UTC の日付で比べると今日になり返してしまう
			await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: new Date("2036-03-13T00:00:00+09:00"),
			});
			const { cookie } = await signInWithProfile("student");

			const res = await getCurrent(cookie);

			expect(await idsOf(res)).toEqual([createdTodayInTokyo]);
		});

		test("終了日が空なら、開催日の当日まで返す", async () => {
			await insertDay(TODAY);
			await insertDay(YESTERDAY);
			const authorId = await insertUser("森谷", null, "teacher");
			const seminarToday = await insertAnnouncement({
				date: TODAY,
				authorId,
				createdAt: CREATED_AT,
			});
			await insertAnnouncement({
				date: YESTERDAY,
				authorId,
				createdAt: CREATED_AT,
			});
			const { cookie } = await signInWithProfile("student");

			const res = await getCurrent(cookie);

			expect(await idsOf(res)).toEqual([seminarToday]);
		});

		test("今日は日本時間で決める（日本時間の 0:00 をまたぐと、終了日が昨日になった連絡は返さない）", async () => {
			await insertDay(DAY);
			const authorId = await insertUser("森谷", null, "teacher");
			const endsToday = await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: CREATED_AT,
				displayUntil: TODAY,
			});
			const { cookie } = await signInWithProfile("student");

			// 日本時間の今日の 23:59（UTC でも今日）
			currentTimeSpy.mockReturnValue(new Date("2036-03-12T23:59:00+09:00"));
			const beforeMidnight = await getCurrent(cookie);
			// 日本時間の明日の 0:00（UTC ではまだ今日の 15:00）
			currentTimeSpy.mockReturnValue(new Date("2036-03-13T00:00:00+09:00"));
			const afterMidnight = await getCurrent(cookie);

			expect(await idsOf(beforeMidnight)).toEqual([endsToday]);
			expect(await idsOf(afterMidnight)).toEqual([]);
		});

		test("開始日の昇順で並べる。開始日が空なら作成日で並べ、同じ日なら作成した順にする", async () => {
			await insertDay(DAY);
			const authorId = await insertUser("森谷", null, "teacher");
			// 実際の開始日: 3/12
			const startsMarch12 = await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: new Date("2036-03-02T10:00:00+09:00"),
				displayFrom: TODAY,
			});
			// 実際の開始日: 3/11（開始日が空なので作成日）。作成は 3/11
			const createdMarch11 = await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: new Date("2036-03-11T09:00:00+09:00"),
			});
			// 実際の開始日: 3/11。作成は 3/5 なので、上の連絡より先
			const startsMarch11 = await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: new Date("2036-03-05T10:00:00+09:00"),
				displayFrom: YESTERDAY,
			});
			// 実際の開始日: 3/10
			const startsMarch10 = await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: new Date("2036-03-08T10:00:00+09:00"),
				displayFrom: "2036-03-10",
			});
			const { cookie } = await signInWithProfile("student");

			const res = await getCurrent(cookie);

			expect(await idsOf(res)).toEqual([
				startsMarch10,
				startsMarch11,
				createdMarch11,
				startsMarch12,
			]);
		});

		describe("isEditable（編集できるか）", () => {
			async function setUpAnnouncementOf(authorId: string) {
				await insertDay(DAY);
				return insertAnnouncement({
					date: DAY,
					authorId,
					createdAt: CREATED_AT,
				});
			}

			async function isEditableFor(cookie: string) {
				const res = await getCurrent(cookie);
				const json = (await res.json()) as {
					announcements: { isEditable: boolean }[];
				};
				expect(json.announcements).toHaveLength(1);
				return json.announcements[0]?.isEditable;
			}

			test("書いた本人には true", async () => {
				const { cookie, userId } = await signInWithProfile("teacher");
				await setUpAnnouncementOf(userId);

				expect(await isEditableFor(cookie)).toBe(true);
			});

			test("admin には他人の連絡でも true", async () => {
				const authorId = await insertUser("森谷", null, "teacher");
				await setUpAnnouncementOf(authorId);
				const { cookie } = await signInWithProfile("admin");

				expect(await isEditableFor(cookie)).toBe(true);
			});

			test.each(["teacher", "student"] as const)(
				"他人の連絡は %s には false",
				async (role) => {
					const authorId = await insertUser("森谷", null, "teacher");
					await setUpAnnouncementOf(authorId);
					const { cookie } = await signInWithProfile(role);

					expect(await isEditableFor(cookie)).toBe(false);
				},
			);
		});
	});

	describe("GET /api/announcements/upcoming", () => {
		function getUpcoming(cookie?: string) {
			return request("GET", "/api/announcements/upcoming", { cookie });
		}

		test("未ログインなら 401 を返す", async () => {
			const res = await getUpcoming();

			expect(res.status).toBe(401);
		});

		test("teacher には、自分が書いた表示前の連絡だけを返す（表示中・他人の連絡は含まない）", async () => {
			await insertDay(DAY);
			const { cookie, userId } = await signInWithProfile("teacher");
			const otherId = await insertUser("森谷", null, "teacher");
			const ownUpcoming = await insertAnnouncement({
				date: DAY,
				authorId: userId,
				createdAt: CREATED_AT,
				displayFrom: TOMORROW,
			});
			// 表示中
			await insertAnnouncement({
				date: DAY,
				authorId: userId,
				createdAt: CREATED_AT,
				displayFrom: TODAY,
			});
			// 他人の表示前
			await insertAnnouncement({
				date: DAY,
				authorId: otherId,
				createdAt: CREATED_AT,
				displayFrom: TOMORROW,
			});

			const res = await getUpcoming(cookie);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				announcements: [
					{
						id: ownUpcoming,
						date: DAY,
						body: "連絡",
						displayFrom: TOMORROW,
						displayUntil: null,
						authorDisplayName: "テスト",
						isEditable: true,
					},
				],
			});
		});

		test("admin には、全員の表示前の連絡を開始日の昇順で返す", async () => {
			await insertDay(DAY);
			const { cookie, userId } = await signInWithProfile("admin");
			const otherId = await insertUser("森谷", null, "teacher");
			const othersLater = await insertAnnouncement({
				date: DAY,
				authorId: otherId,
				createdAt: CREATED_AT,
				displayFrom: "2036-03-15",
			});
			const ownSooner = await insertAnnouncement({
				date: DAY,
				authorId: userId,
				createdAt: CREATED_AT,
				displayFrom: "2036-03-14",
			});

			const res = await getUpcoming(cookie);

			expect(await idsOf(res)).toEqual([ownSooner, othersLater]);
		});

		test("student には、他人の表示前の連絡を返さない", async () => {
			await insertDay(DAY);
			const authorId = await insertUser("森谷", null, "teacher");
			await insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: CREATED_AT,
				displayFrom: TOMORROW,
			});
			const { cookie } = await signInWithProfile("student");

			const res = await getUpcoming(cookie);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ announcements: [] });
		});
	});

	describe("PATCH /api/announcements/:id", () => {
		function patchAnnouncement(id: string, body: unknown, cookie?: string) {
			return request("PATCH", `/api/announcements/${id}`, { cookie, body });
		}

		async function setUpAnnouncementOf(authorId: string) {
			await insertDay(DAY);
			await insertDay(OTHER_DAY);
			return insertAnnouncement({
				date: DAY,
				authorId,
				createdAt: CREATED_AT,
				body: "元の本文",
			});
		}

		const edited = input({
			date: OTHER_DAY,
			body: "書き換えた本文",
			displayFrom: TODAY,
			displayUntil: OTHER_DAY,
		});

		test("未ログインなら 401 を返す", async () => {
			const authorId = await insertUser("森谷", null, "teacher");
			const id = await setUpAnnouncementOf(authorId);

			const res = await patchAnnouncement(id, edited);

			expect(res.status).toBe(401);
		});

		test("書いた本人は、開催日を含むすべての項目を書き換えられる。作成日時は変わらず、更新日時は変わる", async () => {
			const { cookie, userId } = await signInWithProfile("teacher");
			const id = await setUpAnnouncementOf(userId);

			const res = await patchAnnouncement(id, edited, cookie);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ id });
			const after = await findAnnouncement(id);
			expect(after).toMatchObject({
				body: "書き換えた本文",
				displayFrom: TODAY,
				displayUntil: OTHER_DAY,
				createdAt: CREATED_AT,
			});
			expect(after?.updatedAt).not.toEqual(CREATED_AT);
			const current = await request("GET", "/api/announcements?current", {
				cookie,
			});
			expect(await current.json()).toMatchObject({
				announcements: [{ id, date: OTHER_DAY }],
			});
		});

		test("admin は他人の連絡を書き換えられる", async () => {
			const authorId = await insertUser("森谷", null, "teacher");
			const id = await setUpAnnouncementOf(authorId);
			const { cookie } = await signInWithProfile("admin");

			const res = await patchAnnouncement(id, edited, cookie);

			expect(res.status).toBe(200);
			expect(await findAnnouncement(id)).toMatchObject({
				body: "書き換えた本文",
			});
		});

		test("書いた本人なら、役割が student に変わっていても書き換えられる", async () => {
			// teacher のときに書き、そのあと student に変わった人を、student の作者として作る
			const { cookie, userId } = await signInWithProfile("student");
			const id = await setUpAnnouncementOf(userId);

			const res = await patchAnnouncement(id, edited, cookie);

			expect(res.status).toBe(200);
			expect(await findAnnouncement(id)).toMatchObject({
				body: "書き換えた本文",
			});
		});

		test.each(["teacher", "student"] as const)(
			"他人の連絡なら、%s には 403 と FORBIDDEN を返し、内容は変わらない",
			async (role) => {
				const authorId = await insertUser("森谷", null, "teacher");
				const id = await setUpAnnouncementOf(authorId);
				const { cookie } = await signInWithProfile(role);

				const res = await patchAnnouncement(id, edited, cookie);

				expect(res.status).toBe(403);
				expect(await res.json()).toMatchObject({
					error: { code: "FORBIDDEN" },
				});
				expect(await findAnnouncement(id)).toMatchObject({ body: "元の本文" });
			},
		);

		test("存在しない id なら 404 と ANNOUNCEMENT_NOT_FOUND を返す", async () => {
			await insertDay(DAY);
			const { cookie } = await signInWithProfile("admin");

			const res = await patchAnnouncement(createId(), input(), cookie);

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "ANNOUNCEMENT_NOT_FOUND" },
			});
		});

		test("id の形が不正なら 400 と VALIDATION_ERROR を返す", async () => {
			await insertDay(DAY);
			const { cookie } = await signInWithProfile("admin");

			const res = await patchAnnouncement("not-an-id", input(), cookie);

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});

		test("開催日でない日付なら 404 と SEMINAR_DAY_NOT_FOUND を返し、内容は変わらない", async () => {
			const { cookie, userId } = await signInWithProfile("teacher");
			const id = await setUpAnnouncementOf(userId);

			const res = await patchAnnouncement(
				id,
				input({ date: NOT_SEMINAR_DAY, body: "書き換えた本文" }),
				cookie,
			);

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "SEMINAR_DAY_NOT_FOUND" },
			});
			expect(await findAnnouncement(id)).toMatchObject({ body: "元の本文" });
		});

		test("他人の連絡で、開催日でない日付も送ったときは、権限の 403 を返す", async () => {
			const authorId = await insertUser("森谷", null, "teacher");
			const id = await setUpAnnouncementOf(authorId);
			const { cookie } = await signInWithProfile("teacher");

			const res = await patchAnnouncement(
				id,
				input({ date: NOT_SEMINAR_DAY }),
				cookie,
			);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: { code: "FORBIDDEN" },
			});
		});

		test.each([
			["開始日が終了日より後", { displayFrom: TOMORROW, displayUntil: TODAY }],
			["本文が空白だけ", { body: "   " }],
		])(
			"%s なら 400 と VALIDATION_ERROR を返し、内容は変わらない",
			async (_, overrides) => {
				const { cookie, userId } = await signInWithProfile("teacher");
				const id = await setUpAnnouncementOf(userId);

				const res = await patchAnnouncement(id, input(overrides), cookie);

				expect(res.status).toBe(400);
				expect(await res.json()).toMatchObject({
					error: { code: "VALIDATION_ERROR" },
				});
				expect(await findAnnouncement(id)).toMatchObject({ body: "元の本文" });
			},
		);

		test("項目が欠けているなら 400 と VALIDATION_ERROR を返す（変えない項目も送る）", async () => {
			const { cookie, userId } = await signInWithProfile("teacher");
			const id = await setUpAnnouncementOf(userId);

			const res = await patchAnnouncement(id, { body: "本文だけ" }, cookie);

			expect(res.status).toBe(400);
			expect(await findAnnouncement(id)).toMatchObject({ body: "元の本文" });
		});
	});

	describe("DELETE /api/announcements/:id", () => {
		function deleteAnnouncement(id: string, cookie?: string) {
			return request("DELETE", `/api/announcements/${id}`, { cookie });
		}

		async function setUpAnnouncementOf(authorId: string) {
			await insertDay(DAY);
			return insertAnnouncement({ date: DAY, authorId, createdAt: CREATED_AT });
		}

		test("未ログインなら 401 を返し、連絡は残る", async () => {
			const authorId = await insertUser("森谷", null, "teacher");
			const id = await setUpAnnouncementOf(authorId);

			const res = await deleteAnnouncement(id);

			expect(res.status).toBe(401);
			expect(await findAnnouncement(id)).toBeDefined();
		});

		test("書いた本人は削除でき、200 と id を返す", async () => {
			const { cookie, userId } = await signInWithProfile("teacher");
			const id = await setUpAnnouncementOf(userId);

			const res = await deleteAnnouncement(id, cookie);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ id });
			expect(await findAnnouncement(id)).toBeUndefined();
		});

		test("admin は他人の連絡を削除できる", async () => {
			const authorId = await insertUser("森谷", null, "teacher");
			const id = await setUpAnnouncementOf(authorId);
			const { cookie } = await signInWithProfile("admin");

			const res = await deleteAnnouncement(id, cookie);

			expect(res.status).toBe(200);
			expect(await findAnnouncement(id)).toBeUndefined();
		});

		test("書いた本人なら、役割が student に変わっていても削除できる", async () => {
			const { cookie, userId } = await signInWithProfile("student");
			const id = await setUpAnnouncementOf(userId);

			const res = await deleteAnnouncement(id, cookie);

			expect(res.status).toBe(200);
			expect(await findAnnouncement(id)).toBeUndefined();
		});

		test.each(["teacher", "student"] as const)(
			"他人の連絡なら、%s には 403 と FORBIDDEN を返し、連絡は残る",
			async (role) => {
				const authorId = await insertUser("森谷", null, "teacher");
				const id = await setUpAnnouncementOf(authorId);
				const { cookie } = await signInWithProfile(role);

				const res = await deleteAnnouncement(id, cookie);

				expect(res.status).toBe(403);
				expect(await res.json()).toMatchObject({
					error: { code: "FORBIDDEN" },
				});
				expect(await findAnnouncement(id)).toBeDefined();
			},
		);

		test("存在しない id なら 404 と ANNOUNCEMENT_NOT_FOUND を返す", async () => {
			const { cookie } = await signInWithProfile("admin");

			const res = await deleteAnnouncement(createId(), cookie);

			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({
				error: { code: "ANNOUNCEMENT_NOT_FOUND" },
			});
		});

		test("id の形が不正なら 400 と VALIDATION_ERROR を返す", async () => {
			const { cookie } = await signInWithProfile("admin");

			const res = await deleteAnnouncement("not-an-id", cookie);

			expect(res.status).toBe(400);
		});
	});
});
