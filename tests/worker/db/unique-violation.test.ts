import { describe, expect, test } from "bun:test";
import { isUniqueViolation } from "../../../src/worker/db/unique-violation";

const CONSTRAINT = "slots_seminarDayId_startTime_unique";

// Neon のエラーと同じく、code と constraint を持つエラーを作る（DB を使わずに分岐を確かめるため）
function dbError(code: string, constraint: string) {
	return Object.assign(new Error("db error"), { code, constraint });
}

describe("isUniqueViolation", () => {
	test("指定した制約の UNIQUE 違反なら true を返す", () => {
		expect(isUniqueViolation(dbError("23505", CONSTRAINT), CONSTRAINT)).toBe(
			true,
		);
	});

	test("cause に包まれていても、たどって true を返す", () => {
		// Drizzle が DB のエラーを DrizzleQueryError で包む形を、cause を2段にして確かめる
		const wrapped = new Error("outer", {
			cause: new Error("middle", { cause: dbError("23505", CONSTRAINT) }),
		});

		expect(isUniqueViolation(wrapped, CONSTRAINT)).toBe(true);
	});

	test("ほかの制約の UNIQUE 違反なら false を返す", () => {
		expect(
			isUniqueViolation(
				dbError("23505", "reservations_slotId_unique"),
				CONSTRAINT,
			),
		).toBe(false);
	});

	test("UNIQUE 違反でないエラーコードなら、制約の名前が同じでも false を返す", () => {
		// 23514 は CHECK 制約の違反
		expect(isUniqueViolation(dbError("23514", CONSTRAINT), CONSTRAINT)).toBe(
			false,
		);
	});

	test("code や constraint を持たない Error なら false を返す", () => {
		expect(isUniqueViolation(new Error("network"), CONSTRAINT)).toBe(false);
	});

	test.each([
		["文字列", "23505"],
		["null", null],
		[
			"code と constraint を持つが Error でない値",
			{ code: "23505", constraint: CONSTRAINT },
		],
	])("Error でない値（%s）なら false を返す", (_, value) => {
		expect(isUniqueViolation(value, CONSTRAINT)).toBe(false);
	});
});
