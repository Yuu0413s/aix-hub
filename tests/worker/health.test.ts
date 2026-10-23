import { describe, expect, test } from "bun:test";
import { app } from "../../src/worker/index";

describe("GET /api/health", () => {
	test("200 と status: ok を返す", async () => {
		const res = await app.request("/api/health");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});
});
