import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { GoogleProfile } from "better-auth/social-providers";
import { eq, inArray } from "drizzle-orm";
import { createAuth, isAllowedEmail } from "../../src/worker/auth";
import { sessions, users } from "../../src/worker/db/schema";
import type { Bindings } from "../../src/worker/env";
import app from "../../src/worker/index";
import { getTestDatabaseUrl, setUpTestDb } from "../helpers/test-db";

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
			aud: "test-client-id",
			azp: "test-client-id",
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
		return createAuth(
			{
				DATABASE_URL: getTestDatabaseUrl(),
				GOOGLE_CLIENT_ID: "test-client-id",
				GOOGLE_CLIENT_SECRET: "test-client-secret",
				BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuvwxyz",
				BETTER_AUTH_URL: "http://localhost:5173",
			},
			{
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
			},
		);
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

describe("/api/auth/*", () => {
	test("Hono から better-auth に届く", async () => {
		const env: Bindings = {
			DATABASE_URL: getTestDatabaseUrl(),
			GOOGLE_CLIENT_ID: "test-client-id",
			GOOGLE_CLIENT_SECRET: "test-client-secret",
			BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuvwxyz",
			BETTER_AUTH_URL: "http://localhost:5173",
		};

		const res = await app.request("/api/auth/ok", {}, env);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});
