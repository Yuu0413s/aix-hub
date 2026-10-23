import { createMiddleware } from "hono/factory";
import { API_ERROR_CODES, errorBody } from "../../shared/api-errors";
import { createAuth } from "../auth";
import type { userRole } from "../db/schema";
import type { Bindings } from "../env";

export type UserRole = (typeof userRole.enumValues)[number];

// 予約できる役割。teacher は予約しない（設計メモ「役割」）
export const RESERVER_ROLES = [
	"student",
	"admin",
] as const satisfies readonly UserRole[];

export type AuthUser = ReturnType<
	typeof createAuth
>["$Infer"]["Session"]["user"];

// requireAuth を通った後ろの処理は、c.get("user") でログイン中のユーザーを読める
export type AuthEnv = {
	Bindings: Bindings;
	Variables: { user: AuthUser };
};

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
	// better-auth はセッションの期限を延ばすときに新しいクッキーを返すため、ヘッダーも受け取ってそのまま返す。
	// 捨てると、DB 上のセッションは延びてもブラウザのクッキーが先に切れ、ログインし直しになる
	const { headers, response: session } = await createAuth(c.env).api.getSession(
		{
			headers: c.req.raw.headers,
			returnHeaders: true,
		},
	);
	for (const cookie of headers.getSetCookie()) {
		c.header("set-cookie", cookie, { append: true });
	}

	if (!session) {
		return c.json(
			errorBody(API_ERROR_CODES.UNAUTHORIZED, "ログインしてください"),
			401,
		);
	}
	c.set("user", session.user);
	await next();
});

// 通す役割をすべて書く（例: requireRole("student", "admin")）。
// teacher は予約できないなど役割に単純な上下関係が無いため、「この役割以上」の形にはしない。requireAuth の後ろに置く
export function requireRole(...roles: UserRole[]) {
	return createMiddleware<AuthEnv>(async (c, next) => {
		if (!roles.includes(c.get("user").role)) {
			return c.json(
				errorBody(API_ERROR_CODES.FORBIDDEN, "この操作を行う権限がありません"),
				403,
			);
		}
		await next();
	});
}

// 学年は教員だと NULL のため、登録済みかは表示名で判定する
export function isProfileRegistered(user: { displayName?: string | null }) {
	return user.displayName != null;
}

// 予約できる人か（予約できる役割で、プロフィール登録済み）。予約の API では requireProfile と requireRole(...RESERVER_ROLES) で
// 同じことを確かめ（エラーの理由を分けるため別々に掛ける）、日別の表ではこれで isReservable を決める
export function isReserver(user: AuthUser) {
	return (
		(RESERVER_ROLES as readonly UserRole[]).includes(user.role) &&
		isProfileRegistered(user)
	);
}

// プロフィール未登録の人が、表示名の無いまま予約などをできないようにする。requireAuth の後ろに置く
export const requireProfile = createMiddleware<AuthEnv>(async (c, next) => {
	if (!isProfileRegistered(c.get("user"))) {
		return c.json(
			errorBody(
				API_ERROR_CODES.PROFILE_REQUIRED,
				"先にプロフィールを登録してください",
			),
			403,
		);
	}
	await next();
});
