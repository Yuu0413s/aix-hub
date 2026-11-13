import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import { writeLog } from "../../src/worker/log";

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;

let consoleSpies: Record<(typeof LEVELS)[number], Mock<typeof console.log>>;

beforeEach(() => {
	// テストの出力を汚さないよう、ログは出さずに記録だけする
	consoleSpies = Object.fromEntries(
		LEVELS.map((level) => [
			level,
			spyOn(console, level).mockImplementation(() => {}),
		]),
	) as typeof consoleSpies;
});

afterEach(() => {
	for (const spy of Object.values(consoleSpies)) {
		spy.mockRestore();
	}
});

describe("writeLog", () => {
	test("{ event, ...fields } を1行の JSON 文字列にして、1回だけ出す", () => {
		writeLog("error", "cronTaskFailed", {
			task: "開催日の作成",
			// 改行を含む値も、JSON の中では \n になり、ログは1行のまま出る
			error: "Error: first\nCaused by: second",
			dates: ["2030-01-04", "2030-01-11"],
			count: 2,
		});

		const calls = consoleSpies.error.mock.calls;
		expect(calls).toHaveLength(1);
		// 文字列を1つだけ渡す（オブジェクトや2つ目の引数を渡すと、ログ側が展開する形が変わるため）
		expect(calls[0]).toHaveLength(1);
		const line = calls[0]?.[0];
		expect(typeof line).toBe("string");
		expect(line).not.toContain("\n");
		expect(JSON.parse(String(line))).toEqual({
			event: "cronTaskFailed",
			task: "開催日の作成",
			error: "Error: first\nCaused by: second",
			dates: ["2030-01-04", "2030-01-11"],
			count: 2,
		});
	});

	// 生のログを目で読むときに、先頭で何のログかが分かるようにするため（api.md）
	test("event を JSON の最初の項目にする", () => {
		writeLog("log", "cronReservationsMarkedDone", {
			count: 7,
			scheduledTime: "2030-01-02T03:00:00.000Z",
		});

		const line = String(consoleSpies.log.mock.calls[0]?.[0]);
		expect(Object.keys(JSON.parse(line))[0]).toBe("event");
	});

	// test.each は書き換えできる配列しか受け付けないため、写してから渡す
	test.each([...LEVELS])(
		"%s を指定したら、console の同じ名前のメソッドだけに出す",
		(level) => {
			writeLog(level, "betterAuthLog", { message: "x" });

			for (const other of LEVELS) {
				expect(consoleSpies[other]).toHaveBeenCalledTimes(
					other === level ? 1 : 0,
				);
			}
		},
	);

	test("fields に event や Error などのオブジェクトを渡すと、型エラーになる", () => {
		// この検証は bun run typecheck で行う（@ts-expect-error の行に型エラーが無いと、typecheck が失敗する）。
		// event は上書きを防ぐため、Error は JSON にすると {} になり中身が消えるため、型で受け付けない
		// @ts-expect-error event は fields に入れられない
		writeLog("log", "betterAuthLog", { event: "other" });
		// @ts-expect-error Error などのオブジェクトは値にできない
		writeLog("error", "apiUnhandledError", { error: new Error("boom") });
	});
});
