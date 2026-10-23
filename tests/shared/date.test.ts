import { describe, expect, test } from "bun:test";
import { addMonths, tokyoDate } from "../../src/shared/date";

describe("tokyoDate", () => {
	test("日本時間の日付を YYYY-MM-DD で返す", () => {
		expect(tokyoDate(new Date("2032-03-05T12:00:00+09:00"))).toBe("2032-03-05");
	});

	test("UTC ではまだ前日の 15:00 でも、日本時間で翌日 0:00 なら翌日の日付を返す", () => {
		const now = new Date("2032-03-04T15:00:00Z");
		expect(now.getUTCDate()).toBe(4);

		expect(tokyoDate(now)).toBe("2032-03-05");
	});
});

describe("addMonths", () => {
	test("1か月後を返す", () => {
		expect(addMonths("2032-03", 1)).toBe("2032-04");
	});

	test("12月の1か月後は、翌年の1月", () => {
		expect(addMonths("2032-12", 1)).toBe("2033-01");
	});

	test("1月の1か月前は、前年の12月", () => {
		expect(addMonths("2032-01", -1)).toBe("2031-12");
	});
});
