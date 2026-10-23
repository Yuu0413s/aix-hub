import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import * as cron from "../../src/worker/cron";
import worker from "../../src/worker/index";
import { TEST_AUTH_ENV } from "../helpers/sign-in";

const ENV = { DATABASE_URL: "postgresql://localhost/test", ...TEST_AUTH_ENV };

let runScheduledSpy: Mock<typeof cron.runScheduled>;

beforeEach(() => {
	runScheduledSpy = spyOn(cron, "runScheduled").mockResolvedValue();
});

afterEach(() => {
	runScheduledSpy.mockRestore();
});

describe("scheduled", () => {
	test("Cron が起動する予定だった時刻を、現在時刻として渡す", async () => {
		const scheduledTime = Date.parse("2030-01-03T15:05:00Z");

		await worker.scheduled({ scheduledTime }, ENV);

		expect(runScheduledSpy).toHaveBeenCalledWith(ENV, new Date(scheduledTime));
	});
});
