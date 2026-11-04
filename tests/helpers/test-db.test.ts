import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getIsolatedTestDatabaseUrl } from "./test-db";

// 実在しない接続先だけを使う。この関数は URL を比べるだけで、DB には繋がない
const SHARED_URL =
	"postgresql://user:secret@ep-shared-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const ISOLATED_URL =
	"postgresql://user:secret@ep-isolated-456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

describe("getIsolatedTestDatabaseUrl", () => {
	let originalSharedUrl: string | undefined;
	let originalIsolatedUrl: string | undefined;

	beforeEach(() => {
		originalSharedUrl = process.env.TEST_DATABASE_URL;
		originalIsolatedUrl = process.env.TEST_ISOLATED_DATABASE_URL;
	});

	afterEach(() => {
		restoreEnv("TEST_DATABASE_URL", originalSharedUrl);
		restoreEnv("TEST_ISOLATED_DATABASE_URL", originalIsolatedUrl);
	});

	// process.env に undefined を代入すると文字列 "undefined" になるため、元が無ければ消す
	function restoreEnv(name: string, value: string | undefined) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}

	function setUrls(sharedUrl: string | undefined, isolatedUrl: string) {
		restoreEnv("TEST_DATABASE_URL", sharedUrl);
		process.env.TEST_ISOLATED_DATABASE_URL = isolatedUrl;
	}

	test("別のエンドポイントなら、その URL を返す", () => {
		setUrls(SHARED_URL, ISOLATED_URL);

		expect(getIsolatedTestDatabaseUrl()).toBe(ISOLATED_URL);
	});

	test("同じエンドポイントでも、別の DB なら、その URL を返す", () => {
		const otherDatabaseUrl = SHARED_URL.replace("/neondb?", "/isolated?");
		setUrls(SHARED_URL, otherDatabaseUrl);

		expect(getIsolatedTestDatabaseUrl()).toBe(otherDatabaseUrl);
	});

	test("共有の URL が未設定なら、比べずに、その URL を返す", () => {
		setUrls(undefined, ISOLATED_URL);

		expect(getIsolatedTestDatabaseUrl()).toBe(ISOLATED_URL);
	});

	test("未設定なら止める", () => {
		setUrls(SHARED_URL, "");

		expect(() => getIsolatedTestDatabaseUrl()).toThrow(
			"TEST_ISOLATED_DATABASE_URL が未設定です",
		);
	});

	// 表記が違っても、同じブランチなら、共有の admin を全員外してしまうため止める
	test.each([
		["完全に同じ", SHARED_URL],
		[
			"直接接続とプール接続",
			SHARED_URL.replace("ep-shared-123.", "ep-shared-123-pooler."),
		],
		["認証情報だけが違う", SHARED_URL.replace("user:secret", "other:password")],
		[
			"クエリパラメーターだけが違う",
			SHARED_URL.replace("?sslmode=require", ""),
		],
		[
			"ホスト名の大文字・小文字だけが違う",
			SHARED_URL.replace("ep-shared", "EP-SHARED"),
		],
		[
			"既定のポートの有無だけが違う",
			SHARED_URL.replace(".aws.neon.tech/", ".aws.neon.tech:5432/"),
		],
		[
			"DB 名のパーセントエンコードだけが違う",
			SHARED_URL.replace("/neondb?", "/neon%64b?"),
		],
		[
			"ホスト名末尾のドットだけが違う",
			SHARED_URL.replace(".aws.neon.tech/", ".aws.neon.tech./"),
		],
		[
			"ホスト名のパーセントエンコードだけが違う",
			SHARED_URL.replace("ep-shared-123.", "ep-%73hared-123."),
		],
		[
			"プール接続で、ホスト名末尾のドットも違う",
			SHARED_URL.replace(
				"ep-shared-123.ap-southeast-1.aws.neon.tech/",
				"ep-shared-123-pooler.ap-southeast-1.aws.neon.tech./",
			),
		],
	])("同じ接続先なら止める: %s", (_name, isolatedUrl) => {
		setUrls(SHARED_URL, isolatedUrl);

		expect(() => getIsolatedTestDatabaseUrl()).toThrow(
			"共有のブランチとは別のブランチにしてください",
		);
	});

	// 接続文字列には認証情報が入る。CI のログに残さない
	test.each([
		["専用", SHARED_URL, "not a url secret"],
		["共有", "not a url secret", ISOLATED_URL],
		// DB 名の復号は URL の解析のあとで失敗するため、別に確かめる
		[
			"DB 名を復号できない専用",
			SHARED_URL,
			ISOLATED_URL.replace("/neondb?", "/neon%zz?"),
		],
	])(
		"%s の URL の形が不正なら、値を出さずに止める",
		(_name, sharedUrl, isolatedUrl) => {
			setUrls(sharedUrl, isolatedUrl);

			let message = "";
			try {
				getIsolatedTestDatabaseUrl();
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}

			expect(message).toContain("URL の形が正しくありません");
			expect(message).not.toContain("secret");
		},
	);
});
