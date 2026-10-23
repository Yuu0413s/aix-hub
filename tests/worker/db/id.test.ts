import { describe, expect, test } from "bun:test";
import { createId } from "../../../src/worker/db/id";

describe("createId", () => {
	test("better-auth の id と同じ形式（英数字32文字）を返す", () => {
		expect(createId()).toMatch(/^[A-Za-z0-9]{32}$/);
	});

	test("呼ぶたびに違う値を返す", () => {
		const ids = Array.from({ length: 100 }, () => createId());
		expect(new Set(ids).size).toBe(ids.length);
	});
});
