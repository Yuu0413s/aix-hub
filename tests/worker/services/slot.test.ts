import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { SlotKind } from "../../../src/shared/schedule-template";
import { slots } from "../../../src/worker/db/schema";
import { type SlotInput, updateSlot } from "../../../src/worker/services/slot";
import { useTestUsers } from "../../helpers/sign-in";
import { idAt, testData } from "../../helpers/test-data";
import { deleteSeminarDaysBetween } from "../../helpers/test-db";

// ほかのテストが使っていない年にする。2040-02-24・03-02・03-09 は金曜。
// 日本時間（+09:00）の時刻で書き、UTC との違いが分かるようにする
const TEST_RANGE = ["2040-02-01", "2040-03-31"] as const;
const DAY = "2040-03-02";
const OTHER_DAY = "2040-03-09";
const PAST_DAY = "2040-02-24";
// 開催日の前日。DAY のどの枠もまだ始まっていない
const BEFORE_DAY = new Date("2040-03-01T12:00:00+09:00");

describe("updateSlot（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const {
		insertDay,
		insertDayWithSlots,
		insertUser,
		insertReservation,
		isReservationExisting,
	} = testData(testUsers);

	beforeEach(async () => {
		await deleteSeminarDaysBetween(testUsers.db(), TEST_RANGE);
	});

	async function findSlot(slotId: string) {
		const [slot] = await testUsers
			.db()
			.select({
				period: slots.period,
				startTime: slots.startTime,
				endTime: slots.endTime,
				kind: slots.kind,
			})
			.from(slots)
			.where(eq(slots.id, slotId));
		return slot;
	}

	// 画面で見ていた変更前の値（previous）を省いたときは、今の DB の値を送る（ほかの管理者が先に変えていない状態）
	async function edit(
		slotId: string,
		input: SlotInput,
		{ now = BEFORE_DAY, previous }: { now?: Date; previous?: SlotInput } = {},
	) {
		return updateSlot(testUsers.db(), {
			slotId,
			input,
			previous: previous ?? (await currentValues(slotId)),
			now,
		});
	}

	// 枠の今の値を、API に送る形（時刻は HH:MM）で返す。枠が無ければ、適当な値を返す（存在しない枠のテスト用）
	async function currentValues(slotId: string): Promise<SlotInput> {
		const slot = await findSlot(slotId);
		if (!slot) {
			return { kind: "presentation", startTime: "13:00", endTime: "13:10" };
		}
		return {
			kind: slot.kind,
			startTime: slot.startTime.slice(0, 5),
			endTime: slot.endTime.slice(0, 5),
		};
	}

	// insertDay は枠を 13:00 から10分ずつ作る（1つ目は 13:00〜13:10、2つ目は 13:10〜13:20）
	async function insertReservedSlot(date = DAY) {
		const slotIds = await insertDay(date, { kinds: ["presentation"] });
		const slotId = idAt(slotIds, 0);
		const userId = await insertUser("Shibata", "B3");
		const reservationId = await insertReservation(slotId, userId);
		return { slotId, reservationId };
	}

	describe("変更", () => {
		test("種類・開始時刻・終了時刻を変え、変えた枠を返す。時限は変えない", async () => {
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
			const slotId = idAt(slotIds, 0);

			const result = await edit(slotId, {
				kind: "teacher_share",
				startTime: "13:05",
				endTime: "13:25",
			});

			expect(result).toEqual({
				ok: true,
				slot: {
					id: slotId,
					period: 3,
					startTime: "13:05:00",
					endTime: "13:25:00",
					kind: "teacher_share",
				},
				deletedReservationCount: 0,
			});
			expect(await findSlot(slotId)).toEqual({
				period: 3,
				startTime: "13:05:00",
				endTime: "13:25:00",
				kind: "teacher_share",
			});
		});

		test("開始時刻を変えず、終了時刻だけを変えられる（自分の開始時刻とはぶつからない）", async () => {
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
			const slotId = idAt(slotIds, 0);

			const result = await edit(slotId, {
				kind: "presentation",
				startTime: "13:00",
				endTime: "13:20",
			});

			expect(result.ok).toBe(true);
			expect(await findSlot(slotId)).toMatchObject({ endTime: "13:20:00" });
		});

		test("別の日の枠と開始時刻が同じでも変えられる", async () => {
			// OTHER_DAY の枠は 13:00 から
			await insertDay(OTHER_DAY, { kinds: ["presentation"] });
			const slotIds = await insertDayWithSlots(DAY, [
				{ period: 3, startTime: "14:00", endTime: "14:10", kind: "break" },
			]);
			const slotId = idAt(slotIds, 0);

			const result = await edit(slotId, {
				kind: "break",
				startTime: "13:00",
				endTime: "13:10",
			});

			expect(result.ok).toBe(true);
			expect(await findSlot(slotId)).toMatchObject({ startTime: "13:00:00" });
		});

		test("休止日の枠も変えられる", async () => {
			const slotIds = await insertDay(DAY, {
				kinds: ["presentation"],
				status: "closed",
			});
			const slotId = idAt(slotIds, 0);

			const result = await edit(slotId, {
				kind: "break",
				startTime: "13:00",
				endTime: "13:10",
			});

			expect(result.ok).toBe(true);
			expect(await findSlot(slotId)).toMatchObject({ kind: "break" });
		});
	});

	describe("予約の削除", () => {
		test.each([
			"break",
			"teacher_share",
			"unavailable",
		] as const satisfies SlotKind[])(
			"予約のある発表の枠を %s にすると、予約を消し、件数 1 を返す",
			async (kind) => {
				const { slotId, reservationId } = await insertReservedSlot();

				const result = await edit(slotId, {
					kind,
					startTime: "13:00",
					endTime: "13:10",
				});

				expect(result).toMatchObject({ ok: true, deletedReservationCount: 1 });
				expect(await isReservationExisting(reservationId)).toBe(false);
				expect(await findSlot(slotId)).toMatchObject({ kind });
			},
		);

		test("発表のまま時刻だけを変えると、予約は残り、件数 0 を返す", async () => {
			const { slotId, reservationId } = await insertReservedSlot();

			const result = await edit(slotId, {
				kind: "presentation",
				startTime: "13:30",
				endTime: "13:50",
			});

			expect(result).toMatchObject({ ok: true, deletedReservationCount: 0 });
			expect(await isReservationExisting(reservationId)).toBe(true);
			expect(await findSlot(slotId)).toMatchObject({
				startTime: "13:30:00",
				endTime: "13:50:00",
			});
		});

		test("予約の無い発表の枠を break にすると、件数 0 を返す", async () => {
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });

			const result = await edit(idAt(slotIds, 0), {
				kind: "break",
				startTime: "13:00",
				endTime: "13:10",
			});

			expect(result).toMatchObject({ ok: true, deletedReservationCount: 0 });
		});

		// 予約は API からは発表の枠にしか入らないが、DB は発表以外の枠の予約を禁止していない（手作業で DB を直したときなど）。
		// そのような予約も、種類を発表から変えないかぎり消さない（時刻だけの変更なら予約は残す）
		test.each([
			["時刻だけを変える", "break"],
			["発表以外の別の種類に変える", "unavailable"],
		] as const)(
			"予約のある休憩の枠で%sときは、予約を消さず、件数 0 を返す",
			async (_, kind) => {
				const slotIds = await insertDay(DAY, { kinds: ["break"] });
				const slotId = idAt(slotIds, 0);
				const userId = await insertUser("Shibata", "B3");
				const reservationId = await insertReservation(slotId, userId);

				const result = await edit(slotId, {
					kind,
					startTime: "13:00",
					endTime: "13:20",
				});

				expect(result).toMatchObject({ ok: true, deletedReservationCount: 0 });
				expect(await isReservationExisting(reservationId)).toBe(true);
				expect(await findSlot(slotId)).toMatchObject({
					kind,
					endTime: "13:20:00",
				});
			},
		);

		test("ほかの枠の予約は消さない", async () => {
			const slotIds = await insertDay(DAY, {
				kinds: ["presentation", "presentation"],
			});
			const userId = await insertUser("Shibata", "B3");
			const otherReservationId = await insertReservation(
				idAt(slotIds, 1),
				userId,
			);

			const result = await edit(idAt(slotIds, 0), {
				kind: "break",
				startTime: "13:00",
				endTime: "13:10",
			});

			expect(result).toMatchObject({ ok: true, deletedReservationCount: 0 });
			expect(await isReservationExisting(otherReservationId)).toBe(true);
		});
	});

	describe("開始時刻の重なり", () => {
		test("開始時刻が同じ日の別の枠と同じなら SLOT_START_TIME_TAKEN を返し、枠を変えない", async () => {
			// 1つ目は 13:00〜13:10、2つ目は 13:10〜13:20
			const slotIds = await insertDay(DAY, {
				kinds: ["presentation", "break"],
			});
			const slotId = idAt(slotIds, 1);

			const result = await edit(slotId, {
				kind: "teacher_share",
				startTime: "13:00",
				endTime: "13:20",
			});

			expect(result).toEqual({ ok: false, reason: "SLOT_START_TIME_TAKEN" });
			expect(await findSlot(slotId)).toEqual({
				period: 3,
				startTime: "13:10:00",
				endTime: "13:20:00",
				kind: "break",
			});
		});

		test("開始時刻がぶつかって失敗したときは、種類を break にしようとしていても予約を消さない", async () => {
			// 1つ目（13:00）に予約を入れ、2つ目（13:10）の開始時刻とぶつける
			const slotIds = await insertDay(DAY, {
				kinds: ["presentation", "presentation"],
			});
			const slotId = idAt(slotIds, 0);
			const userId = await insertUser("Shibata", "B3");
			const reservationId = await insertReservation(slotId, userId);

			const result = await edit(slotId, {
				kind: "break",
				startTime: "13:10",
				endTime: "13:20",
			});

			expect(result).toEqual({ ok: false, reason: "SLOT_START_TIME_TAKEN" });
			expect(await isReservationExisting(reservationId)).toBe(true);
			expect(await findSlot(slotId)).toMatchObject({
				kind: "presentation",
				startTime: "13:00:00",
			});
		});
	});

	describe("ほかの管理者が先に変えていた枠", () => {
		test("変更前の種類が今の種類と違えば SLOT_CHANGED を返し、枠を変えない（古い画面から presentation に戻さない）", async () => {
			// ほかの管理者が break にした枠を、presentation のままの古い画面から、終了時刻だけ変えて保存する
			const slotIds = await insertDay(DAY, { kinds: ["break"] });
			const slotId = idAt(slotIds, 0);

			const result = await edit(
				slotId,
				{ kind: "presentation", startTime: "13:00", endTime: "13:20" },
				{
					previous: {
						kind: "presentation",
						startTime: "13:00",
						endTime: "13:10",
					},
				},
			);

			expect(result).toEqual({ ok: false, reason: "SLOT_CHANGED" });
			expect(await findSlot(slotId)).toMatchObject({
				kind: "break",
				endTime: "13:10:00",
			});
		});

		test("変更前の時刻が今の時刻と違えば SLOT_CHANGED を返し、種類を break にしようとしていても予約を消さない", async () => {
			// 今は 13:00〜13:10。古い画面では 13:00〜13:20 だった
			const { slotId, reservationId } = await insertReservedSlot();

			const result = await edit(
				slotId,
				{ kind: "break", startTime: "13:00", endTime: "13:20" },
				{
					previous: {
						kind: "presentation",
						startTime: "13:00",
						endTime: "13:20",
					},
				},
			);

			expect(result).toEqual({ ok: false, reason: "SLOT_CHANGED" });
			expect(await isReservationExisting(reservationId)).toBe(true);
			expect(await findSlot(slotId)).toMatchObject({
				kind: "presentation",
				endTime: "13:10:00",
			});
		});

		test("開始時刻を過ぎた枠は、変更前の値が違っていても SLOT_STARTED を返す（取り直しても変えられないため）", async () => {
			const slotIds = await insertDay(PAST_DAY, { kinds: ["break"] });

			const result = await edit(
				idAt(slotIds, 0),
				{ kind: "presentation", startTime: "13:00", endTime: "13:10" },
				{
					previous: {
						kind: "presentation",
						startTime: "13:00",
						endTime: "13:10",
					},
				},
			);

			expect(result).toEqual({ ok: false, reason: "SLOT_STARTED" });
		});
	});

	describe("変えられない枠", () => {
		test("存在しない枠なら SLOT_NOT_FOUND を返す", async () => {
			const result = await edit("0".repeat(32), {
				kind: "break",
				startTime: "13:00",
				endTime: "13:10",
			});

			expect(result).toEqual({ ok: false, reason: "SLOT_NOT_FOUND" });
		});

		test("今日の開始時刻を過ぎた枠（ちょうども含む）は SLOT_STARTED を返し、枠も予約も変えない", async () => {
			// 13:00 と 13:10 の枠。13:10 ちょうどには、どちらも開始時刻を過ぎている
			const slotIds = await insertDay(DAY, {
				kinds: ["presentation", "presentation"],
			});
			const userId = await insertUser("Shibata", "B3");
			const reservationIds = [
				await insertReservation(idAt(slotIds, 0), userId),
				await insertReservation(idAt(slotIds, 1), userId),
			];
			const now = new Date(`${DAY}T13:10:00+09:00`);

			for (const slotId of slotIds) {
				const result = await edit(
					slotId,
					{ kind: "break", startTime: "15:00", endTime: "15:10" },
					{ now },
				);
				expect(result).toEqual({ ok: false, reason: "SLOT_STARTED" });
				expect(await findSlot(slotId)).toMatchObject({
					kind: "presentation",
				});
			}
			for (const reservationId of reservationIds) {
				expect(await isReservationExisting(reservationId)).toBe(true);
			}
		});

		test("今日の開始前の枠は変えられる", async () => {
			// 13:00 と 13:10 の枠。13:09 には2つ目はまだ始まっていない
			const slotIds = await insertDay(DAY, {
				kinds: ["presentation", "presentation"],
			});
			const now = new Date(`${DAY}T13:09:59+09:00`);

			const result = await edit(
				idAt(slotIds, 1),
				{ kind: "break", startTime: "13:10", endTime: "13:20" },
				{ now },
			);

			expect(result.ok).toBe(true);
		});

		test("UTC の時刻では開始前に見えても、日本時間で開始時刻を過ぎた枠は SLOT_STARTED を返す", async () => {
			const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
			// 日本時間 13:00 = UTC 04:00。開始時刻（13:00）を UTC の時刻として比べると、まだ始まっていないことになる
			const now = new Date("2040-03-02T04:00:00Z");

			const result = await edit(
				idAt(slotIds, 0),
				{ kind: "break", startTime: "13:00", endTime: "13:10" },
				{ now },
			);

			expect(result).toEqual({ ok: false, reason: "SLOT_STARTED" });
		});

		test("今日より前の日の枠は SLOT_STARTED を返し、予約を消さない", async () => {
			const { slotId, reservationId } = await insertReservedSlot(PAST_DAY);

			const result = await edit(slotId, {
				kind: "break",
				startTime: "13:00",
				endTime: "13:10",
			});

			expect(result).toEqual({ ok: false, reason: "SLOT_STARTED" });
			expect(await isReservationExisting(reservationId)).toBe(true);
			expect(await findSlot(slotId)).toMatchObject({ kind: "presentation" });
		});
	});
});
