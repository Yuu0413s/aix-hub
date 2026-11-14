import { describe, expect, test } from "bun:test";
import { isGradeRequiredOnRegistration } from "../../src/shared/profile";

describe("isGradeRequiredOnRegistration", () => {
	test.each([
		["student", "a@stu.musashino-u.ac.jp", true],
		["teacher", "a@ds.musashino-u.ac.jp", false],
		// student と teacher は役割で決める（#13 で役割を変えた人は、ドメインと役割が食い違う）
		["student", "a@ds.musashino-u.ac.jp", true],
		["teacher", "a@stu.musashino-u.ac.jp", false],
		// admin は学生のことも先生のこともあるため、メールのドメインで決める
		["admin", "a@stu.musashino-u.ac.jp", true],
		["admin", "a@ds.musashino-u.ac.jp", false],
	] as const)("%s（%s）は %p", (role, email, expected) => {
		expect(isGradeRequiredOnRegistration({ role, email })).toBe(expected);
	});
});
