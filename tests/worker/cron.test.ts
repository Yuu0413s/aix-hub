import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import { runScheduled } from "../../src/worker/cron";
import * as reservation from "../../src/worker/services/reservation";
import * as seminarDay from "../../src/worker/services/seminar-day";
import { TEST_AUTH_ENV } from "../helpers/sign-in";

// パスワードに URL エンコードが必要な文字（@ → %40）を含めて、両方の形を伏せられるか確かめる
const PASSWORD_RAW = "p%40ssW0rd";
const PASSWORD_DECODED = "p@ssW0rd";
const DATABASE_URL = `postgresql://neondb_owner:${PASSWORD_RAW}@ep-cool-host-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
const ENV = { DATABASE_URL, ...TEST_AUTH_ENV };
const NOW = new Date("2030-01-02T12:00:00+09:00");

let generateSpy: Mock<typeof seminarDay.generateSeminarDays>;
let markDoneSpy: Mock<typeof reservation.markPastReservationsDone>;
let consoleErrorSpy: Mock<typeof console.error>;
let consoleLogSpy: Mock<typeof console.log>;

beforeEach(() => {
	generateSpy = spyOn(seminarDay, "generateSeminarDays");
	markDoneSpy = spyOn(reservation, "markPastReservationsDone");
	// テストの出力を汚さないよう、ログは出さずに記録だけする
	consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
	consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	generateSpy.mockRestore();
	markDoneSpy.mockRestore();
	consoleErrorSpy.mockRestore();
	consoleLogSpy.mockRestore();
});

// console.error と console.log のどちらの spy も受け取る
function loggedText(spy: Mock<(...args: unknown[]) => void>) {
	return spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
}

// 投げられたエラーを返す（投げられなければ undefined）
async function runAndCatch() {
	return runScheduled(ENV, NOW).then(
		() => undefined,
		(error: unknown) => error,
	);
}

describe("runScheduled", () => {
	test("同じ現在時刻を渡して、開催日の作成と予約の「済」への更新を行い、結果をログに出す", async () => {
		generateSpy.mockResolvedValue(["2030-01-04"]);
		// 件数は、同じログに出る日付（2030-01-04）に含まれない数字にする（日付に当たって検証が空振りしないように）
		markDoneSpy.mockResolvedValue(7);

		await runScheduled(ENV, NOW);

		expect(generateSpy).toHaveBeenCalledTimes(1);
		expect(generateSpy.mock.calls[0]?.[1]).toEqual(NOW);
		expect(markDoneSpy).toHaveBeenCalledTimes(1);
		expect(markDoneSpy.mock.calls[0]?.[1]).toEqual(NOW);
		const logged = loggedText(consoleLogSpy);
		expect(logged).toContain("2030-01-04");
		expect(logged).toContain("予約を「済」にしました: 7 件");
		expect(consoleErrorSpy).not.toHaveBeenCalled();
	});

	describe("失敗したとき", () => {
		// 接続文字列とパスワードの両方の形を含むエラー（Neon のエラーに入りうる形）。
		// テストの中で作る。ファイルの読み込み時に作ると、Bun では stack を読む前に GC が走ったとき
		// stack の1行目からメッセージが消え、ログの検証がたまに落ちるため（本番の V8 では起きない）
		const createFailure = () =>
			new Error(
				`connect failed: ${DATABASE_URL} (password: ${PASSWORD_DECODED})`,
				{ cause: new Error(`retry with ${PASSWORD_RAW}`) },
			);

		function expectMaskedLog() {
			const logged = loggedText(consoleErrorSpy);
			expect(logged).toContain("connect failed: ***");
			// cause までたどってログに出す
			expect(logged).toContain("retry with ***");
			expect(logged).not.toContain(DATABASE_URL);
			expect(logged).not.toContain(PASSWORD_RAW);
			expect(logged).not.toContain(PASSWORD_DECODED);
		}

		test("開催日の作成が失敗しても、予約の「済」への更新は行う。ログは DATABASE_URL とパスワードを伏せて出す", async () => {
			const failure = createFailure();
			generateSpy.mockRejectedValue(failure);
			markDoneSpy.mockResolvedValue(0);

			await runAndCatch();

			// 伏せる前の文に秘密情報が入っていることを先に確かめる（検証が空振りしないように）
			expect(failure.message).toContain(PASSWORD_DECODED);
			expect(markDoneSpy).toHaveBeenCalledTimes(1);
			expectMaskedLog();
		});

		test("予約の「済」への更新が失敗しても、開催日の作成は行う。ログは DATABASE_URL とパスワードを伏せて出す", async () => {
			generateSpy.mockResolvedValue([]);
			markDoneSpy.mockRejectedValue(createFailure());

			await runAndCatch();

			expect(generateSpy).toHaveBeenCalledTimes(1);
			expectMaskedLog();
		});

		test.each([
			["開催日の作成", true, false, "開催日の作成"],
			["予約の「済」への更新", false, true, "予約の「済」への更新"],
			["両方", true, true, "開催日の作成、予約の「済」への更新"],
		])(
			"%sが失敗したら、Cron の履歴に失敗と残るよう、失敗した処理の名前だけを含む Error を投げ直す",
			async (_, isGenerateFailed, isMarkDoneFailed, names) => {
				const failure = createFailure();
				if (isGenerateFailed) {
					generateSpy.mockRejectedValue(failure);
				} else {
					generateSpy.mockResolvedValue([]);
				}
				if (isMarkDoneFailed) {
					markDoneSpy.mockRejectedValue(failure);
				} else {
					markDoneSpy.mockResolvedValue(0);
				}

				const thrown = await runAndCatch();

				expect(thrown).toBeInstanceOf(Error);
				expect(thrown).not.toBe(failure);
				const error = thrown as Error;
				expect(error.message).toBe(`Cron の処理に失敗しました: ${names}`);
				// 元のエラーを cause に持たせると、Workers のログに伏せていない文が出るため持たせない
				expect(error.cause).toBeUndefined();
			},
		);
	});
});
