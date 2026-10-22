import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { GoogleOptions } from "better-auth/social-providers";
import { createDb } from "./db/client";
import * as schema from "./db/schema";
import type { Bindings } from "./env";

const ALLOWED_EMAIL_DOMAINS = [
	"stu.musashino-u.ac.jp",
	"ds.musashino-u.ac.jp",
	"musashino-u.ac.jp",
];

// Google の hd パラメータはヒントに過ぎないため、サーバー側でメールアドレスを判定する。
// 末尾一致にすると evil-musashino-u.ac.jp や x.stu.musashino-u.ac.jp が通るため、@ より後ろを完全一致で比べる
export function isAllowedEmail(email: string): boolean {
	const parts = email.toLowerCase().split("@");
	// @ が2つ以上あると「どこからがドメインか」が曖昧になるため、ちょうど1つのときだけ判定する
	if (parts.length !== 2) {
		return false;
	}
	const [localPart, domain] = parts;
	if (!localPart || !domain) {
		return false;
	}
	return ALLOWED_EMAIL_DOMAINS.includes(domain);
}

// googleOverrides はテストで Google への問い合わせを偽物に差し替えるための引数。本番では渡さない
export function createAuth(
	env: Bindings,
	googleOverrides: Partial<GoogleOptions> = {},
) {
	return betterAuth({
		baseURL: env.BETTER_AUTH_URL,
		// index.ts で Hono に渡しているパスと合わせる
		basePath: "/api/auth",
		secret: env.BETTER_AUTH_SECRET,
		// ログイン画面が戻り先を渡せなかったエラー（state の不一致など）も、標準のエラー画面ではなくログイン画面に戻す
		onAPIError: { errorURL: "/login" },
		database: drizzleAdapter(createDb(env.DATABASE_URL), {
			provider: "pg",
			schema,
			// schema.ts のテーブル名は複数形（db.md）
			usePlural: true,
			// neon-http は db.transaction() を使えないため、明示的に無効にしておく（db/client.ts）
			transaction: false,
		}),
		socialProviders: {
			google: {
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET,
				...googleOverrides,
			},
		},
		user: {
			// 4列とも input: false にして、利用者が送った値で書き換えられないようにする（プロフィールは #3 の API で書く）
			additionalFields: {
				// 値の一覧は schema.ts の enum から取り、DB の定義とずれないようにする
				role: {
					type: [...schema.userRole.enumValues],
					required: true,
					defaultValue: "student",
					input: false,
				},
				grade: {
					type: [...schema.grade.enumValues],
					required: false,
					input: false,
				},
				displayName: {
					type: "string",
					required: false,
					input: false,
				},
				isEnrolled: {
					type: "boolean",
					required: true,
					defaultValue: true,
					input: false,
				},
			},
			// ユーザーの作成・アカウントの紐付け・再ログインの直前に毎回呼ばれる。
			// 拒否すると better-auth は users に行を作らず 403 を返す（ブラウザからのログインでは errorCallbackURL に戻る）
			validateUserInfo: ({ user }) => {
				if (!isAllowedEmail(user.email ?? "")) {
					return { error: "DOMAIN_NOT_ALLOWED" };
				}
				if (user.emailVerified !== true) {
					return { error: "EMAIL_NOT_VERIFIED" };
				}
			},
		},
	});
}
