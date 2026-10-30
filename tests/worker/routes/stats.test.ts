import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { users } from "../../../src/worker/db/schema";
import { app } from "../../../src/worker/index";
import { signInAsNewUser, testEnv, useTestUsers } from "../../helpers/sign-in";
import { idAt, testData } from "../../helpers/test-data";
import { deleteSeminarDaysBetween } from "../../helpers/test-db";

// 予約を入れる開催日。ほかのテストが使っていない年にする
const TEST_RANGE = ["2037-03-01", "2037-03-31"] as const;
const DAY = "2037-03-06";
const OTHER_DAY = "2037-03-13";

type PresentationStat = {
	id: string;
	displayName: string;
	grade: string | null;
	presentationCount: number;
};

function getPresentations(cookie?: string) {
	return app.request(
		"/api/stats/presentations",
		{ headers: cookie ? { cookie } : {} },
		testEnv(),
	);
}

// テスト用 DB はほかのテストと共有しているため、このテストで作った人（ids）だけを、レスポンスの順のまま取り出す
async function statsOf(
	res: Response,
	ids: string[],
): Promise<PresentationStat[]> {
	const json = (await res.json()) as { users: PresentationStat[] };
	return json.users.filter((user) => ids.includes(user.id));
}

describe("GET /api/stats/presentations（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const {
		insertDay,
		insertUser,
		insertReservation,
		insertReservationOnNewSlot,
		signInWithProfile,
	} = testData(testUsers);

	beforeEach(async () => {
		await deleteSeminarDaysBetween(testUsers.db(), TEST_RANGE);
	});

	describe("権限", () => {
		test("未ログインなら 401 を返す", async () => {
			const res = await getPresentations();

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test("student なら 403 を返す", async () => {
			const { cookie } = await signInWithProfile("student");

			const res = await getPresentations(cookie);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: { code: "FORBIDDEN" },
			});
		});

		test.each(["teacher", "admin"] as const)(
			"%s なら 200 を返す",
			async (role) => {
				const { cookie } = await signInWithProfile(role);

				const res = await getPresentations(cookie);

				expect(res.status).toBe(200);
			},
		);
	});

	describe("回数", () => {
		test("1件ごとに id・表示名・学年・発表回数を返す", async () => {
			const { cookie } = await signInWithProfile("teacher");
			const userId = await insertUser("Shibata", "B3");
			await insertReservationOnNewSlot(DAY, userId, "done");

			const res = await getPresentations(cookie);

			expect(res.status).toBe(200);
			expect(await statsOf(res, [userId])).toEqual([
				{
					id: userId,
					displayName: "Shibata",
					grade: "B3",
					presentationCount: 1,
				},
			]);
		});

		test("done の予約だけを数え、reserved は数えない", async () => {
			const { cookie } = await signInWithProfile("teacher");
			const userId = await insertUser("Shibata", "B3");
			const slotIds = await insertDay(DAY, {
				kinds: ["presentation", "presentation", "presentation"],
			});
			await insertReservation(idAt(slotIds, 0), userId, "done");
			await insertReservation(idAt(slotIds, 1), userId, "done");
			await insertReservation(idAt(slotIds, 2), userId, "reserved");

			const res = await getPresentations(cookie);

			expect(await statsOf(res, [userId])).toMatchObject([
				{ id: userId, presentationCount: 2 },
			]);
		});

		test("予約が1件も無い人は 0 回で入る", async () => {
			const { cookie } = await signInWithProfile("teacher");
			const userId = await insertUser("Shibata", "B3");

			const res = await getPresentations(cookie);

			expect(await statsOf(res, [userId])).toMatchObject([
				{ id: userId, presentationCount: 0 },
			]);
		});

		test("reserved の予約しか無い人は 0 回で入る", async () => {
			const { cookie } = await signInWithProfile("teacher");
			const userId = await insertUser("Shibata", "B3");
			await insertReservationOnNewSlot(DAY, userId, "reserved");

			const res = await getPresentations(cookie);

			expect(await statsOf(res, [userId])).toMatchObject([
				{ id: userId, presentationCount: 0 },
			]);
		});

		test("ほかの人の予約は数えない", async () => {
			const { cookie } = await signInWithProfile("teacher");
			const aokiId = await insertUser("Aoki", "B3");
			const babaId = await insertUser("Baba", "B3");
			const slotIds = await insertDay(DAY, {
				kinds: ["presentation", "presentation", "presentation"],
			});
			await insertReservation(idAt(slotIds, 0), aokiId, "done");
			await insertReservation(idAt(slotIds, 1), aokiId, "done");
			await insertReservation(idAt(slotIds, 2), babaId, "done");

			const res = await getPresentations(cookie);

			expect(await statsOf(res, [aokiId, babaId])).toMatchObject([
				{ id: aokiId, presentationCount: 2 },
				{ id: babaId, presentationCount: 1 },
			]);
		});
	});

	// 「入らない」ことだけを確かめると、一覧が空でも通ってしまうため、入るはずの人（studentId）が入っていることも一緒に確かめる
	describe("載せる人", () => {
		test("admin（予約できる役割）は入る", async () => {
			const { cookie } = await signInWithProfile("teacher");
			const adminId = await insertUser("Admin", "M1", "admin");
			await insertReservationOnNewSlot(DAY, adminId, "done");

			const res = await getPresentations(cookie);

			expect(await statsOf(res, [adminId])).toMatchObject([
				{ id: adminId, presentationCount: 1 },
			]);
		});

		test("teacher は、done の予約が残っていても入らない", async () => {
			const { cookie } = await signInWithProfile("admin");
			const studentId = await insertUser("Shibata", "B3");
			const teacherId = await insertUser("森谷", null, "teacher");
			await insertReservationOnNewSlot(DAY, teacherId, "done");

			const res = await getPresentations(cookie);

			expect(await statsOf(res, [studentId, teacherId])).toMatchObject([
				{ id: studentId },
			]);
		});

		test("卒業生（isEnrolled = false）は、done の予約があっても入らない", async () => {
			const { cookie } = await signInWithProfile("teacher");
			const studentId = await insertUser("Shibata", "B3");
			const graduateId = await insertUser("Graduate", "B4");
			await testUsers
				.db()
				.update(users)
				.set({ isEnrolled: false })
				.where(eq(users.id, graduateId));
			await insertReservationOnNewSlot(DAY, graduateId, "done");

			const res = await getPresentations(cookie);

			expect(await statsOf(res, [studentId, graduateId])).toMatchObject([
				{ id: studentId },
			]);
		});

		test("プロフィール未登録の人は入らない", async () => {
			const { cookie } = await signInWithProfile("teacher");
			const studentId = await insertUser("Shibata", "B3");
			const email = testUsers.uniqueEmail();
			await signInAsNewUser(email);
			const [unregistered] = await testUsers
				.db()
				.select({ id: users.id })
				.from(users)
				.where(eq(users.email, email));
			if (!unregistered) {
				throw new Error("ログインしたユーザーが見つかりません");
			}

			const res = await getPresentations(cookie);

			expect(await statsOf(res, [studentId, unregistered.id])).toMatchObject([
				{ id: studentId },
			]);
		});
	});

	describe("並び順", () => {
		test("学年の順（GRADES の順）、同じ学年は表示名の順に並べ、学年の無い admin は最後にする", async () => {
			const { cookie } = await signInWithProfile("teacher");
			// 期待する順とは違う順に作る（作った順に返しているだけでも通ってしまわないように）
			const noGradeAdminId = await insertUser("Yamada", null, "admin");
			const midsB1Id = await insertUser("Abe", "MIDS_B1");
			const b4BabaId = await insertUser("Baba", "B4");
			const m1Id = await insertUser("Kato", "M1");
			const b4AokiId = await insertUser("Aoki", "B4");
			const b1Id = await insertUser("Sato", "B1");
			// 回数で並べていないことも確かめるため、後ろに並ぶ人に多く入れる
			await insertReservationOnNewSlot(DAY, noGradeAdminId, "done");
			await insertReservationOnNewSlot(OTHER_DAY, midsB1Id, "done");

			const res = await getPresentations(cookie);

			const stats = await statsOf(res, [
				noGradeAdminId,
				midsB1Id,
				b4BabaId,
				m1Id,
				b4AokiId,
				b1Id,
			]);
			expect(stats.map((user) => user.id)).toEqual([
				b1Id,
				b4AokiId,
				b4BabaId,
				m1Id,
				midsB1Id,
				noGradeAdminId,
			]);
		});
	});
});
