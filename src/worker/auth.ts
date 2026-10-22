import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { GoogleOptions } from "better-auth/social-providers";
import { ALLOWED_EMAIL_DOMAINS, AUTH_ERROR_CODES } from "../shared/auth";
import { createDb } from "./db/client";
import * as schema from "./db/schema";
import type { Bindings } from "./env";
import { formatLogValue, maskSecrets } from "./error-handler";

const MIN_SECRET_LENGTH = 32;

// Google ログインしか使わないため、メール・パスワード系の入口は塞ぐ。
// 秘密鍵が漏れたときに、署名付きのトークンだけで通れる入口（verify-email など）を残さないため。
// disabledPaths は完全一致で比べるので、パスに値を含む /reset-password/:token は index.ts で塞いでいる
const DISABLED_PATHS = [
	"/sign-up/email",
	"/sign-in/email",
	"/verify-email",
	"/send-verification-email",
	"/change-email",
	"/change-password",
	"/verify-password",
	"/request-password-reset",
	"/reset-password",
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
	return (ALLOWED_EMAIL_DOMAINS as readonly string[]).includes(domain);
}

// 設定が欠けていたら動かさない。better-auth は秘密鍵が無いと公開されている既定の鍵で動き、
// それを拒むのは NODE_ENV=production のときだけだが、Workers には NODE_ENV が無いため黙って動いてしまう
function assertAuthEnv(env: Bindings) {
	for (const key of [
		"DATABASE_URL",
		"GOOGLE_CLIENT_ID",
		"GOOGLE_CLIENT_SECRET",
		"BETTER_AUTH_SECRET",
		"BETTER_AUTH_URL",
	] as const) {
		if (!env[key]) {
			throw new Error(`${key} が未設定です`);
		}
	}
	if (env.BETTER_AUTH_SECRET.length < MIN_SECRET_LENGTH) {
		throw new Error(
			`BETTER_AUTH_SECRET は ${MIN_SECRET_LENGTH} 文字以上にしてください`,
		);
	}
}

// googleOverrides はテストで Google への問い合わせを偽物に差し替えるための引数。本番では渡さない
export function createAuth(
	env: Bindings,
	googleOverrides: Partial<GoogleOptions> = {},
) {
	assertAuthEnv(env);

	return betterAuth({
		baseURL: env.BETTER_AUTH_URL,
		// index.ts で Hono に渡しているパスと合わせる
		basePath: "/api/auth",
		secret: env.BETTER_AUTH_SECRET,
		disabledPaths: DISABLED_PATHS,
		onAPIError: {
			// ログイン画面が戻り先を渡せなかったエラー（state の不一致など）も、標準のエラー画面ではなくログイン画面に戻す
			errorURL: "/login",
			// better-auth が受け止めなかった例外（ログイン開始時の DB のエラーなど）を、Hono の handleError に渡す。
			// better-auth に任せると、DATABASE_URL を伏せないままログに出し、空の 500 を返すため（api.md）。
			// 拒否（403）やリダイレクトなど better-auth が意図して返すものは、これまでどおり better-auth が返す
			throw: true,
		},
		// better-auth が自分で受け止めた例外（ログイン確認や Google からの戻りでの DB のエラーなど）は handleError に届かず、
		// better-auth が独自の 500 やログイン画面へのリダイレクトを返したうえで、この logger でログに出す。
		// そのため、こちらでも handleError と同じく伏せてから出す
		logger: {
			level: "warn",
			log: (level, message, ...args) => {
				const text = [message, ...args].map(formatLogValue).join(" ");
				console[level](`[Better Auth] ${maskSecrets(text, env.DATABASE_URL)}`);
			},
		},
		// 既定では NODE_ENV=production のときだけ有効になり、Workers では無効になるため明示する。
		// 保存先は既定のメモリ（Worker のインスタンスごと）なので効きは弱い。本格的な制限は Cloudflare 側で行う
		rateLimit: { enabled: true },
		advanced: {
			ipAddress: {
				// 回数制限で利用者を区別するための IP。既定の x-forwarded-for は、無いときや値が2つ以上あるときに
				// IP 不明として全員が1つの枠を共有してしまう（全員で10秒に3回しかログインを始められなくなる）。
				// cf-connecting-ip は Cloudflare が必ず付ける、接続してきた人の IP
				ipAddressHeaders: ["cf-connecting-ip"],
			},
		},
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
				// defaultValue は schema.ts の default と合わせる（better-auth は自分で既定値を入れて INSERT するため、
				// DB の DEFAULT は使われない。required: true の列は defaultValue を消すと作成に失敗する）
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
					return { error: AUTH_ERROR_CODES.DOMAIN_NOT_ALLOWED };
				}
				if (user.emailVerified !== true) {
					return { error: AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED };
				}
			},
		},
	});
}
