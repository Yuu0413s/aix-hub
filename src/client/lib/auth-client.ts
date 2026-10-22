import { createAuthClient } from "better-auth/react";
import { redirect } from "react-router";

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

// ページを表示する前に確かめ、未ログインならトップ画面を一瞬も見せずにログイン画面へ移動する
export async function requireSessionLoader() {
	const session = await getSessionOrThrow();
	if (!session) {
		throw redirect("/login");
	}
	return session;
}

export async function redirectIfSignedInLoader() {
	const session = await getSessionOrThrow();
	if (session) {
		throw redirect("/");
	}
	return null;
}
