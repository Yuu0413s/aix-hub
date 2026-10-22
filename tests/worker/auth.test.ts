import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import type { GoogleProfile } from "better-auth/social-providers";
import { eq, inArray } from "drizzle-orm";
import { createAuth, isAllowedEmail } from "../../src/worker/auth";
import { sessions, users } from "../../src/worker/db/schema";
import type { Bindings } from "../../src/worker/env";
import app from "../../src/worker/index";
import { getTestDatabaseUrl, setUpTestDb } from "../helpers/test-db";

// DATABASE_URL 以外のテスト用の値。DB を使わないテストもあるため、DATABASE_URL は testEnv() で足す
const TEST_AUTH_ENV = {
	GOOGLE_CLIENT_ID: "test-client-id",
	GOOGLE_CLIENT_SECRET: "test-client-secret",
	BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuvwxyz",
	BETTER_AUTH_URL: "http://localhost:5173",
} satisfies Omit<Bindings, "DATABASE_URL">;

function testEnv(): Bindings {
	return { DATABASE_URL: getTestDatabaseUrl(), ...TEST_AUTH_ENV };
}

describe("isAllowedEmail", () => {
	test.each([
		"a@stu.musashino-u.ac.jp",
		"a@ds.musashino-u.ac.jp",
		"a@musashino-u.ac.jp",
	])("3ドメインのアカウントは許可する: %s", (email) => {
		expect(isAllowedEmail(email)).toBe(true);
	});

	test("大文字・小文字は区別しない", () => {
		expect(isAllowedEmail("A@STU.MUSASHINO-U.AC.JP")).toBe(true);
	});

	test.each([
		["大学外のドメイン", "a@gmail.com"],
		["末尾だけが一致するドメイン", "a@evil-musashino-u.ac.jp"],
		["3ドメインのサブドメイン", "a@x.stu.musashino-u.ac.jp"],
		["@ が2つある", "a@b@stu.musashino-u.ac.jp"],
		["@ が無い", "stu.musashino-u.ac.jp"],
		["空文字", ""],
	])("%s は拒否する: %s", (_, email) => {
		expect(isAllowedEmail(email)).toBe(false);
	});
});

describe("Google ログイン（テスト用 DB ＋ 偽の Google）", () => {
	let db: Awaited<ReturnType<typeof setUpTestDb>>;
	// テストで作った行だけを後で消すため、使ったメールアドレスを覚えておく
	let usedEmails: string[] = [];

	beforeAll(async () => {
		db = await setUpTestDb();
	});

	afterEach(async () => {
		if (usedEmails.length > 0) {
			// sessions / accounts は CASCADE で一緒に消える
			await db.delete(users).where(inArray(users.email, usedEmails));
		}
		usedEmails = [];
	});

	// CI とローカルが同じテスト用ブランチを同時に使ってもぶつからないよう、毎回別のアドレスにする
	function uniqueEmail(domain: string) {
		const email = `test-${crypto.randomUUID()}@${domain}`;
		usedEmails.push(email);
		return email;
	}

	type GoogleUser = { sub: string; email: string; emailVerified: boolean };

	function fakeGoogleProfile(googleUser: GoogleUser): GoogleProfile {
		const now = Math.floor(Date.now() / 1000);
		return {
			aud: TEST_AUTH_ENV.GOOGLE_CLIENT_ID,
			azp: TEST_AUTH_ENV.GOOGLE_CLIENT_ID,
			iss: "https://accounts.google.com",
			iat: now,
			exp: now + 3600,
			sub: googleUser.sub,
			email: googleUser.email,
			email_verified: googleUser.emailVerified,
			name: "テスト",
			given_name: "テスト",
			family_name: "",
			picture: "",
		};
	}

	function createTestAuth(googleUser: GoogleUser) {
		return createAuth(testEnv(), {
			// 本物の Google に問い合わせず、「このアカウントの人です」と答えるだけにする
			verifyIdToken: async () => true,
			// better-auth は Google のアカウント ID を data.sub から取る
			getUserInfo: async () => ({
				user: {
					email: googleUser.email,
					name: "テスト",
					emailVerified: googleUser.emailVerified,
				},
				data: fakeGoogleProfile(googleUser),
			}),
		});
	}

	function signInWithGoogle(auth: ReturnType<typeof createAuth>) {
		return auth.api.signInSocial({
			body: { provider: "google", idToken: { token: "fake-id-token" } },
		});
	}

	async function findUsersByEmail(email: string) {
		return db.select().from(users).where(eq(users.email, email));
	}

	test.each([
		"stu.musashino-u.ac.jp",
		"ds.musashino-u.ac.jp",
		"musashino-u.ac.jp",
	])(
		"%s のアカウントはログインでき、users に学生として1行できる",
		async (domain) => {
			const email = uniqueEmail(domain);
			const auth = createTestAuth({
				sub: crypto.randomUUID(),
				email,
				emailVerified: true,
			});

			await signInWithGoogle(auth);

			const found = await findUsersByEmail(email);
			expect(found).toHaveLength(1);
			expect(found[0]).toMatchObject({
				role: "student",
				isEnrolled: true,
				grade: null,
				displayName: null,
			});

			const userSessions = await db
				.select()
				.from(sessions)
				.where(eq(sessions.userId, found[0]?.id ?? ""));
			expect(userSessions).toHaveLength(1);
		},
	);

	test.each(["gmail.com", "evil-musashino-u.ac.jp", "x.stu.musashino-u.ac.jp"])(
		"%s のアカウントは 403 で拒否し、users に行を作らない",
		async (domain) => {
			const email = uniqueEmail(domain);
			const auth = createTestAuth({
				sub: crypto.randomUUID(),
				email,
				emailVerified: true,
			});

			await expect(signInWithGoogle(auth)).rejects.toMatchObject({
				statusCode: 403,
				body: { code: "DOMAIN_NOT_ALLOWED" },
			});
			// 成功するケースでは同じ検索で1行見つかることを確かめているので、ここの 0 行は検索条件の誤りによる空振りではない
			expect(await findUsersByEmail(email)).toHaveLength(0);
		},
	);

	test("3ドメインでも、Google がメールアドレス未確認と返したら 403 で拒否し、users に行を作らない", async () => {
		const email = uniqueEmail("stu.musashino-u.ac.jp");
		const auth = createTestAuth({
			sub: crypto.randomUUID(),
			email,
			emailVerified: false,
		});

		await expect(signInWithGoogle(auth)).rejects.toMatchObject({
			statusCode: 403,
			body: { code: "EMAIL_NOT_VERIFIED" },
		});
		expect(await findUsersByEmail(email)).toHaveLength(0);
	});

	test("ログイン済みの人の Google 側のメールが大学外に変わったら、再ログインを 403 で拒否する", async () => {
		const sub = crypto.randomUUID();
		const email = uniqueEmail("stu.musashino-u.ac.jp");
		await signInWithGoogle(createTestAuth({ sub, email, emailVerified: true }));
		expect(await findUsersByEmail(email)).toHaveLength(1);

		const movedAuth = createTestAuth({
			sub,
			email: uniqueEmail("gmail.com"),
			emailVerified: true,
		});

		await expect(signInWithGoogle(movedAuth)).rejects.toMatchObject({
			statusCode: 403,
			body: { code: "DOMAIN_NOT_ALLOWED" },
		});
	});
});

describe("createAuth の設定の確認", () => {
	// better-auth は秘密鍵が無いと公開されている既定の鍵で動き、それを拒むのは NODE_ENV=production のときだけ。
	// Workers では NODE_ENV が無いため、設定し忘れても黙って動いてしまう
	test.each([
		["未設定", ""],
		["32文字未満", "a".repeat(31)],
	])("BETTER_AUTH_SECRET が%sなら例外にする", (_, secret) => {
		expect(() =>
			createAuth({ ...testEnv(), BETTER_AUTH_SECRET: secret }),
		).toThrow("BETTER_AUTH_SECRET");
	});

	test.each([
		"DATABASE_URL",
		"GOOGLE_CLIENT_ID",
		"GOOGLE_CLIENT_SECRET",
		"BETTER_AUTH_URL",
	] as const)("%s が未設定なら例外にする", (key) => {
		expect(() => createAuth({ ...testEnv(), [key]: "" })).toThrow(key);
	});

	test("32文字ちょうどの BETTER_AUTH_SECRET は受け付ける", () => {
		expect(() =>
			createAuth({ ...testEnv(), BETTER_AUTH_SECRET: "a".repeat(32) }),
		).not.toThrow();
	});
});

describe("/api/auth/*", () => {
	test("Hono から better-auth に届く", async () => {
		const res = await app.request("/api/auth/ok", {}, testEnv());

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	// Google ログインしか使わないため、メール・パスワード系の入口は塞ぐ（秘密鍵が漏れたときなどの多重の守り）
	test.each([
		["POST", "/api/auth/sign-up/email"],
		["POST", "/api/auth/sign-in/email"],
		["GET", "/api/auth/verify-email"],
		["POST", "/api/auth/send-verification-email"],
		["POST", "/api/auth/change-email"],
		["POST", "/api/auth/change-password"],
		["POST", "/api/auth/verify-password"],
		["POST", "/api/auth/request-password-reset"],
		["POST", "/api/auth/reset-password"],
		["GET", "/api/auth/reset-password/some-token"],
	])("%s %s は塞いでいて 404 を返す", async (method, path) => {
		const res = await app.request(
			path,
			{
				method,
				headers: {
					"content-type": "application/json",
					origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
				},
				body: method === "POST" ? "{}" : undefined,
			},
			testEnv(),
		);

		expect(res.status).toBe(404);
	});
});

// ポート番号が不正な URL を渡すと、Neon は接続先の文字列をそのまま含んだエラーを投げる（通信はしない）
const INVALID_DATABASE_URL =
	"postgresql://neondb_owner:secretpw@host:badport/neondb";

// テストの出力を汚さないよう、ログは出さずに記録だけする。呼んだ describe の中のテストだけに効く
function captureConsole() {
	let consoleSpies: Mock<typeof console.error>[] = [];

	beforeEach(() => {
		consoleSpies = (["error", "warn", "info", "log", "debug"] as const).map(
			(method) => spyOn(console, method).mockImplementation(() => {}),
		);
	});

	afterEach(() => {
		for (const spy of consoleSpies) {
			spy.mockRestore();
		}
	});

	// 実際のコンソールと同じく、オブジェクトは中身（cause を含む）まで展開して文字列にする。
	// String() だと Error の cause の中が文字列にならず、漏れていても気づけないため
	return function loggedText() {
		return consoleSpies
			.flatMap((spy) => spy.mock.calls)
			.map((args) =>
				args
					.map((arg) => (typeof arg === "string" ? arg : Bun.inspect(arg)))
					.join(" "),
			)
			.join("\n");
	};
}

// ログイン開始は、Google に移動する前に途中の状態（state）を DB に書き込む
function startSignIn(env: Bindings, headers: Record<string, string> = {}) {
	return app.request(
		"/api/auth/sign-in/social",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: TEST_AUTH_ENV.BETTER_AUTH_URL,
				...headers,
			},
			body: JSON.stringify({ provider: "google", callbackURL: "/" }),
		},
		env,
	);
}

describe("/api/auth/*（better-auth の中で DB のエラーが起きたとき）", () => {
	const loggedText = captureConsole();

	// better-auth が受け止めない例外は、onAPIError.throw で Hono の handleError に届く
	test("ログイン開始: 500 と共通の形を返し、エラー文に入った接続先をログでは伏せる", async () => {
		const res = await startSignIn({
			...TEST_AUTH_ENV,
			DATABASE_URL: INVALID_DATABASE_URL,
		});
		const logged = loggedText();

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({
			error: {
				code: "INTERNAL_SERVER_ERROR",
				message: "サーバーでエラーが発生しました",
			},
		});
		// *** が入っていること＝元のエラー文に接続先が入っていて、それを伏せたこと
		expect(logged).toContain("***");
		expect(logged).not.toContain("secretpw");
	});

	// better-auth が自分で受け止めた例外は、better-auth の logger を通ってログに出る
	test("Google からの戻り: ログイン画面に戻し、better-auth のログでも接続先を伏せる", async () => {
		const res = await app.request(
			"/api/auth/callback/google?state=bogus&code=x",
			{},
			{ ...TEST_AUTH_ENV, DATABASE_URL: INVALID_DATABASE_URL },
		);
		const logged = loggedText();

		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe(
			"/login?error=internal_server_error",
		);
		// logger の設定が無いと *** は出ないため、伏せる処理を通ったことをここで確かめる
		expect(logged).toContain("***");
		expect(logged).not.toContain("secretpw");
	});
});

describe("/api/auth/* のレート制限", () => {
	captureConsole();

	// 回数を数える前に DB のエラーで止まるよう、DB には繋がない（テスト用 DB に行を残さないため）
	const env = { ...TEST_AUTH_ENV, DATABASE_URL: INVALID_DATABASE_URL };

	// IP を区別できないと、全員が1つの枠を共有し、利用者全員で10秒に3回しかログインを始められなくなる
	test("IP が違えば別々に数え、4人続けてログインを始めても 429 にならない", async () => {
		const statuses: number[] = [];
		for (const ip of [
			"198.51.100.1",
			"198.51.100.2",
			"198.51.100.3",
			"198.51.100.4",
		]) {
			const res = await startSignIn(env, { "cf-connecting-ip": ip });
			statuses.push(res.status);
		}

		expect(statuses).toHaveLength(4);
		expect(statuses).not.toContain(429);
	});

	// 上のテストが「制限が効いていないから 429 にならない」で通ってしまわないよう、同じ IP では効くことを確かめる
	test("同じ IP から10秒に4回ログインを始めると、4回目は 429 を返す", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < 4; i++) {
			const res = await startSignIn(env, {
				"cf-connecting-ip": "198.51.100.9",
			});
			statuses.push(res.status);
		}

		expect(statuses.slice(0, 3)).not.toContain(429);
		expect(statuses[3]).toBe(429);
	});
});
