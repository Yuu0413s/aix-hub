import { describe, expect, test } from "bun:test";
import { addMonths, daysInMonth, tokyoDate } from "../../src/shared/date";

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

describe("daysInMonth", () => {
	test.each([
		["31日の月", "2032-03", 31],
		["30日の月", "2032-04", 30],
		["うるう年の2月", "2032-02", 29],
		["うるう年でない2月", "2033-02", 28],
		// 4 で割り切れても 100 で割り切れる年はうるう年ではないが、400 で割り切れる年はうるう年
		["2000年の2月", "2000-02", 29],
		["12月", "2032-12", 31],
	])("%s（%s）は %d 日", (_, month, expected) => {
		expect(daysInMonth(month)).toBe(expected);
	});
});
