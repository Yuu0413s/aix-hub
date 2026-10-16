import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Bindings } from "../../src/worker/env";
import { handleError, maskSecrets } from "../../src/worker/error-handler";
import app from "../../src/worker/index";

// パスワードに URL エンコードが必要な文字（@ → %40）を含めて、両方の形を伏せられるか確かめる
const PASSWORD_RAW = "p%40ssW0rd";
const PASSWORD_DECODED = "p@ssW0rd";
const DATABASE_URL = `postgresql://neondb_owner:${PASSWORD_RAW}@ep-cool-host-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;

const INTERNAL_SERVER_ERROR_BODY = {
	error: {
		code: "INTERNAL_SERVER_ERROR",
		message: "サーバーでエラーが発生しました",
	},
};

describe("maskSecrets", () => {
	test("URL の全体を *** に置き換え、ユーザー名・ホスト名も残さない", () => {
		expect(maskSecrets(`接続に失敗: ${DATABASE_URL}`, DATABASE_URL)).toBe(
			"接続に失敗: ***",
		);
	});

	test("URL に書かれた形のパスワードだけが含まれる文も伏せる", () => {
		expect(maskSecrets(`password=${PASSWORD_RAW}`, DATABASE_URL)).toBe(
			"password=***",
		);
	});

	test("元の文字に戻した形のパスワードだけが含まれる文も伏せる", () => {
		expect(maskSecrets(`password=${PASSWORD_DECODED}`, DATABASE_URL)).toBe(
			"password=***",
		);
	});

	test("パスワードの無い URL でも文が壊れない", () => {
		const urlWithoutPassword = "postgresql://neondb_owner@localhost/neondb";

		expect(maskSecrets("select 1", urlWithoutPassword)).toBe("select 1");
		expect(maskSecrets(`url=${urlWithoutPassword}`, urlWithoutPassword)).toBe(
			"url=***",
		);
	});

	test("URL として読めない値でも、値の全体は伏せる", () => {
		expect(maskSecrets("value=not a url", "not a url")).toBe("value=***");
	});

	test("秘密情報を含まない文はそのまま返す", () => {
		expect(maskSecrets('relation "users" does not exist', DATABASE_URL)).toBe(
			'relation "users" does not exist',
		);
	});

	test("DATABASE_URL が未設定（undefined・空文字）なら文をそのまま返す", () => {
		expect(maskSecrets("select 1", undefined)).toBe("select 1");
		expect(maskSecrets("select 1", "")).toBe("select 1");
	});
});

describe("handleError", () => {
	let consoleErrorSpy: Mock<typeof console.error>;

	beforeEach(() => {
		// テストの出力を汚さないよう、ログは出さずに記録だけする
		consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	function loggedText() {
		return consoleErrorSpy.mock.calls
			.map((args) => args.map(String).join(" "))
			.join("\n");
	}

	function createThrowingApp(error: Error) {
		const throwingApp = new Hono<{ Bindings: Bindings }>();
		throwingApp.onError(handleError);
		throwingApp.get("/boom", () => {
			throw error;
		});
		return throwingApp;
	}

	function createDbLikeError() {
		const cause = new Error(
			`password authentication failed: ${PASSWORD_DECODED}`,
		);
		return new Error(`Failed query: select 1 (${DATABASE_URL})`, { cause });
	}

	test("想定外のエラーは 500 と共通の形で返し、レスポンスに秘密情報を含めない", async () => {
		const res = await createThrowingApp(createDbLikeError()).request(
			"/boom",
			{},
			{ DATABASE_URL },
		);
		const text = await res.text();

		expect(res.status).toBe(500);
		expect(JSON.parse(text)).toEqual(INTERNAL_SERVER_ERROR_BODY);
		expect(text).not.toContain(PASSWORD_DECODED);
		expect(text).not.toContain(PASSWORD_RAW);
	});

	test("ログには cause までたどった内容を、秘密情報を伏せて出す", async () => {
		await createThrowingApp(createDbLikeError()).request(
			"/boom",
			{},
			{ DATABASE_URL },
		);
		const logged = loggedText();

		// ログが空のまま「含まれない」が通ってしまわないよう、中身があることを先に確かめる
		expect(consoleErrorSpy).toHaveBeenCalled();
		expect(logged).toContain("Failed query: select 1 (***)");
		expect(logged).toContain("password authentication failed: ***");
		expect(logged).not.toContain(DATABASE_URL);
		expect(logged).not.toContain(PASSWORD_RAW);
		expect(logged).not.toContain(PASSWORD_DECODED);
	});

	test("cause が互いを指していても止まり、500 を返す", async () => {
		const first = new Error("first");
		const second = new Error("second", { cause: first });
		first.cause = second;

		const res = await createThrowingApp(first).request(
			"/boom",
			{},
			{ DATABASE_URL },
		);

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual(INTERNAL_SERVER_ERROR_BODY);
	});

	test("HTTPException はステータスを変えずにそのまま返す", async () => {
		const res = await createThrowingApp(
			new HTTPException(401, { message: "unauthorized" }),
		).request("/boom", {}, { DATABASE_URL });

		expect(res.status).toBe(401);
		expect(await res.text()).toBe("unauthorized");
	});
});

describe("GET /api/health/db（DB につながらないとき）", () => {
	let consoleErrorSpy: Mock<typeof console.error>;

	beforeEach(() => {
		consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	test("500 と共通の形を返し、レスポンスにもログにも秘密情報を含めない", async () => {
		// この端末の 443 番ポートで何も動いていなければ、接続はすぐに断られる
		const unreachableUrl =
			"postgresql://neondb_owner:secretpw@127.0.0.1/neondb";

		const res = await app.request(
			"/api/health/db",
			{},
			{ DATABASE_URL: unreachableUrl },
		);
		const text = await res.text();
		const logged = consoleErrorSpy.mock.calls
			.map((args) => args.map(String).join(" "))
			.join("\n");

		expect(res.status).toBe(500);
		expect(JSON.parse(text)).toEqual(INTERNAL_SERVER_ERROR_BODY);
		expect(text).not.toContain("secretpw");
		expect(logged.length).toBeGreaterThan(0);
		expect(logged).not.toContain("secretpw");
		expect(logged).not.toContain(unreachableUrl);
	});
});
