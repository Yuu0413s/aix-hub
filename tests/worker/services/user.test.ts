import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Grade } from "../../../src/shared/grade";
import type { UserRole } from "../../../src/shared/user-role";
import { createId } from "../../../src/worker/db/id";
import { users } from "../../../src/worker/db/schema";
import { updateUserRole } from "../../../src/worker/services/user";
import { useTestUsers } from "../../helpers/sign-in";
import { idAt, testData } from "../../helpers/test-data";
import { deleteSeminarDaysBetween } from "../../helpers/test-db";

// ほかのテストが使っていない年にする。2043-03-06 は金曜。開始前の予約を作るため、NOW はその前にする
const TEST_RANGE = ["2043-03-01", "2043-03-31"] as const;
const DAY = "2043-03-06";
const NOW = new Date("2043-03-04T12:00:00+09:00");

// 入口の権限の確認を通ったあとに、操作者が外されたときの動き。この順番はルートのテストでは作れない
// （入口で 403 になる）ため、すでに admin でない操作者の id で services を直接呼ぶ
describe("updateUserRole の操作者の確認（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const { insertDay, insertUser, insertReservation, isReservationExisting } =
		testData(testUsers);

	beforeEach(async () => {
		await deleteSeminarDaysBetween(testUsers.db(), TEST_RANGE);
	});

	function changeRole(input: {
		actorId: string;
		userId: string;
		role: UserRole;
		grade?: Grade;
	}) {
		return updateUserRole(testUsers.db(), { ...input, now: NOW });
	}

	async function findUser(userId: string) {
		const [user] = await testUsers
			.db()
			.select({ role: users.role, grade: users.grade })
			.from(users)
			.where(eq(users.id, userId));
		return user;
	}

	test("操作者が admin なら変更する", async () => {
		const actorId = await insertUser("管理者", "M1", "admin");
		const userId = await insertUser("Shibata", "B3");

		const result = await changeRole({ actorId, userId, role: "admin" });

		expect(result).toMatchObject({ ok: true });
		expect(await findUser(userId)).toEqual({ role: "admin", grade: "B3" });
	});

	// 入口と同じく、役割だけを見る（在籍中かどうかは見ない）
	test("操作者が卒業生の admin でも変更する", async () => {
		const actorId = await insertUser("管理者", "M1", "admin");
		await testUsers
			.db()
			.update(users)
			.set({ isEnrolled: false })
			.where(eq(users.id, actorId));
		const userId = await insertUser("Shibata", "B3");

		const result = await changeRole({ actorId, userId, role: "admin" });

		expect(result).toMatchObject({ ok: true });
	});

	test.each(["student", "teacher"] as const)(
		"操作者が %s に外されていたら FORBIDDEN を返し、役割を変えない",
		async (actorRole) => {
			const actorId = await insertUser("元管理者", null, actorRole);
			const userId = await insertUser("Shibata", "B3");

			const result = await changeRole({ actorId, userId, role: "admin" });

			expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
			expect(await findUser(userId)).toEqual({ role: "student", grade: "B3" });
		},
	);

	test("外された本人が自分を admin に戻そうとしても FORBIDDEN を返し、役割を変えない", async () => {
		const actorId = await insertUser("元管理者", "M1");

		const result = await changeRole({
			actorId,
			userId: actorId,
			role: "admin",
		});

		expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
		expect(await findUser(actorId)).toEqual({ role: "student", grade: "M1" });
	});

	test("操作者がもういないときも FORBIDDEN を返す", async () => {
		const userId = await insertUser("Shibata", "B3");

		const result = await changeRole({
			actorId: createId(),
			userId,
			role: "admin",
		});

		expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
		expect(await findUser(userId)).toEqual({ role: "student", grade: "B3" });
	});

	test("teacher への変更でも FORBIDDEN なら、学年と開始前の予約を残す", async () => {
		const actorId = await insertUser("元管理者", "M1");
		const userId = await insertUser("Shibata", "B3");
		const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
		const reservationId = await insertReservation(idAt(slotIds, 0), userId);

		const result = await changeRole({ actorId, userId, role: "teacher" });

		expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
		expect(await findUser(userId)).toEqual({ role: "student", grade: "B3" });
		expect(await isReservationExisting(reservationId)).toBe(true);
	});

	test("学年を送っても FORBIDDEN なら、学年を保存しない", async () => {
		const actorId = await insertUser("元管理者", "M1");
		const userId = await insertUser("森谷", null);

		const result = await changeRole({
			actorId,
			userId,
			role: "student",
			grade: "B3",
		});

		expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
		expect(await findUser(userId)).toEqual({ role: "student", grade: null });
	});

	// 権限の無い人に、相手の状態を教えない
	test("相手がいないときも、USER_NOT_FOUND より先に FORBIDDEN を返す", async () => {
		const actorId = await insertUser("元管理者", "M1");

		const result = await changeRole({
			actorId,
			userId: createId(),
			role: "admin",
		});

		expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
	});

	test("学年が足りないときも、GRADE_REQUIRED より先に FORBIDDEN を返す", async () => {
		const actorId = await insertUser("元管理者", "M1");
		const userId = await insertUser("森谷", null, "teacher");

		const result = await changeRole({ actorId, userId, role: "student" });

		expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
	});
});
