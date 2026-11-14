import { describe, expect, test } from "bun:test";
import { roleForEmail } from "../../src/shared/auth";

describe("roleForEmail", () => {
	test.each([
		["a@stu.musashino-u.ac.jp", "student"],
		["a@ds.musashino-u.ac.jp", "teacher"],
	] as const)("%s は %s", (email, role) => {
		expect(roleForEmail(email)).toBe(role);
	});

	test("大文字・小文字は区別しない", () => {
		expect(roleForEmail("A@STU.MUSASHINO-U.AC.JP")).toBe("student");
		expect(roleForEmail("A@DS.MUSASHINO-U.AC.JP")).toBe("teacher");
	});

	test.each([
		["大学の共通ドメイン", "a@musashino-u.ac.jp"],
		["大学外のドメイン", "a@gmail.com"],
		["末尾だけが一致するドメイン", "a@evil-musashino-u.ac.jp"],
		["2ドメインのサブドメイン", "a@x.stu.musashino-u.ac.jp"],
		["@ が2つある", "a@b@stu.musashino-u.ac.jp"],
		["@ が無い", "stu.musashino-u.ac.jp"],
		["@ より前が空", "@stu.musashino-u.ac.jp"],
		["空文字", ""],
	])("%s は null: %s", (_, email) => {
		expect(roleForEmail(email)).toBeNull();
	});
});
