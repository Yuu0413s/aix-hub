import type { UserRole } from "./user-role";

// ログインできるアカウントのドメインと、最初のログインで付ける役割。
// 許可ドメインと役割を別々に書くと、片方だけ直したときにずれるため、1つの表にまとめる
export const EMAIL_DOMAIN_ROLES = {
	"stu.musashino-u.ac.jp": "student",
	"ds.musashino-u.ac.jp": "teacher",
} as const satisfies Record<string, UserRole>;

type EmailDomain = keyof typeof EMAIL_DOMAIN_ROLES;

// ログイン画面の案内文で使う（サーバーの判定は roleForEmail で EMAIL_DOMAIN_ROLES を直接引く）
export const ALLOWED_EMAIL_DOMAINS = Object.keys(
	EMAIL_DOMAIN_ROLES,
) as EmailDomain[];

// in で調べると、"constructor" など Object が元から持つ名前まで通るため、表に書いたキーだけを見る
function isEmailDomain(domain: string): domain is EmailDomain {
	return Object.hasOwn(EMAIL_DOMAIN_ROLES, domain);
}

// メールアドレスのドメインから役割を引く。ログインできないドメインなら null。
// 末尾一致にすると evil-musashino-u.ac.jp や x.stu.musashino-u.ac.jp が通るため、@ より後ろを完全一致で比べる
export function roleForEmail(
	email: string,
): (typeof EMAIL_DOMAIN_ROLES)[EmailDomain] | null {
	const parts = email.toLowerCase().split("@");
	// @ が2つ以上あると「どこからがドメインか」が曖昧になるため、ちょうど1つのときだけ判定する
	if (parts.length !== 2) {
		return null;
	}
	const [localPart, domain] = parts;
	if (!localPart || !domain || !isEmailDomain(domain)) {
		return null;
	}
	return EMAIL_DOMAIN_ROLES[domain];
}

// ログインを拒否したときのコード。better-auth は /login?error=<コード> の形でログイン画面に戻す
export const AUTH_ERROR_CODES = {
	DOMAIN_NOT_ALLOWED: "DOMAIN_NOT_ALLOWED",
	EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
} as const;
