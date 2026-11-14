import { afterEach, beforeAll } from "bun:test";
import type { GoogleProfile } from "better-auth/social-providers";
import { inArray } from "drizzle-orm";
import { createAuth } from "../../src/worker/auth";
import {
	announcements,
	conferenceParticipants,
	gradePromotions,
	reservations,
	users,
} from "../../src/worker/db/schema";
import type { Bindings } from "../../src/worker/env";
import { getTestDatabaseUrl, setUpTestDb } from "./test-db";

// DATABASE_URL 以外のテスト用の値。DB を使わないテストもあるため、DATABASE_URL は testEnv() で足す
export const TEST_AUTH_ENV = {
	GOOGLE_CLIENT_ID: "test-client-id",
	GOOGLE_CLIENT_SECRET: "test-client-secret",
	BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuvwxyz",
	BETTER_AUTH_URL: "http://localhost:5173",
} satisfies Omit<Bindings, "DATABASE_URL">;

export function testEnv(databaseUrl = getTestDatabaseUrl()): Bindings {
	return { DATABASE_URL: databaseUrl, ...TEST_AUTH_ENV };
}

export type GoogleUser = { sub: string; email: string; emailVerified: boolean };

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

export function createTestAuth(googleUser: GoogleUser, env = testEnv()) {
	return createAuth(env, {
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

export function signInWithGoogle(auth: ReturnType<typeof createAuth>) {
	return auth.api.signInSocial({
		body: { provider: "google", idToken: { token: "fake-id-token" } },
	});
}

// 新しい学生としてログインし、API に付けて送るクッキー（name=value）を返す
export async function signInAsNewUser(
	email: string,
	env = testEnv(),
): Promise<string> {
	const auth = createTestAuth(
		{
			sub: crypto.randomUUID(),
			email,
			emailVerified: true,
		},
		env,
	);
	const { headers } = await auth.api.signInSocial({
		body: { provider: "google", idToken: { token: "fake-id-token" } },
		returnHeaders: true,
	});
	const cookie = headers.get("set-cookie")?.split(";")[0] ?? "";
	if (!cookie.includes("session_token=")) {
		throw new Error("ログインのクッキーを取得できませんでした");
	}
	return cookie;
}

// テスト用 DB を準備し、テストで作ったユーザーだけをテストごとに消す。呼んだ describe の中のテストだけに効く。
// 接続先は関数で受け取る（未設定のときのエラーを、ファイルの読み込み中ではなくテストの開始時に出すため）
export function useTestUsers(getDatabaseUrl = getTestDatabaseUrl) {
	let db: Awaited<ReturnType<typeof setUpTestDb>>;
	let usedEmails: string[] = [];

	// 既定の上限（5秒）のままだと、空のブランチに全マイグレーションを適用している途中で打ち切られる。
	// マイグレーションは1文ずつ送られるため、打ち切られると半端な状態が DB に残り、次の実行も失敗する
	beforeAll(async () => {
		db = await setUpTestDb(getDatabaseUrl());
	}, 60_000);

	afterEach(async () => {
		if (usedEmails.length > 0) {
			// 連絡・予約・学年更新の記録・学会の参加の外部キーは RESTRICT のため、そのユーザーの分を先に消す。
			// テストの時間はほぼ Neon との往復待ちのため、batch で1回の往復にまとめる（batch は並べた順に実行する）
			const testUserIds = db
				.select({ id: users.id })
				.from(users)
				.where(inArray(users.email, usedEmails));
			await db.batch([
				db
					.delete(gradePromotions)
					.where(inArray(gradePromotions.executedById, testUserIds)),
				db
					.delete(announcements)
					.where(inArray(announcements.authorId, testUserIds)),
				db
					.delete(reservations)
					.where(inArray(reservations.userId, testUserIds)),
				db
					.delete(conferenceParticipants)
					.where(inArray(conferenceParticipants.userId, testUserIds)),
				// sessions / accounts は CASCADE で一緒に消える
				db.delete(users).where(inArray(users.email, usedEmails)),
			]);
		}
		usedEmails = [];
	});

	return {
		db: () => db,
		env: () => testEnv(getDatabaseUrl()),
		// CI とローカルが同じテスト用ブランチを同時に使ってもぶつからないよう、毎回別のアドレスにする
		uniqueEmail(domain = "stu.musashino-u.ac.jp") {
			const email = `test-${crypto.randomUUID()}@${domain}`;
			usedEmails.push(email);
			return email;
		},
	};
}
