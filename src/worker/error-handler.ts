import { DrizzleQueryError } from "drizzle-orm";
import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { API_ERROR_CODES, errorBody } from "../shared/api-errors";
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

// Drizzle のエラー文には SQL に渡した値（params）が入り、セッショントークンなども含まれるため、値の部分だけを伏せる。
// 値に改行が含まれても取りこぼさないよう、行単位ではなく、エラー文の全体を伏せた文に置き換える
function describeError(error: Error): string {
	const text = error.stack ?? `${error.name}: ${error.message}`;
	if (!(error instanceof DrizzleQueryError)) {
		return text;
	}
	const masked = `Failed query: ${error.query}\nparams: ${MASK}`;
	// stack にエラー文がそのまま入っていない形のときは、stack を使わずに伏せた文だけを返す。
	// replace に文字列を渡すと、SQL の中の $& などが置き換えの書式として読まれ、伏せる前の文が差し込まれるため関数で渡す
	return text.includes(error.message)
		? text.replace(error.message, () => masked)
		: `${error.name}: ${masked}`;
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
			parts.push(describeError(current));
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

// HTTPException の code はステータスから決める。対応表に無いものは HTTP_ERROR にする
const HTTP_ERROR_CODES: Record<number, string> = {
	400: API_ERROR_CODES.BAD_REQUEST,
	401: API_ERROR_CODES.UNAUTHORIZED,
	403: API_ERROR_CODES.FORBIDDEN,
	404: API_ERROR_CODES.NOT_FOUND,
	409: API_ERROR_CODES.CONFLICT,
};
const DEFAULT_HTTP_ERROR_MESSAGE = "リクエストを処理できませんでした";

// Variables を持つアプリ（middleware/auth.ts の AuthEnv など）でも使えるよう、Bindings を持つ Env 全般を受け付ける
export function handleError<E extends { Bindings: Bindings }>(
	...[error, c]: Parameters<ErrorHandler<E>>
): Response {
	// Hono が投げる HTTPException（壊れた JSON など）も、フロントが code を読めるよう共通の形にそろえる（api.md）。
	// - instanceof HTTPException にしないのは、Hono が getResponse を持つエラー（HTTPResponseError）全般をこの形で扱うため
	// - c.json を通すのは、例外の前に c.header() で付けたヘッダーを残すため
	if ("getResponse" in error) {
		const res = error.getResponse();
		// 元の Response のヘッダー（WWW-Authenticate など）は残す。本文の種類と長さは作り直す本文に合わないため除く
		const headers = new Headers(res.headers);
		headers.delete("content-type");
		headers.delete("content-length");
		for (const [name, value] of headers) {
			c.header(name, value, { append: true });
		}
		return c.json(
			errorBody(
				HTTP_ERROR_CODES[res.status] ?? API_ERROR_CODES.HTTP_ERROR,
				error.message || DEFAULT_HTTP_ERROR_MESSAGE,
			),
			// res.status は number のため、Hono のステータスの型に合わせる
			res.status as ContentfulStatusCode,
		);
	}

	// エラーのオブジェクトをそのまま渡すと、ログ側が中身を展開して伏せていない値が出るため、伏せた文字列だけを渡す。
	// c.env は app.request に env を渡さないと undefined になるため、? を付ける
	console.error(maskSecrets(formatError(error), c.env?.DATABASE_URL));

	return c.json(
		errorBody(
			API_ERROR_CODES.INTERNAL_SERVER_ERROR,
			"サーバーでエラーが発生しました",
		),
		500,
	);
}
