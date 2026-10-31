import { describe, expect, test } from "bun:test";
import {
	addMonths,
	daysInMonth,
	fridaysInMonth,
	isDate,
	isFriday,
	tokyoDate,
} from "../../src/shared/date";

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

describe("isDate", () => {
	test.each([
		["普通の日", "2032-03-05"],
		["うるう年の2月29日", "2032-02-29"],
		["範囲の端（2000年）", "2000-01-01"],
		["範囲の端（2099年）", "2099-12-31"],
	])("%s（%s）は true", (_, value) => {
		expect(isDate(value)).toBe(true);
	});

	test.each([
		// 形式は合っていても実在しない日（通すと PostgreSQL の date に変換できず 500 になる）
		["うるう年でない2月29日", "2031-02-29"],
		["2月30日", "2032-02-30"],
		["4月31日", "2032-04-31"],
		["0日", "2032-03-00"],
		["13月", "2032-13-01"],
		// 年は月と同じく 2000〜2099 に絞る（MONTH_PATTERN と同じ理由）
		["1999年", "1999-12-31"],
		["2100年", "2100-01-01"],
		["月日が1桁", "2032-3-5"],
		["区切りが無い", "20320305"],
		["年月だけ", "2032-03"],
		["後ろに時刻が付いている", "2032-03-05T00:00"],
		["空文字", ""],
	])("%s（%s）は false", (_, value) => {
		expect(isDate(value)).toBe(false);
	});
});

describe("isFriday", () => {
	test("金曜（2032-03-05）は true", () => {
		expect(isFriday("2032-03-05")).toBe(true);
	});

	test.each([
		["木曜", "2032-03-04"],
		["土曜", "2032-03-06"],
		["日曜", "2032-03-07"],
	])("%s（%s）は false", (_, value) => {
		expect(isFriday(value)).toBe(false);
	});
});

describe("fridaysInMonth", () => {
	test("金曜が4回ある月は4件を日付の順に返す", () => {
		expect(fridaysInMonth("2032-03")).toEqual([
			"2032-03-05",
			"2032-03-12",
			"2032-03-19",
			"2032-03-26",
		]);
	});

	test("1日が金曜の月は、1日を含めて5件を返す", () => {
		expect(fridaysInMonth("2032-10")).toEqual([
			"2032-10-01",
			"2032-10-08",
			"2032-10-15",
			"2032-10-22",
			"2032-10-29",
		]);
	});

	test("末日が金曜の月は、末日を含め、翌月の日を含めない", () => {
		expect(fridaysInMonth("2032-12")).toEqual([
			"2032-12-03",
			"2032-12-10",
			"2032-12-17",
			"2032-12-24",
			"2032-12-31",
		]);
	});
});
