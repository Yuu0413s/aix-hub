import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import { eq } from "drizzle-orm";
import * as clock from "../../../src/worker/clock";
import { users } from "../../../src/worker/db/schema";
import { app } from "../../../src/worker/index";
import { signInAsNewUser, testEnv, useTestUsers } from "../../helpers/sign-in";
import { idAt, testData } from "../../helpers/test-data";
import { deleteSeminarDaysBetween } from "../../helpers/test-db";

type Method = "GET" | "POST" | "PATCH";

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
				...(cookie ? { cookie } : {}),
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			// 文字列はそのまま送る（壊れた JSON を送るテストのため）
			body:
				body === undefined
					? undefined
					: typeof body === "string"
						? body
						: JSON.stringify(body),
		},
		testEnv(),
	);
}

describe("/api/me（テスト用 DB）", () => {
	const testUsers = useTestUsers();

	async function findUser(email: string) {
		const [user] = await testUsers
			.db()
			.select()
			.from(users)
			.where(eq(users.email, email));
		if (!user) {
			throw new Error(`${email} のユーザーが見つかりません`);
		}
		return user;
	}

	// ログインした直後（プロフィール未登録）のユーザーを作る
	async function signInAsUnregistered() {
		const email = testUsers.uniqueEmail();
		const cookie = await signInAsNewUser(email);
		return { email, cookie };
	}

	async function signInAsRegistered(
		profile = { displayName: "Shibata", grade: "B3" as const },
	) {
		const user = await signInAsUnregistered();
		const res = await request("POST", "/api/me/profile", {
			cookie: user.cookie,
			body: profile,
		});
		expect(res.status).toBe(200);
		return user;
	}

	describe("GET /api/me", () => {
		test("未ログインなら 401 を返す", async () => {
			const res = await request("GET", "/api/me");

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test("プロフィール未登録なら isProfileRegistered: false を返す", async () => {
			const { email, cookie } = await signInAsUnregistered();
			const { id } = await findUser(email);

			const res = await request("GET", "/api/me", { cookie });

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				id,
				email,
				displayName: null,
				grade: null,
				role: "student",
				isProfileRegistered: false,
			});
		});

		test("プロフィール登録後は、登録した値と isProfileRegistered: true を返す", async () => {
			const { email, cookie } = await signInAsRegistered();

			const res = await request("GET", "/api/me", { cookie });

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				email,
				displayName: "Shibata",
				grade: "B3",
				role: "student",
				isProfileRegistered: true,
			});
		});
	});

	describe("POST /api/me/profile", () => {
		test("表示名と学年を登録し、200 と登録後の自分の情報を返す", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "森谷", grade: "MIDS_B3" },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				email,
				displayName: "森谷",
				grade: "MIDS_B3",
				isProfileRegistered: true,
			});
			expect(await findUser(email)).toMatchObject({
				displayName: "森谷",
				grade: "MIDS_B3",
			});
		});

		test("教員（grade: null）として登録でき、役割は student のまま", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "森谷", grade: null },
			});

			expect(res.status).toBe(200);
			expect(await findUser(email)).toMatchObject({
				displayName: "森谷",
				grade: null,
				role: "student",
			});
		});

		test("表示名の前後の空白は取り除いて保存する", async () => {
			const { email, cookie } = await signInAsUnregistered();

			await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "  Shibata　", grade: "B3" },
			});

			expect((await findUser(email)).displayName).toBe("Shibata");
		});

		test("表示名は20文字まで登録できる", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "あ".repeat(20), grade: "B3" },
			});

			expect(res.status).toBe(200);
			expect((await findUser(email)).displayName).toBe("あ".repeat(20));
		});

		// 対のないサロゲートを拒否しても、正しく対になった絵文字まで弾かないことを確かめる
		// HTML の maxLength のような UTF-16 単位（絵文字1つ = 2）ではなく、1つを1文字と数える
		test("表示名は絵文字20個まで登録できる", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "😀".repeat(20), grade: "B3" },
			});

			expect(res.status).toBe(200);
			expect((await findUser(email)).displayName).toBe("😀".repeat(20));
		});

		test("絵文字を含む表示名は登録できる", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "しばた😀👍🏽", grade: "B3" },
			});

			expect(res.status).toBe(200);
			expect((await findUser(email)).displayName).toBe("しばた😀👍🏽");
		});

		test.each([
			["表示名が空", { displayName: "", grade: "B3" }],
			["表示名が空白だけ", { displayName: " 　 ", grade: "B3" }],
			["表示名が21文字", { displayName: "あ".repeat(21), grade: "B3" }],
			["表示名が無い", { grade: "B3" }],
			["学年が一覧に無い値", { displayName: "Shibata", grade: "B5" }],
			// 送り忘れと「教員を選んだ」を区別するため、教員は null を明示して送る
			["学年のキーが無い", { displayName: "Shibata" }],
			// 予約者名として全員に表示されるため、見えない名前や見た目の偽装になる文字は受け付けない
			["表示名がゼロ幅スペースだけ", { displayName: "\u200B", grade: "B3" }],
			[
				"表示名に文字の向きを変える文字",
				{ displayName: "a\u202Eb", grade: "B3" },
			],
			["表示名に改行", { displayName: "a\nb", grade: "B3" }],
			// PostgreSQL の text は NUL を保存できず、通すと 500 になる
			["表示名に NUL", { displayName: "a\u0000b", grade: "B3" }],
			// 対になっていないサロゲートは、Neon に送る JSON が壊れて 500 になる
			["表示名に対のないサロゲート", { displayName: "a\uD800b", grade: "B3" }],
			["表示名に行区切り", { displayName: "a\u2028b", grade: "B3" }],
			// 前後にあっても取り除かずに拒否する（trim は改行・行区切り・BOM も取り除いてしまう）
			["表示名の先頭に改行", { displayName: "\nShibata", grade: "B3" }],
			["表示名の先頭に行区切り", { displayName: "\u2028Shibata", grade: "B3" }],
			["表示名の先頭に BOM", { displayName: "\uFEFFShibata", grade: "B3" }],
			[
				"表示名の末尾にゼロ幅スペース",
				{ displayName: "Shibata\u200B", grade: "B3" },
			],
			// 1文字はコードポイント単位で数える（絵文字1つ = 1文字）
			["表示名が絵文字21個", { displayName: "😀".repeat(21), grade: "B3" }],
		])(
			"%s なら 400 と VALIDATION_ERROR を返し、登録しない",
			async (_, body) => {
				const { email, cookie } = await signInAsUnregistered();

				const res = await request("POST", "/api/me/profile", { cookie, body });

				expect(res.status).toBe(400);
				expect(await res.json()).toMatchObject({
					error: { code: "VALIDATION_ERROR" },
				});
				expect(await findUser(email)).toMatchObject({
					displayName: null,
					grade: null,
				});
			},
		);

		test("壊れた JSON なら 400 を共通の形で返す", async () => {
			const { cookie } = await signInAsUnregistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: "{not json",
			});

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "BAD_REQUEST" },
			});
		});

		test("登録済みなら 409 と PROFILE_ALREADY_REGISTERED を返し、1回目の内容のまま変えない", async () => {
			const { email, cookie } = await signInAsRegistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "別の名前", grade: "M1" },
			});

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "PROFILE_ALREADY_REGISTERED" },
			});
			expect(await findUser(email)).toMatchObject({
				displayName: "Shibata",
				grade: "B3",
			});
		});

		// 「登録済みか調べてから更新する」2段階だと、同時に送られたときに両方とも通ってしまう
		test("同時に2回送っても、通るのは1回だけで、もう1回は 409 を返す", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const responses = await Promise.all([
				request("POST", "/api/me/profile", {
					cookie,
					body: { displayName: "一回目", grade: "B3" },
				}),
				request("POST", "/api/me/profile", {
					cookie,
					body: { displayName: "二回目", grade: "M1" },
				}),
			]);

			expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
			const user = await findUser(email);
			const succeeded = responses.findIndex((res) => res.status === 200);
			expect(user).toMatchObject(
				succeeded === 0
					? { displayName: "一回目", grade: "B3" }
					: { displayName: "二回目", grade: "M1" },
			);
		});

		test("未ログインなら 401 を返す", async () => {
			const res = await request("POST", "/api/me/profile", {
				body: { displayName: "Shibata", grade: "B3" },
			});

			expect(res.status).toBe(401);
		});
	});

	describe("PATCH /api/me/profile", () => {
		test("表示名だけを変え、学年は変えない。200 と変更後の自分の情報を返す", async () => {
			const { email, cookie } = await signInAsRegistered();

			const res = await request("PATCH", "/api/me/profile", {
				cookie,
				body: { displayName: "  しばた " },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				displayName: "しばた",
				grade: "B3",
			});
			expect(await findUser(email)).toMatchObject({
				displayName: "しばた",
				grade: "B3",
			});
		});

		test.each([
			["学年が含まれる", { displayName: "しばた", grade: "M1" }],
			["学年が null で含まれる", { displayName: "しばた", grade: null }],
			["表示名が空", { displayName: "" }],
			["表示名が21文字", { displayName: "あ".repeat(21) }],
			["表示名に文字の向きを変える文字", { displayName: "a\u202Eb" }],
			["表示名に対のないサロゲート", { displayName: "a\uD800b" }],
			["表示名の先頭に改行", { displayName: "\nしばた" }],
		])(
			"%s なら 400 と VALIDATION_ERROR を返し、変更しない",
			async (_, body) => {
				const { email, cookie } = await signInAsRegistered();

				const res = await request("PATCH", "/api/me/profile", { cookie, body });

				expect(res.status).toBe(400);
				expect(await res.json()).toMatchObject({
					error: { code: "VALIDATION_ERROR" },
				});
				expect(await findUser(email)).toMatchObject({
					displayName: "Shibata",
					grade: "B3",
				});
			},
		);

		// 表示名だけが入ると、学年を選ばないまま「登録済みの教員」と同じ状態になってしまう
		test("プロフィール未登録なら 409 と PROFILE_NOT_REGISTERED を返し、表示名は空のまま", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const res = await request("PATCH", "/api/me/profile", {
				cookie,
				body: { displayName: "しばた" },
			});

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "PROFILE_NOT_REGISTERED" },
			});
			expect((await findUser(email)).displayName).toBeNull();
		});

		test("未ログインなら 401 を返す", async () => {
			const res = await request("PATCH", "/api/me/profile", {
				body: { displayName: "しばた" },
			});

			expect(res.status).toBe(401);
		});
	});
});

// API の現在時刻を固定し、その前後の日を使う（実際の日付によって結果が変わらないように）。ほかのテストが使っていない年にする
const RESERVATIONS_TEST_RANGE = ["2035-03-01", "2035-03-31"] as const;
const NOW = new Date("2035-03-03T12:00:00+09:00");
const EARLIER_PAST_DAY = "2035-03-01";
const PAST_DAY = "2035-03-02";
const TODAY = "2035-03-03";
const FUTURE_DAY = "2035-03-04";
const LATER_DAY = "2035-03-09";

type ReservationsBody = {
	presentationCount: number;
	reservations: {
		id: string;
		status: string;
		isCancelable: boolean;
		isStarted: boolean;
	}[];
};

describe("GET /api/me/reservations（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const {
		insertDayWithSlots,
		insertUser,
		insertReservation,
		insertReservationOnNewSlot,
		signInWithProfile,
	} = testData(testUsers);
	let currentTimeSpy: Mock<typeof clock.currentTime>;

	beforeEach(async () => {
		currentTimeSpy = spyOn(clock, "currentTime").mockReturnValue(NOW);
		await deleteSeminarDaysBetween(testUsers.db(), RESERVATIONS_TEST_RANGE);
	});

	afterEach(() => {
		currentTimeSpy.mockRestore();
	});

	async function getReservations(cookie?: string) {
		return request("GET", "/api/me/reservations", { cookie });
	}

	// 200 を確かめてから本文を返す（予約1件ごとの値を確かめるテストで使う）
	async function fetchReservationsBody(cookie: string) {
		const res = await getReservations(cookie);
		expect(res.status).toBe(200);
		return (await res.json()) as ReservationsBody;
	}

	// 開催日に枠を1つ作り、userId の予約を入れる（開始時刻を指定したいとき用）
	async function insertReservationAt(
		date: string,
		startTime: string,
		userId: string,
	) {
		const slotIds = await insertDayWithSlots(date, [
			{ period: 3, startTime, endTime: "23:59", kind: "presentation" },
		]);
		return insertReservation(idAt(slotIds, 0), userId);
	}

	test("未ログインなら 401 を返す", async () => {
		const res = await getReservations();

		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({
			error: { code: "UNAUTHORIZED" },
		});
	});

	test("予約が無ければ、空の一覧と発表回数 0 を返す", async () => {
		const { cookie } = await signInWithProfile();

		const res = await getReservations(cookie);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			presentationCount: 0,
			reservations: [],
		});
	});

	test("予約の id・日付・開始・終了（HH:MM）・状態を返す", async () => {
		const { cookie, userId } = await signInWithProfile();
		const slotIds = await insertDayWithSlots(FUTURE_DAY, [
			{ period: 4, startTime: "15:10", endTime: "15:30", kind: "presentation" },
		]);
		const reservationId = await insertReservation(idAt(slotIds, 0), userId);

		const res = await getReservations(cookie);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			presentationCount: 0,
			reservations: [
				{
					id: reservationId,
					date: FUTURE_DAY,
					startTime: "15:10",
					endTime: "15:30",
					status: "reserved",
					isCancelable: true,
					isStarted: false,
				},
			],
		});
	});

	test("自分の予約だけを返し、同じ日の他人の予約は含まない", async () => {
		const { cookie, userId } = await signInWithProfile();
		const otherUserId = await insertUser("Moriya", "B3");
		const slotIds = await insertDayWithSlots(FUTURE_DAY, [
			{ period: 3, startTime: "13:30", endTime: "13:50", kind: "presentation" },
			{ period: 3, startTime: "13:50", endTime: "14:10", kind: "presentation" },
		]);
		const myReservationId = await insertReservation(idAt(slotIds, 0), userId);
		await insertReservation(idAt(slotIds, 1), otherUserId);

		const res = await getReservations(cookie);

		const body = (await res.json()) as ReservationsBody;
		expect(body.reservations.map((r) => r.id)).toEqual([myReservationId]);
	});

	test("日付の古い順、同じ日なら開始時刻の早い順に並べる", async () => {
		const { cookie, userId } = await signInWithProfile();
		// 入れる順と並びが同じにならないよう、新しい日・遅い時刻から入れる
		const laterId = await insertReservationOnNewSlot(LATER_DAY, userId);
		const futureSlotIds = await insertDayWithSlots(FUTURE_DAY, [
			{ period: 4, startTime: "15:10", endTime: "15:30", kind: "presentation" },
			{ period: 3, startTime: "13:30", endTime: "13:50", kind: "presentation" },
		]);
		const futureLateId = await insertReservation(
			idAt(futureSlotIds, 0),
			userId,
		);
		const futureEarlyId = await insertReservation(
			idAt(futureSlotIds, 1),
			userId,
		);
		const pastId = await insertReservationOnNewSlot(PAST_DAY, userId, "done");

		const res = await getReservations(cookie);

		const body = (await res.json()) as ReservationsBody;
		expect(body.reservations.map((r) => r.id)).toEqual([
			pastId,
			futureEarlyId,
			futureLateId,
			laterId,
		]);
	});

	test("発表回数は done の件数で、reserved は数えない", async () => {
		const { cookie, userId } = await signInWithProfile();
		await insertReservationOnNewSlot(EARLIER_PAST_DAY, userId, "done");
		await insertReservationOnNewSlot(PAST_DAY, userId, "done");
		await insertReservationOnNewSlot(FUTURE_DAY, userId);

		const res = await getReservations(cookie);

		const body = (await res.json()) as ReservationsBody;
		// 空振りを防ぐため、数えなかった reserved も一覧には入っていることを確かめる
		expect(body.reservations).toHaveLength(3);
		expect(body.presentationCount).toBe(2);
	});

	describe("isCancelable（取り消せるか）", () => {
		test("student の、開始前の reserved は true", async () => {
			const { cookie, userId } = await signInWithProfile();
			await insertReservationOnNewSlot(FUTURE_DAY, userId);

			const body = await fetchReservationsBody(cookie);

			expect(body.reservations[0]).toMatchObject({ isCancelable: true });
		});

		test("student の、開始時刻を過ぎた reserved（「済」になる前の当日）は false", async () => {
			const { cookie, userId } = await signInWithProfile();
			// 現在時刻（12:00）より前に始まった枠
			const slotIds = await insertDayWithSlots(TODAY, [
				{
					period: 2,
					startTime: "11:00",
					endTime: "11:20",
					kind: "presentation",
				},
			]);
			await insertReservation(idAt(slotIds, 0), userId);

			const body = await fetchReservationsBody(cookie);

			expect(body.reservations[0]).toMatchObject({
				status: "reserved",
				isCancelable: false,
			});
		});

		test("student の done は false", async () => {
			const { cookie, userId } = await signInWithProfile();
			await insertReservationOnNewSlot(PAST_DAY, userId, "done");

			const body = await fetchReservationsBody(cookie);

			expect(body.reservations[0]).toMatchObject({
				status: "done",
				isCancelable: false,
			});
		});

		// admin は「済」の予約も取り消せる（設計メモ「予約・取消のルール」）
		test("admin なら、自分の done も true", async () => {
			const { cookie, userId } = await signInWithProfile("admin");
			await insertReservationOnNewSlot(PAST_DAY, userId, "done");

			const body = await fetchReservationsBody(cookie);

			expect(body.reservations[0]).toMatchObject({
				status: "done",
				isCancelable: true,
			});
		});
	});

	describe("isStarted（開始時刻を過ぎたか）", () => {
		test("開始前の reserved は false", async () => {
			const { cookie, userId } = await signInWithProfile();
			await insertReservationOnNewSlot(FUTURE_DAY, userId);

			const body = await fetchReservationsBody(cookie);

			expect(body.reservations[0]).toMatchObject({ isStarted: false });
		});

		// 予約・取消と同じく、開始時刻ちょうどから「開始済み」とする（設計メモ「予約・取消のルール」）
		test("開始時刻ちょうど（当日 12:00）の reserved は true", async () => {
			const { cookie, userId } = await signInWithProfile();
			await insertReservationAt(TODAY, "12:00", userId);

			const body = await fetchReservationsBody(cookie);

			expect(body.reservations[0]).toMatchObject({
				status: "reserved",
				isStarted: true,
			});
		});

		// 日本時間で比べていることも確かめる。11:00 を UTC として読むと、現在時刻（UTC で 03:00）より後になり false になる
		test("開始時刻を過ぎた当日の reserved（「済」になる前）は true", async () => {
			const { cookie, userId } = await signInWithProfile();
			await insertReservationAt(TODAY, "11:00", userId);

			const body = await fetchReservationsBody(cookie);

			expect(body.reservations[0]).toMatchObject({
				status: "reserved",
				isStarted: true,
			});
		});

		test("当日の、まだ始まっていない reserved（12:10 開始）は false", async () => {
			const { cookie, userId } = await signInWithProfile();
			await insertReservationAt(TODAY, "12:10", userId);

			const body = await fetchReservationsBody(cookie);

			expect(body.reservations[0]).toMatchObject({ isStarted: false });
		});

		test("前の日の done は true", async () => {
			const { cookie, userId } = await signInWithProfile();
			await insertReservationOnNewSlot(PAST_DAY, userId, "done");

			const body = await fetchReservationsBody(cookie);

			expect(body.reservations[0]).toMatchObject({
				status: "done",
				isStarted: true,
			});
		});
	});

	test("teacher でも 200 で、空の一覧と発表回数 0 を返す", async () => {
		const { cookie } = await signInWithProfile("teacher");

		const res = await getReservations(cookie);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			presentationCount: 0,
			reservations: [],
		});
	});
});
