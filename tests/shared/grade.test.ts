import { describe, expect, test } from "bun:test";
import { formatDisplayName, formatGrade, GRADES } from "../../src/shared/grade";
import { grade } from "../../src/worker/db/schema";

describe("GRADES", () => {
	test("DB の enum と同じ値を、同じ順で持つ", () => {
		expect(grade.enumValues).toEqual([...GRADES]);
	});
});

describe("formatGrade", () => {
	test.each([
		["B1", "B1"],
		["B2", "B2"],
		["B3", "B3"],
		["B4", "B4"],
		["M1", "M1"],
		["M2", "M2"],
		["MIDS_B1", "MIDS B1"],
		["MIDS_B2", "MIDS B2"],
		["MIDS_B3", "MIDS B3"],
		["MIDS_B4", "MIDS B4"],
	] as const)("%s は %s と表示する", (value, expected) => {
		expect(formatGrade(value)).toBe(expected);
	});

	// 上の表に学年を足し忘れたまま「全部通った」にならないよう、件数をそろえる
	test("上の表は全学年を網羅している", () => {
		expect(GRADES).toHaveLength(10);
	});
});

describe("formatDisplayName", () => {
	test("学年を括弧で後ろに付ける", () => {
		expect(formatDisplayName("Shibata", "B3")).toBe("Shibata(B3)");
	});

	test("MIDS の学年は空白区切りで表示する", () => {
		expect(formatDisplayName("森谷", "MIDS_B3")).toBe("森谷(MIDS B3)");
	});

	test("学年が無い（教員）ときは名前だけにする", () => {
		expect(formatDisplayName("森谷", null)).toBe("森谷");
	});
});
