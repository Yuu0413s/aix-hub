import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import * as clock from "../../../src/worker/clock";
import { reservations, users } from "../../../src/worker/db/schema";
import { app } from "../../../src/worker/index";
import { useTestUsers } from "../../helpers/sign-in";
import { idAt, testData } from "../../helpers/test-data";
import {
	deleteSeminarDaysBetween,
	getIsolatedTestDatabaseUrl,
} from "../../helpers/test-db";

// 最後の admin の保護は、DB 全体の admin の人数で決まる。共有のテスト用 DB では、ほかのテストファイルが並列に admin を作るため
// 「admin が1人だけ」の状態を作れない。そのため、このファイルだけ専用の Neon ブランチを使い、各テストの前に admin を全員外す
const TEST_RANGE = ["2042-03-01", "2042-03-31"] as const;
const NOW = new Date("2042-03-05T12:00:00+09:00");
const DAY = "2042-03-07";
// app.request はパスだけを渡すと http://localhost に送る。ブラウザが同じオリジンから送るときと同じく、Origin を付ける
const SAME_ORIGIN = "http://localhost";

describe("最後の admin の保護（テスト専用の Neon ブランチ）", () => {
	const testUsers = useTestUsers(getIsolatedTestDatabaseUrl);
	const { insertDay, insertUser, insertReservation, signInWithProfile } =
		testData(testUsers);
	let currentTimeSpy: Mock<typeof clock.currentTime>;

	beforeEach(async () => {
		currentTimeSpy = spyOn(clock, "currentTime").mockReturnValue(NOW);
		await deleteSeminarDaysBetween(testUsers.db(), TEST_RANGE);
		await testUsers
			.db()
			.update(users)
			.set({ role: "student" })
			.where(eq(users.role, "admin"));
	});

	afterEach(() => {
		currentTimeSpy.mockRestore();
	});

	function patchUser(
		userId: string,
		cookie: string,
		role: string,
		grade?: string,
	) {
		return app.request(
			`/api/admin/users/${userId}`,
			{
				method: "PATCH",
				headers: {
					origin: SAME_ORIGIN,
					"content-type": "application/json",
					cookie,
				},
				body: JSON.stringify({ role, grade }),
			},
			testUsers.env(),
		);
	}

	function getUsers(cookie: string) {
		return app.request(
			"/api/admin/users",
			{ headers: { cookie } },
			testUsers.env(),
		);
	}

	async function findUser(userId: string) {
		const [user] = await testUsers
			.db()
			.select()
			.from(users)
			.where(eq(users.id, userId));
		if (!user) {
			throw new Error(`${userId} のユーザーが見つかりません`);
		}
		return user;
	}

	async function markGraduated(userId: string) {
		await testUsers
			.db()
			.update(users)
			.set({ isEnrolled: false })
			.where(eq(users.id, userId));
	}

	function findEnrolledAdmins() {
		return testUsers
			.db()
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.role, "admin"), eq(users.isEnrolled, true)));
	}

	describe("在籍中の admin が1人だけのとき", () => {
		test.each(["student", "teacher"] as const)(
			"その人を %s にすると 409 と LAST_ADMIN を返し、役割・学年・予約を変えない",
			async (role) => {
				const { cookie, userId } = await signInWithProfile("admin");
				const slotIds = await insertDay(DAY, { kinds: ["presentation"] });
				const reservationId = await insertReservation(idAt(slotIds, 0), userId);

				const res = await patchUser(userId, cookie, role);

				expect(res.status).toBe(409);
				expect(await res.json()).toMatchObject({
					error: { code: "LAST_ADMIN" },
				});
				expect(await findUser(userId)).toMatchObject({
					role: "admin",
					grade: "B3",
				});
				expect(
					await testUsers
						.db()
						.select({ id: reservations.id })
						.from(reservations)
						.where(eq(reservations.id, reservationId)),
				).toHaveLength(1);
			},
		);

		test("その人に admin を送っても 200 を返す", async () => {
			const { cookie, userId } = await signInWithProfile("admin");

			const res = await patchUser(userId, cookie, "admin");

			expect(res.status).toBe(200);
			expect((await findUser(userId)).role).toBe("admin");
		});

		test("ほかの人の役割は変えられる", async () => {
			const { cookie } = await signInWithProfile("admin");
			const userId = await insertUser("Shibata", "B3");

			const res = await patchUser(userId, cookie, "teacher");

			expect(res.status).toBe(200);
			expect((await findUser(userId)).role).toBe("teacher");
		});

		describe("その人に学年が無いとき", () => {
			async function signInAsAdminWithoutGrade() {
				const admin = await signInWithProfile("admin");
				await testUsers
					.db()
					.update(users)
					.set({ grade: null })
					.where(eq(users.id, admin.userId));
				return admin;
			}

			test("学年を送らずに student にすると、GRADE_REQUIRED を返す", async () => {
				const { cookie, userId } = await signInAsAdminWithoutGrade();

				const res = await patchUser(userId, cookie, "student");

				expect(res.status).toBe(409);
				expect(await res.json()).toMatchObject({
					error: { code: "GRADE_REQUIRED" },
				});
			});

			test("学年を送って student にしても、LAST_ADMIN を返し、学年を保存しない", async () => {
				const { cookie, userId } = await signInAsAdminWithoutGrade();

				const res = await patchUser(userId, cookie, "student", "M1");

				expect(res.status).toBe(409);
				expect(await res.json()).toMatchObject({
					error: { code: "LAST_ADMIN" },
				});
				expect(await findUser(userId)).toMatchObject({
					role: "admin",
					grade: null,
				});
			});
		});

		test("卒業生の admin が残っていても、在籍中の最後の1人は外せない", async () => {
			const { cookie, userId } = await signInWithProfile("admin");
			const graduateId = await insertUser("卒業生", "B4", "admin");
			await markGraduated(graduateId);

			const res = await patchUser(userId, cookie, "student");

			expect(res.status).toBe(409);
			expect((await findUser(userId)).role).toBe("admin");
		});

		test("卒業生の admin は外せる", async () => {
			const { cookie } = await signInWithProfile("admin");
			const graduateId = await insertUser("卒業生", "B4", "admin");
			await markGraduated(graduateId);

			const res = await patchUser(graduateId, cookie, "student");

			expect(res.status).toBe(200);
			expect((await findUser(graduateId)).role).toBe("student");
		});
	});

	describe("在籍中の admin が2人以上のとき", () => {
		test("もう1人を外せる", async () => {
			const { cookie } = await signInWithProfile("admin");
			const otherId = await insertUser("Mori", "B3", "admin");

			const res = await patchUser(otherId, cookie, "student");

			expect(res.status).toBe(200);
			expect((await findUser(otherId)).role).toBe("student");
		});

		test("自分を外せて、次のリクエストから管理画面の API を使えなくなる", async () => {
			const { cookie, userId } = await signInWithProfile("admin");
			await insertUser("Mori", "B3", "admin");

			const res = await patchUser(userId, cookie, "student");

			expect(res.status).toBe(200);
			expect((await getUsers(cookie)).status).toBe(403);
		});

		test("1人ずつ外していくと、最後の1人で 409 になる", async () => {
			const { cookie, userId } = await signInWithProfile("admin");
			const otherId = await insertUser("Mori", "B3", "admin");

			expect((await patchUser(otherId, cookie, "student")).status).toBe(200);
			expect((await patchUser(userId, cookie, "student")).status).toBe(409);
		});
	});

	describe("admin が卒業生だけのとき", () => {
		test("その人を外すと 409 を返す", async () => {
			const { cookie, userId } = await signInWithProfile("admin");
			await markGraduated(userId);

			const res = await patchUser(userId, cookie, "student");

			expect(res.status).toBe(409);
			expect((await findUser(userId)).role).toBe("admin");
		});

		test("もう1人の卒業生の admin を外すと 409 を返す", async () => {
			const { cookie, userId } = await signInWithProfile("admin");
			const otherId = await insertUser("卒業生", "B4", "admin");
			await markGraduated(userId);
			await markGraduated(otherId);

			const res = await patchUser(otherId, cookie, "student");

			expect(res.status).toBe(409);
			expect((await findUser(otherId)).role).toBe("admin");
		});

		// admin でない人の変更には人数の条件を掛けない。これを止めると、卒業生の admin が新しい admin を作れず行き詰まる
		test("student を admin にできる", async () => {
			const { cookie, userId } = await signInWithProfile("admin");
			const studentId = await insertUser("Shibata", "B3");
			await markGraduated(userId);

			const res = await patchUser(studentId, cookie, "admin");

			expect(res.status).toBe(200);
			expect(await findEnrolledAdmins()).toEqual([{ id: studentId }]);
		});
	});

	describe("同時の操作", () => {
		// ロックなしの条件付き UPDATE だと、互いに「もう1人いる」と読んで両方とも通り、admin が0人になる
		test("2人が同時に互いを外しても、成功するのは1件だけで、admin が1人残る", async () => {
			const first = await signInWithProfile("admin");
			const second = await signInWithProfile("admin");

			// タイミングで結果が変わる処理のため、1回だけ通っても安心できないので繰り返す
			for (let round = 0; round < 5; round++) {
				await testUsers
					.db()
					.update(users)
					.set({ role: "admin" })
					.where(eq(users.id, first.userId));
				await testUsers
					.db()
					.update(users)
					.set({ role: "admin" })
					.where(eq(users.id, second.userId));

				const responses = await Promise.all([
					patchUser(second.userId, first.cookie, "student"),
					patchUser(first.userId, second.cookie, "student"),
				]);

				// 片方は成功する。もう片方は、ロックを待ったあとなら最後の admin として 409、
				// 先の変更が確定してから入口の権限の確認に来たなら、すでに admin でないため 403 になる
				const statuses = responses.map((res) => res.status).sort();
				expect(statuses[0]).toBe(200);
				expect([403, 409]).toContain(statuses[1] ?? 0);
				expect(await findEnrolledAdmins()).toHaveLength(1);
			}
			// 5回分の往復があり、既定の上限（5秒）では足りない
		}, 60_000);

		test("2人が同時に自分を外しても、成功するのは1件だけで、admin が1人残る", async () => {
			const first = await signInWithProfile("admin");
			const second = await signInWithProfile("admin");

			const responses = await Promise.all([
				patchUser(first.userId, first.cookie, "teacher"),
				patchUser(second.userId, second.cookie, "teacher"),
			]);

			expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
			expect(await findEnrolledAdmins()).toHaveLength(1);
			// ログインと同時の更新の往復があり、既定の上限（5秒）では足りないことがある
		}, 60_000);
	});
});
