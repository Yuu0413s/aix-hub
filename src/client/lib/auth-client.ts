import { createAuthClient } from "better-auth/react";
import { redirect, useRouteLoaderData } from "react-router";
import { api } from "./api";

// 既定では環境変数などから接続先を推測するため、同じオリジンの /api/auth（Worker 側の basePath）を明示する
export const authClient = createAuthClient({
	baseURL: window.location.origin,
	basePath: "/api/auth",
});

// ログイン状態を確かめられなかったとき（通信の失敗など）に「未ログイン」として扱うと、
// ログイン済みの人までログイン画面に送られるため、エラーとして扱う
async function getSessionOrThrow() {
	const { data, error } = await authClient.getSession();
	if (error) {
		throw new Error(`ログイン状態を確認できませんでした: ${error.status}`);
	}
	return data;
}

// 自分の情報を取る。未ログインなら null。
// 通信の失敗などを「未ログイン」として扱うと、ログイン済みの人までログイン画面に送られるため、エラーとして扱う
async function fetchMe() {
	const res = await api.api.me.$get();
	if (res.status === 401) {
		return null;
	}
	if (!res.ok) {
		throw new Error(`自分の情報を取得できませんでした: ${res.status}`);
	}
	return res.json();
}

// ページを表示する前に確かめ、未ログインならログイン画面へ、プロフィール未登録なら登録画面へ移動する
// （開こうとした画面（トップなど）を一瞬も見せないため、画面の中ではなく loader で確かめる）
export async function requireProfileLoader() {
	const me = await fetchMe();
	if (!me) {
		throw redirect("/login");
	}
	if (!me.isProfileRegistered) {
		throw redirect("/onboarding");
	}
	return me;
}

// ログインとプロフィール登録が要る画面をまとめる親ルートの id（main.tsx）。
// 確認は親の loader で1回だけ行い、子の画面は useMe で結果を読む
export const PROFILE_REQUIRED_ROUTE_ID = "profile-required";

// ログイン中の自分の情報。PROFILE_REQUIRED_ROUTE_ID の下の画面でだけ使える
export function useMe() {
	const me = useRouteLoaderData<typeof requireProfileLoader>(
		PROFILE_REQUIRED_ROUTE_ID,
	);
	if (!me) {
		throw new Error("useMe は、ログインが必要な画面の中で使ってください");
	}
	return me;
}

// 登録画面用。ログインは必須で、登録済みならトップへ戻す（学年は登録し直せないため、登録画面を二度出さない）
export async function redirectIfProfileRegisteredLoader() {
	const me = await fetchMe();
	if (!me) {
		throw redirect("/login");
	}
	if (me.isProfileRegistered) {
		throw redirect("/");
	}
	return me;
}

export async function redirectIfSignedInLoader() {
	const session = await getSessionOrThrow();
	if (session) {
		throw redirect("/");
	}
	return null;
}
