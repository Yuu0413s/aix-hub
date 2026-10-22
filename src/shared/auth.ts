// ログインできるアカウントのドメイン。サーバーの判定とログイン画面の案内文の両方で使う
export const ALLOWED_EMAIL_DOMAINS = [
	"stu.musashino-u.ac.jp",
	"ds.musashino-u.ac.jp",
	"musashino-u.ac.jp",
] as const;

// ログインを拒否したときのコード。better-auth は /login?error=<コード> の形でログイン画面に戻す
export const AUTH_ERROR_CODES = {
	DOMAIN_NOT_ALLOWED: "DOMAIN_NOT_ALLOWED",
	EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
} as const;
