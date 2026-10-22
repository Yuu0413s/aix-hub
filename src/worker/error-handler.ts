import type { ErrorHandler } from "hono";
import type { Bindings } from "./env";

const MASK = "***";

// DATABASE_URL の全体と、そのパスワード部分を伏せる。
// エラー文には URL の形が変わって入ったり、パスワードだけが入ったりする可能性があるため、パスワードも単独で伏せる
export function maskSecrets(
	text: string,
	databaseUrl: string | undefined,
): string {
	if (!databaseUrl) {
		return text;
	}

	// 先に短いパスワードを置き換えると URL の全体と一致しなくなり、ユーザー名やホスト名が残るため、長いものから置き換える
	const secrets = [databaseUrl, ...extractPasswords(databaseUrl)]
		// 空文字を置き換えると文字の間すべてに *** が入るため除く（パスワードの無い URL で起きる）
		.filter((secret) => secret !== "")
		.sort((a, b) => b.length - a.length);

	return secrets.reduce(
		(masked, secret) => masked.replaceAll(secret, MASK),
		text,
	);
}

// URL に書かれた形（p%40ss）と、元の文字に戻した形（p@ss）の両方を返す
function extractPasswords(databaseUrl: string): string[] {
	let password: string;
	try {
		password = new URL(databaseUrl).password;
	} catch {
		// URL として読めない値は、呼び出し元で全体だけを伏せる
		return [];
	}

	try {
		return [password, decodeURIComponent(password)];
	} catch {
		// 不正な % の並びは decodeURIComponent が例外を投げるため、書かれた形だけを伏せる
		return [password];
	}
}

// Drizzle のエラーは cause の中に Neon 本体のエラーを持つため、cause を最後までたどって1つの文字列にする
function formatError(error: Error): string {
	const parts: string[] = [];
	// cause が互いを指していても止まるよう、一度見たものは二度たどらない
	const visited = new Set<unknown>();
	let current: unknown = error;

	while (current !== undefined && current !== null && !visited.has(current)) {
		visited.add(current);
		if (current instanceof Error) {
			parts.push(current.stack ?? `${current.name}: ${current.message}`);
			current = current.cause;
		} else {
			parts.push(String(current));
			current = undefined;
		}
	}

	return parts.join("\nCaused by: ");
}

// ログに渡された値を、伏せる前の1つの文字列にする。
// オブジェクトのままログに渡すと、ログ側が中身を展開して伏せていない値が出るため（handleError と同じ理由）
export function formatLogValue(value: unknown): string {
	if (value instanceof Error) {
		return formatError(value);
	}
	if (typeof value === "string") {
		return value;
	}
	try {
		return JSON.stringify(value);
	} catch {
		// 互いを指し合うオブジェクトなど、JSON にできない値
		return String(value);
	}
}

export const handleError: ErrorHandler<{ Bindings: Bindings }> = (error, c) => {
	// onError を登録すると Hono の既定の処理が置き換わるため、HTTPException などは既定と同じ判定・返し方にする。
	// - instanceof HTTPException にしないのは、Hono が getResponse を持つエラー（HTTPResponseError）全般をこの形で扱うため
	// - c.newResponse を通すのは、例外の前に c.header() で付けたヘッダーを残すため
	if ("getResponse" in error) {
		const res = error.getResponse();
		return c.newResponse(res.body, res);
	}

	// エラーのオブジェクトをそのまま渡すと、ログ側が中身を展開して伏せていない値が出るため、伏せた文字列だけを渡す。
	// c.env は app.request に env を渡さないと undefined になるため、? を付ける
	console.error(maskSecrets(formatError(error), c.env?.DATABASE_URL));

	return c.json(
		{
			error: {
				code: "INTERNAL_SERVER_ERROR",
				message: "サーバーでエラーが発生しました",
			},
		},
		500,
	);
};
