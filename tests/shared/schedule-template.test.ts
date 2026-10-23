import { describe, expect, test } from "bun:test";
import {
	formatPeriod,
	SCHEDULE_TEMPLATE,
} from "../../src/shared/schedule-template";

describe("SCHEDULE_TEMPLATE", () => {
	test("13:10 から 20:30 までの29枠がある", () => {
		expect(SCHEDULE_TEMPLATE).toHaveLength(29);
		expect(SCHEDULE_TEMPLATE[0]?.startTime).toBe("13:10");
		expect(SCHEDULE_TEMPLATE.at(-1)?.endTime).toBe("20:30");
	});

	test("各枠の終了時刻が次の枠の開始時刻とつながっている（すき間も重なりもない）", () => {
		for (const [i, slot] of SCHEDULE_TEMPLATE.slice(0, -1).entries()) {
			expect(SCHEDULE_TEMPLATE[i + 1]?.startTime).toBe(slot.endTime);
		}
	});

	test("各枠は開始時刻が終了時刻より前", () => {
		for (const slot of SCHEDULE_TEMPLATE) {
			// HH:MM の文字列は、辞書順で比べても時刻の順になる
			expect(slot.startTime < slot.endTime).toBe(true);
		}
	});

	test("開始時刻が重複しない（DB の UNIQUE(seminarDayId, startTime) に引っかからない）", () => {
		const startTimes = SCHEDULE_TEMPLATE.map((slot) => slot.startTime);
		expect(new Set(startTimes).size).toBe(startTimes.length);
	});

	test("時限は 3〜6 で、時刻順に見て減らない", () => {
		const periods = SCHEDULE_TEMPLATE.map((slot) => slot.period);
		expect(new Set(periods)).toEqual(new Set([3, 4, 5, 6]));
		for (const [i, period] of periods.slice(0, -1).entries()) {
			expect(period).toBeLessThanOrEqual(periods[i + 1] ?? 0);
		}
	});

	test("「なし（unavailable）」は含まない（管理者が枠を編集するときに使う種類のため）", () => {
		expect(SCHEDULE_TEMPLATE.map((slot) => slot.kind)).not.toContain(
			"unavailable",
		);
	});

	test("4th の終わりは 16:30–16:40 が先生からの共有、16:40–17:00 が 5th の発表", () => {
		expect(
			SCHEDULE_TEMPLATE.filter(
				(slot) => slot.startTime >= "16:30" && slot.startTime < "17:00",
			),
		).toEqual([
			{
				period: 4,
				startTime: "16:30",
				endTime: "16:40",
				kind: "teacher_share",
			},
			{
				period: 5,
				startTime: "16:40",
				endTime: "17:00",
				kind: "presentation",
			},
		]);
	});
});

describe("formatPeriod", () => {
	test.each([
		[3, "3rd"],
		[4, "4th"],
		[5, "5th"],
		[6, "6th"],
		// 管理者が枠を編集して 3〜6 以外になっても、英語の序数として正しく出す
		[1, "1st"],
		[2, "2nd"],
		// 11〜13 は 1・2・3 で終わっても th になる
		[11, "11th"],
		[12, "12th"],
		[13, "13th"],
		[21, "21st"],
		[22, "22nd"],
		[23, "23rd"],
	])("%d は %s", (period, expected) => {
		expect(formatPeriod(period)).toBe(expected);
	});
});
