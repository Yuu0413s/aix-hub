import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import { Pool, type PoolClient } from "@neondatabase/serverless";
import { and, eq } from "drizzle-orm";
import type { Grade, GradePromotionPath } from "../../../src/shared/grade";
import * as clock from "../../../src/worker/clock";
import { createId } from "../../../src/worker/db/id";
import {
	gradePromotions,
	reservations,
	users,
} from "../../../src/worker/db/schema";
import { app } from "../../../src/worker/index";
import { updateUserRole } from "../../../src/worker/services/user";
import { useTestUsers } from "../../helpers/sign-in";
import {
	idAt,
	type ReservationStatus,
	testData,
} from "../../helpers/test-data";
import {
	deleteSeminarDaysBetween,
	getIsolatedTestDatabaseUrl,
} from "../../helpers/test-db";

// DB 全体の状態を前提にするテスト。専用の Neon ブランチを使う（docs/conventions/testing.md）。
// CI はテストをファイル単位で並列に動かすため、同じブランチを使うテストを別のファイルに分けると、互いのデータを書き換え合う。
// そのため、このブランチを使うテストはこのファイルにまとめる（ファイルの中のテストは順番に動く）。
// - 最後の admin の保護: DB 全体の admin の人数で決まる。共有のテスト用 DB では、ほかのテストファイルが並列に admin を作るため
//   「admin が1人だけ」の状態を作れない。各テストの前に admin を全員外す
// - 学年更新: 実行すると DB の全員の学年が変わるため、共有のテスト用 DB では動かせない

// app.request はパスだけを渡すと http://localhost に送る。ブラウザが同じオリジンから送るときと同じく、Origin を付ける
const SAME_ORIGIN = "http://localhost";

// ファイルの全テストで同じ接続と片付けを使うため、describe の外で呼ぶ
// biome-ignore lint/correctness/useHookAtTopLevel: React のフックではなく、テストの前後の処理を登録する関数
const testUsers = useTestUsers(getIsolatedTestDatabaseUrl);
const {
	insertDay,
	insertUser,
	insertReservation,
	isReservationExisting,
	signInWithProfile,
} = testData(testUsers);

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

const LAST_ADMIN_TEST_RANGE = ["2042-03-01", "2042-03-31"] as const;
const LAST_ADMIN_NOW = new Date("2042-03-05T12:00:00+09:00");
const LAST_ADMIN_DAY = "2042-03-07";

describe("最後の admin の保護（テスト専用の Neon ブランチ）", () => {
	let currentTimeSpy: Mock<typeof clock.currentTime>;

	beforeEach(async () => {
		currentTimeSpy = spyOn(clock, "currentTime").mockReturnValue(
			LAST_ADMIN_NOW,
		);
		await deleteSeminarDaysBetween(testUsers.db(), LAST_ADMIN_TEST_RANGE);
		await testUsers
			.db()
			.update(users)
			.set({ role: "student" })
			.where(eq(users.role, "admin"));
	});

	afterEach(() => {
		currentTimeSpy.mockRestore();
	});

	function getUsers(cookie: string) {
		return app.request(
			"/api/admin/users",
			{ headers: { cookie } },
			testUsers.env(),
		);
	}

	describe("在籍中の admin が1人だけのとき", () => {
		test.each(["student", "teacher"] as const)(
			"その人を %s にすると 409 と LAST_ADMIN を返し、役割・学年・予約を変えない",
			async (role) => {
				const { cookie, userId } = await signInWithProfile("admin");
				const slotIds = await insertDay(LAST_ADMIN_DAY, {
					kinds: ["presentation"],
				});
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

		// 入口の権限の確認を通ったあとに外されたとき。この順番はルートのテストでは作れないため、services を直接呼ぶ
		test("外された操作者がその人を外そうとしたら、LAST_ADMIN より先に FORBIDDEN を返す", async () => {
			const userId = await insertUser("管理者", "M1", "admin");
			const actorId = await insertUser("元管理者", "M1");

			const result = await updateUserRole(testUsers.db(), {
				actorId,
				userId,
				role: "student",
				now: LAST_ADMIN_NOW,
			});

			expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
			expect((await findUser(userId)).role).toBe("admin");
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

				// 片方は成功する。もう片方は、その変更で自分が外れているため、入口の確認でも、
				// ロックを待ったあとの処理の中の確認でも 403 になる
				expect(responses.map((res) => res.status).sort()).toEqual([200, 403]);
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

const PROMOTION_TEST_RANGE = ["2044-03-01", "2044-05-31"] as const;
const PROMOTION_YEAR = 2044;
const PROMOTION_NOW = new Date("2044-04-05T12:00:00+09:00");
const NEXT_PROMOTION_YEAR = 2045;
const NEXT_PROMOTION_NOW = new Date("2045-04-05T12:00:00+09:00");
// PROMOTION_NOW より前と後の開催日
const PROMOTION_PAST_DAY = "2044-04-01";
const PROMOTION_FUTURE_DAY = "2044-04-08";

describe("学年更新（テスト専用の Neon ブランチ）", () => {
	let currentTimeSpy: Mock<typeof clock.currentTime>;

	beforeEach(async () => {
		currentTimeSpy = spyOn(clock, "currentTime").mockReturnValue(PROMOTION_NOW);
		await deleteSeminarDaysBetween(testUsers.db(), PROMOTION_TEST_RANGE);
		await testUsers.db().delete(gradePromotions);
		// 途中で落ちたテストのユーザーが残っていても、対象者に入らないようにする（進路の抜けと誤って判定しないため）
		await testUsers.db().update(users).set({ isEnrolled: false });
	});

	afterEach(() => {
		currentTimeSpy.mockRestore();
	});

	function postPromotion(
		cookie: string,
		paths: { userId: string; path: GradePromotionPath }[] = [],
	) {
		return app.request(
			"/api/admin/grade-promotions",
			{
				method: "POST",
				headers: {
					origin: SAME_ORIGIN,
					"content-type": "application/json",
					cookie,
				},
				body: JSON.stringify({ paths }),
			},
			testUsers.env(),
		);
	}

	function getPromotion(cookie: string) {
		return app.request(
			"/api/admin/grade-promotions",
			{ headers: { cookie } },
			testUsers.env(),
		);
	}

	function findPromotions() {
		return testUsers
			.db()
			.select({
				academicYear: gradePromotions.academicYear,
				executedById: gradePromotions.executedById,
			})
			.from(gradePromotions);
	}

	// 既定は学年の無い admin。学年があると本人も対象者になるため、対象者に入れたいテストだけ学年を渡す
	async function signInAsAdmin(grade: Grade | null = null) {
		const admin = await signInWithProfile("admin");
		await testUsers
			.db()
			.update(users)
			.set({ grade })
			.where(eq(users.id, admin.userId));
		return admin;
	}

	// 開始前の枠に userId の予約を入れ、予約の id を返す。同じ日の枠の時刻がぶつからないよう、呼ぶたびに別の日を使う
	let slotCount = 0;
	async function insertFutureReservation(
		userId: string,
		status: ReservationStatus = "reserved",
	) {
		slotCount += 1;
		const slotIds = await insertDay(
			`2044-05-${String((slotCount % 28) + 1).padStart(2, "0")}`,
			{
				kinds: ["presentation"],
			},
		);
		return insertReservation(idAt(slotIds, 0), userId, status);
	}

	describe("実行の結果", () => {
		const AUTOMATIC_PROMOTIONS = [
			["B1", "B2"],
			["B2", "B3"],
			["B3", "B4"],
			["MIDS_B1", "MIDS_B2"],
			["MIDS_B2", "MIDS_B3"],
			["MIDS_B3", "MIDS_B4"],
			["M1", "M2"],
		] as const;

		// 全学年を同じ1回で更新する。別々の文で更新していると、B1 → B2 → B3 のように同じ人が2つ上がる
		test("B1〜B3・MIDS_B1〜B3・M1 は、進路を指定しなくても1つだけ上がる", async () => {
			const { cookie } = await signInAsAdmin();
			const students = await Promise.all(
				AUTOMATIC_PROMOTIONS.map(async ([before, after]) => ({
					id: await insertUser(before, before),
					after,
				})),
			);

			const res = await postPromotion(cookie);

			expect(res.status).toBe(200);
			expect(students).toHaveLength(7);
			for (const { id, after } of students) {
				expect(await findUser(id)).toMatchObject({
					grade: after,
					isEnrolled: true,
				});
			}
		});

		test.each([
			["B4", "M1"],
			["MIDS_B4", "M1"],
			["M2", "M2"],
		] as const)(
			"%s に continue を指定すると %s になり、在籍のまま",
			async (before, after) => {
				const { cookie } = await signInAsAdmin();
				const userId = await insertUser("Shibata", before);

				const res = await postPromotion(cookie, [{ userId, path: "continue" }]);

				expect(res.status).toBe(200);
				expect(await findUser(userId)).toMatchObject({
					grade: after,
					isEnrolled: true,
				});
			},
		);

		test.each(["B4", "MIDS_B4", "M2"] as const)(
			"%s に graduate を指定すると、isEnrolled が false になり、学年は残る",
			async (grade) => {
				const { cookie } = await signInAsAdmin();
				const userId = await insertUser("Shibata", grade);

				const res = await postPromotion(cookie, [{ userId, path: "graduate" }]);

				expect(res.status).toBe(200);
				expect(await findUser(userId)).toMatchObject({
					grade,
					isEnrolled: false,
				});
			},
		);

		test("teacher、学年の無い人、卒業生は変わらず、進路の指定も要らない", async () => {
			const { cookie } = await signInAsAdmin();
			const teacherId = await insertUser("先生", null, "teacher");
			// teacher は学年を持たない決まりだが、万一入っていても対象にしない
			const teacherWithGradeId = await insertUser("先生2", "B4", "teacher");
			const studentWithoutGradeId = await insertUser("学年なし", null);
			const graduateId = await insertUser("卒業生", "B2");
			const graduateChoiceId = await insertUser("卒業生2", "M2");
			await markGraduated(graduateId);
			await markGraduated(graduateChoiceId);

			const res = await postPromotion(cookie);

			expect(res.status).toBe(200);
			expect(await findUser(teacherId)).toMatchObject({
				grade: null,
				isEnrolled: true,
			});
			expect((await findUser(teacherWithGradeId)).grade).toBe("B4");
			expect((await findUser(studentWithoutGradeId)).grade).toBeNull();
			expect(await findUser(graduateId)).toMatchObject({
				grade: "B2",
				isEnrolled: false,
			});
			expect((await findUser(graduateChoiceId)).grade).toBe("M2");
		});

		test("学年のある admin も更新され、役割は変わらない", async () => {
			const { cookie, userId } = await signInAsAdmin("B3");

			const res = await postPromotion(cookie);

			expect(res.status).toBe(200);
			expect(await findUser(userId)).toMatchObject({
				grade: "B4",
				role: "admin",
			});
		});

		test("年度と実行した人を記録し、年度と人数と削除した予約の件数を返す", async () => {
			const { cookie, userId } = await signInAsAdmin();
			await insertUser("Mori", "B1");
			const continuedId = await insertUser("Shibata", "B4");
			const graduateId = await insertUser("Kato", "M2");
			await insertFutureReservation(graduateId);

			const res = await postPromotion(cookie, [
				{ userId: continuedId, path: "continue" },
				{ userId: graduateId, path: "graduate" },
			]);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				academicYear: PROMOTION_YEAR,
				updatedCount: 3,
				graduatedCount: 1,
				deletedReservationCount: 1,
			});
			expect(await findPromotions()).toEqual([
				{ academicYear: PROMOTION_YEAR, executedById: userId },
			]);
		});
	});

	describe("実行できる期間（日本時間の4月の間だけ）", () => {
		test.each([
			["3月31日 23:59:59", "2044-03-31T23:59:59+09:00"],
			["5月1日 0:00:00", "2044-05-01T00:00:00+09:00"],
			["1月1日 0:00:00", "2044-01-01T00:00:00+09:00"],
			["12月31日 23:59:59", "2044-12-31T23:59:59+09:00"],
		])("%s は 409 を返し、何も更新しない", async (_name, now) => {
			currentTimeSpy.mockReturnValue(new Date(now));
			const { cookie } = await signInAsAdmin();
			const userId = await insertUser("Shibata", "B1");

			const res = await postPromotion(cookie);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "GRADE_PROMOTION_NOT_OPEN" },
			});
			expect((await findUser(userId)).grade).toBe("B1");
			expect(await findPromotions()).toEqual([]);
		});

		// UTC では 3月31日 15:00 / 4月30日 14:59 にあたる。UTC で判定していると、ここで結果が変わる
		test.each([
			["4月1日 0:00:00", "2044-04-01T00:00:00+09:00"],
			["4月30日 23:59:59", "2044-04-30T23:59:59+09:00"],
		])("%s は実行できる", async (_name, now) => {
			currentTimeSpy.mockReturnValue(new Date(now));
			const { cookie } = await signInAsAdmin();
			const userId = await insertUser("Shibata", "B1");

			const res = await postPromotion(cookie);

			expect(res.status).toBe(200);
			expect((await findUser(userId)).grade).toBe("B2");
		});
	});

	describe("2回目の実行", () => {
		test("同じ年度の2回目は 409 を返し、学年は1つしか上がらない", async () => {
			const { cookie } = await signInAsAdmin();
			const userId = await insertUser("Shibata", "B1");

			expect((await postPromotion(cookie)).status).toBe(200);
			const res = await postPromotion(cookie);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "GRADE_PROMOTION_ALREADY_EXECUTED" },
			});
			expect((await findUser(userId)).grade).toBe("B2");
			expect(await findPromotions()).toHaveLength(1);
		});

		// 1回目で B3 → B4 に上がった人は、2回目から見ると進路が抜けている。進路の抜けとして返すと、選び直せば実行できるように見える
		test("1回目で B4 になった人の進路が抜けていても、実行済みとして返す", async () => {
			const { cookie } = await signInAsAdmin();
			const userId = await insertUser("Shibata", "B3");

			expect((await postPromotion(cookie)).status).toBe(200);
			const res = await postPromotion(cookie);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "GRADE_PROMOTION_ALREADY_EXECUTED" },
			});
			expect((await findUser(userId)).grade).toBe("B4");
		});

		// 進路の抜けが無いと記録の INSERT まで進み、UNIQUE 違反になる。そのとき、まとめて送った更新と削除も取り消される
		test("2回目に進路を指定しても、卒業にならず、予約も消えない", async () => {
			const { cookie } = await signInAsAdmin();
			const userId = await insertUser("Shibata", "B3");
			const reservationId = await insertFutureReservation(userId);

			expect((await postPromotion(cookie)).status).toBe(200);
			const res = await postPromotion(cookie, [{ userId, path: "graduate" }]);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "GRADE_PROMOTION_ALREADY_EXECUTED" },
			});
			expect(await findUser(userId)).toMatchObject({
				grade: "B4",
				isEnrolled: true,
			});
			expect(await isReservationExisting(reservationId)).toBe(true);
		});

		// 2回目で進路の抜けがあると、記録の INSERT は0行になり、UNIQUE 違反で取り消されない。応答が届かずに同じ内容を送り直したときや、
		// 1回目より前に開いた画面から送ったときに、元の B3 がいれば毎回この形になる。ここで更新が走ると、409 を返しながら学年が2つ上がる
		test("2回目に進路の抜けがあっても、自動で上がる人も continue の人も更新しない", async () => {
			const { cookie } = await signInAsAdmin();
			const automaticId = await insertUser("自動", "B1");
			const missingId = await insertUser("抜け", "B3");
			const continuedId = await insertUser("継続", "B4");
			const paths = [{ userId: continuedId, path: "continue" as const }];

			expect((await postPromotion(cookie, paths)).status).toBe(200);
			const res = await postPromotion(cookie, paths);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "GRADE_PROMOTION_ALREADY_EXECUTED" },
			});
			expect((await findUser(automaticId)).grade).toBe("B2");
			expect((await findUser(missingId)).grade).toBe("B4");
			expect((await findUser(continuedId)).grade).toBe("M1");
			expect(await findPromotions()).toHaveLength(1);
		});

		test("2回目に進路の抜けがあっても、卒業にならず、予約も消えない", async () => {
			const { cookie } = await signInAsAdmin();
			await insertUser("抜け", "B3");
			const userId = await insertUser("継続", "M2");
			const reservationId = await insertFutureReservation(userId);

			expect(
				(await postPromotion(cookie, [{ userId, path: "continue" }])).status,
			).toBe(200);
			const res = await postPromotion(cookie, [{ userId, path: "graduate" }]);

			expect(res.status).toBe(409);
			expect(await findUser(userId)).toMatchObject({
				grade: "M2",
				isEnrolled: true,
			});
			expect(await isReservationExisting(reservationId)).toBe(true);
		});

		// 最後の admin の条件でも記録の INSERT は0行になる。元の B3 がいなくても起きる
		test("2回目に最後の admin の条件に当たっても、在籍中の admin を卒業にしない", async () => {
			const { cookie, userId } = await signInAsAdmin("M2");
			const reservationId = await insertFutureReservation(userId);

			expect(
				(await postPromotion(cookie, [{ userId, path: "continue" }])).status,
			).toBe(200);
			const res = await postPromotion(cookie, [{ userId, path: "graduate" }]);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "GRADE_PROMOTION_ALREADY_EXECUTED" },
			});
			expect((await findUser(userId)).isEnrolled).toBe(true);
			expect(await isReservationExisting(reservationId)).toBe(true);
		});

		test("翌年度の4月にはもう一度実行できる", async () => {
			const { cookie, userId: adminId } = await signInAsAdmin();
			const userId = await insertUser("Shibata", "B1");

			expect((await postPromotion(cookie)).status).toBe(200);
			currentTimeSpy.mockReturnValue(NEXT_PROMOTION_NOW);
			const res = await postPromotion(cookie);

			expect(res.status).toBe(200);
			expect((await findUser(userId)).grade).toBe("B3");
			expect(await findPromotions()).toEqual(
				expect.arrayContaining([
					{ academicYear: PROMOTION_YEAR, executedById: adminId },
					{ academicYear: NEXT_PROMOTION_YEAR, executedById: adminId },
				]),
			);
		});

		test("同時に2回送っても、成功するのは1件だけで、学年は1つしか上がらない", async () => {
			const { cookie } = await signInAsAdmin();
			const userId = await insertUser("Shibata", "B1");

			// タイミングで結果が変わる処理のため、1回だけ通っても安心できないので繰り返す
			for (let round = 0; round < 3; round++) {
				await testUsers.db().delete(gradePromotions);
				await testUsers
					.db()
					.update(users)
					.set({ grade: "B1" })
					.where(eq(users.id, userId));

				const responses = await Promise.all([
					postPromotion(cookie),
					postPromotion(cookie),
				]);

				expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
				expect((await findUser(userId)).grade).toBe("B2");
				expect(await findPromotions()).toHaveLength(1);
			}
			// 3回分の往復があり、既定の上限（5秒）では足りないことがある
		}, 60_000);

		// 後から来たリクエストはロックを待ち、確定後の値を読む。元の B3 がいると進路の抜けになり、UNIQUE 違反で取り消されない
		test("元の B3 がいるときに同時に2回送っても、学年は1つしか上がらない", async () => {
			const { cookie } = await signInAsAdmin();
			const automaticId = await insertUser("自動", "B1");
			const missingId = await insertUser("抜け", "B3");

			// タイミングで結果が変わる処理のため、1回だけ通っても安心できないので繰り返す
			for (let round = 0; round < 3; round++) {
				await testUsers.db().delete(gradePromotions);
				await testUsers
					.db()
					.update(users)
					.set({ grade: "B1" })
					.where(eq(users.id, automaticId));
				await testUsers
					.db()
					.update(users)
					.set({ grade: "B3" })
					.where(eq(users.id, missingId));

				const responses = await Promise.all([
					postPromotion(cookie),
					postPromotion(cookie),
				]);

				expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
				expect((await findUser(automaticId)).grade).toBe("B2");
				expect((await findUser(missingId)).grade).toBe("B4");
			}
			// 3回分の往復があり、既定の上限（5秒）では足りないことがある
		}, 60_000);
	});

	describe("進路の抜け", () => {
		test.each(["B4", "MIDS_B4", "M2"] as const)(
			"%s の進路が無いと 409 を返す",
			async (grade) => {
				const { cookie } = await signInAsAdmin();
				const userId = await insertUser("Shibata", grade);

				const res = await postPromotion(cookie);

				expect(res.status).toBe(409);
				expect(await res.json()).toMatchObject({
					error: { code: "GRADE_PROMOTION_PATH_REQUIRED" },
				});
				expect(await findUser(userId)).toMatchObject({
					grade,
					isEnrolled: true,
				});
			},
		);

		test("1人でも抜けていれば、ほかの人の学年・卒業・予約・記録も変えない", async () => {
			const { cookie } = await signInAsAdmin();
			const missingId = await insertUser("抜け", "B4");
			const graduateId = await insertUser("卒業", "M2");
			const automaticId = await insertUser("自動", "B1");
			const reservationId = await insertFutureReservation(graduateId);

			const res = await postPromotion(cookie, [
				{ userId: graduateId, path: "graduate" },
			]);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "GRADE_PROMOTION_PATH_REQUIRED" },
			});
			expect((await findUser(missingId)).grade).toBe("B4");
			expect((await findUser(graduateId)).isEnrolled).toBe(true);
			expect((await findUser(automaticId)).grade).toBe("B1");
			expect(await isReservationExisting(reservationId)).toBe(true);
			expect(await findPromotions()).toEqual([]);
		});

		test("対象外の人、自動で上がる人、いない人が paths に入っていても無視する", async () => {
			const { cookie } = await signInAsAdmin();
			const automaticId = await insertUser("自動", "B1");
			const teacherId = await insertUser("先生", null, "teacher");
			const graduateId = await insertUser("卒業生", "M2");
			await markGraduated(graduateId);
			const reservationId = await insertFutureReservation(automaticId);

			const res = await postPromotion(cookie, [
				{ userId: automaticId, path: "graduate" },
				{ userId: teacherId, path: "graduate" },
				{ userId: graduateId, path: "continue" },
				{ userId: createId(), path: "graduate" },
			]);

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				updatedCount: 1,
				graduatedCount: 0,
				deletedReservationCount: 0,
			});
			expect(await findUser(automaticId)).toMatchObject({
				grade: "B2",
				isEnrolled: true,
			});
			expect((await findUser(teacherId)).isEnrolled).toBe(true);
			expect(await findUser(graduateId)).toMatchObject({
				grade: "M2",
				isEnrolled: false,
			});
			expect(await isReservationExisting(reservationId)).toBe(true);
		});
	});

	describe("卒業する人の予約", () => {
		test("開始前で「済」でない予約だけを消し、開始後の予約と「済」の予約は残す", async () => {
			const { cookie } = await signInAsAdmin();
			const userId = await insertUser("Shibata", "B4");
			const pastSlots = await insertDay(PROMOTION_PAST_DAY, {
				kinds: ["presentation", "presentation"],
			});
			const futureSlots = await insertDay(PROMOTION_FUTURE_DAY, {
				kinds: ["presentation", "presentation"],
			});
			const startedReservedId = await insertReservation(
				idAt(pastSlots, 0),
				userId,
			);
			const startedDoneId = await insertReservation(
				idAt(pastSlots, 1),
				userId,
				"done",
			);
			const upcomingReservedId = await insertReservation(
				idAt(futureSlots, 0),
				userId,
			);
			const upcomingDoneId = await insertReservation(
				idAt(futureSlots, 1),
				userId,
				"done",
			);

			const res = await postPromotion(cookie, [{ userId, path: "graduate" }]);

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ deletedReservationCount: 1 });
			expect(await isReservationExisting(upcomingReservedId)).toBe(false);
			expect(await isReservationExisting(startedReservedId)).toBe(true);
			expect(await isReservationExisting(startedDoneId)).toBe(true);
			expect(await isReservationExisting(upcomingDoneId)).toBe(true);
		});

		// admin は他人の予約も取り消せるため、取消の条件（isReservationCancelableBy）を admin のまま使うと全部消える
		test("卒業する人が admin でも、開始後の予約と「済」の予約は残す", async () => {
			const { cookie } = await signInAsAdmin();
			const userId = await insertUser("管理者", "B4", "admin");
			const pastSlots = await insertDay(PROMOTION_PAST_DAY, {
				kinds: ["presentation", "presentation"],
			});
			const startedReservedId = await insertReservation(
				idAt(pastSlots, 0),
				userId,
			);
			const startedDoneId = await insertReservation(
				idAt(pastSlots, 1),
				userId,
				"done",
			);
			const upcomingId = await insertFutureReservation(userId);
			// 卒業しない人の予約まで消さないことも確かめる
			const otherId = await insertUser("Mori", "B1");
			const otherReservationId = await insertFutureReservation(otherId);

			const res = await postPromotion(cookie, [{ userId, path: "graduate" }]);

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ deletedReservationCount: 1 });
			expect(await isReservationExisting(upcomingId)).toBe(false);
			expect(await isReservationExisting(startedReservedId)).toBe(true);
			expect(await isReservationExisting(startedDoneId)).toBe(true);
			expect(await isReservationExisting(otherReservationId)).toBe(true);
		});

		test("continue の人と自動で上がる人の予約は消えない", async () => {
			const { cookie } = await signInAsAdmin();
			const continuedId = await insertUser("Shibata", "B4");
			const automaticId = await insertUser("Mori", "B1");
			const continuedReservationId = await insertFutureReservation(continuedId);
			const automaticReservationId = await insertFutureReservation(automaticId);

			const res = await postPromotion(cookie, [
				{ userId: continuedId, path: "continue" },
			]);

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ deletedReservationCount: 0 });
			expect(await isReservationExisting(continuedReservationId)).toBe(true);
			expect(await isReservationExisting(automaticReservationId)).toBe(true);
		});
	});

	describe("最後の admin", () => {
		test("在籍中の最後の admin を卒業にすると 409 と LAST_ADMIN を返し、何も変えない", async () => {
			const { cookie, userId } = await signInAsAdmin("B4");
			const studentId = await insertUser("Shibata", "B1");
			const reservationId = await insertFutureReservation(userId);

			const res = await postPromotion(cookie, [{ userId, path: "graduate" }]);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "LAST_ADMIN" },
			});
			expect(await findUser(userId)).toMatchObject({
				grade: "B4",
				isEnrolled: true,
			});
			expect((await findUser(studentId)).grade).toBe("B1");
			expect(await isReservationExisting(reservationId)).toBe(true);
			expect(await findPromotions()).toEqual([]);
		});

		test("在籍中の admin が全員卒業になるときも 409 を返す", async () => {
			const { cookie, userId } = await signInAsAdmin("B4");
			const otherId = await insertUser("管理者", "M2", "admin");

			const res = await postPromotion(cookie, [
				{ userId, path: "graduate" },
				{ userId: otherId, path: "graduate" },
			]);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "LAST_ADMIN" },
			});
		});

		test.each([
			["学年の無い admin", null, null],
			["自動で上がる admin", "B1", null],
			["continue の admin", "M2", "continue"],
		] as const)(
			"%s が残るなら、自分を卒業にできる",
			async (_name, grade, path) => {
				const { cookie, userId } = await signInAsAdmin("B4");
				const otherId = await insertUser("管理者", grade, "admin");

				const res = await postPromotion(cookie, [
					{ userId, path: "graduate" },
					...(path === null ? [] : [{ userId: otherId, path }]),
				]);

				expect(res.status).toBe(200);
				expect(await findUser(userId)).toMatchObject({
					grade: "B4",
					isEnrolled: false,
					role: "admin",
				});
				expect((await findUser(otherId)).isEnrolled).toBe(true);
			},
		);

		// 誰も卒業にならないのに止めると、admin が卒業生だけのときに学年更新ができなくなる
		test("admin が卒業生だけのときは、人数では止めない", async () => {
			const { cookie, userId } = await signInAsAdmin("M2");
			await markGraduated(userId);
			const studentId = await insertUser("Shibata", "B1");

			const res = await postPromotion(cookie);

			expect(res.status).toBe(200);
			expect((await findUser(studentId)).grade).toBe("B2");
		});

		test("進路の抜けと最後の admin の両方に当たるときは、進路の抜けを先に返す", async () => {
			const { cookie, userId } = await signInAsAdmin("B4");
			await insertUser("Shibata", "M2");

			const res = await postPromotion(cookie, [{ userId, path: "graduate" }]);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "GRADE_PROMOTION_PATH_REQUIRED" },
			});
		});

		// 役割の変更（services/user.ts）と学年更新が互いに「もう1人いる」と読むと、在籍中の admin が0人になる
		test("卒業と役割の変更が同時に来ても、在籍中の admin が残る", async () => {
			const { cookie, userId } = await signInAsAdmin("B4");
			const otherId = await insertUser("管理者", null, "admin");

			// タイミングで結果が変わる処理のため、1回だけ通っても安心できないので繰り返す
			for (let round = 0; round < 3; round++) {
				await testUsers.db().delete(gradePromotions);
				await testUsers
					.db()
					.update(users)
					.set({ role: "admin", grade: "B4", isEnrolled: true })
					.where(eq(users.id, userId));
				await testUsers
					.db()
					.update(users)
					.set({ role: "admin", grade: null })
					.where(eq(users.id, otherId));

				const responses = await Promise.all([
					postPromotion(cookie, [{ userId, path: "graduate" }]),
					patchUser(otherId, cookie, "teacher"),
				]);

				// 先に確定したほうが通り、後のほうは残りの admin が0人になるため 409 になる
				expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
				expect(await findEnrolledAdmins()).toHaveLength(1);
			}
			// 3回分の往復があり、既定の上限（5秒）では足りないことがある
		}, 60_000);
	});

	// 4月1日以降に登録した人は、4月時点の正しい学年を選んでいる。更新すると1つ上がりすぎるため対象から外す（設計メモ）
	describe("年度の始まり（日本時間の4月1日）以降に作られたアカウント", () => {
		const START_OF_YEAR = "2044-04-01T00:00:00+09:00";
		const BEFORE_START_OF_YEAR = "2044-03-31T23:59:59+09:00";

		async function setCreatedAt(userId: string, createdAt: string) {
			await testUsers
				.db()
				.update(users)
				.set({ createdAt: new Date(createdAt) })
				.where(eq(users.id, userId));
		}

		async function insertUserCreatedAt(
			createdAt: string,
			...user: Parameters<typeof insertUser>
		) {
			const userId = await insertUser(...user);
			await setCreatedAt(userId, createdAt);
			return userId;
		}

		test.each([
			["4月1日 0:00:00 ちょうど", "B1", START_OF_YEAR],
			["3月31日 23:59:59", "B2", BEFORE_START_OF_YEAR],
		])(
			"%s に作られた B1 は、更新のあと %s になる",
			async (_name, expectedGrade, createdAt) => {
				const { cookie } = await signInAsAdmin();
				const userId = await insertUserCreatedAt(createdAt, "対象", "B1");

				const res = await postPromotion(cookie);

				expect(res.status).toBe(200);
				expect(await findUser(userId)).toMatchObject({ grade: expectedGrade });
			},
		);

		test("更新した人数に数えない", async () => {
			const { cookie } = await signInAsAdmin();
			await insertUserCreatedAt(START_OF_YEAR, "新入り", "B1");
			await insertUserCreatedAt(BEFORE_START_OF_YEAR, "在学生", "B1");

			const res = await postPromotion(cookie);

			expect(await res.json()).toMatchObject({ updatedCount: 1 });
		});

		test.each(["B4", "M2", "MIDS_B4"] as const)(
			"%s は進路を送らなくても PATH_REQUIRED にならず、学年も在籍も変わらない",
			async (grade) => {
				const { cookie } = await signInAsAdmin();
				const userId = await insertUserCreatedAt(
					START_OF_YEAR,
					"新入り",
					grade,
				);

				const res = await postPromotion(cookie);

				expect(res.status).toBe(200);
				expect(await findUser(userId)).toMatchObject({
					grade,
					isEnrolled: true,
				});
			},
		);

		test("graduate を送っても卒業にならず、開始前の予約も消えない", async () => {
			const { cookie } = await signInAsAdmin();
			const userId = await insertUserCreatedAt(START_OF_YEAR, "新入り", "M2");
			const reservationId = await insertFutureReservation(userId);

			const res = await postPromotion(cookie, [{ userId, path: "graduate" }]);

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				updatedCount: 0,
				graduatedCount: 0,
				deletedReservationCount: 0,
			});
			expect(await findUser(userId)).toMatchObject({
				grade: "M2",
				isEnrolled: true,
			});
			expect(await isReservationExisting(reservationId)).toBe(true);
		});

		test("continue を送っても、更新した人数に数えない", async () => {
			const { cookie } = await signInAsAdmin();
			const userId = await insertUserCreatedAt(START_OF_YEAR, "新入り", "M2");

			const res = await postPromotion(cookie, [{ userId, path: "continue" }]);

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ updatedCount: 0 });
		});

		test("在籍中の admin が卒業しても、4月以降に作られた admin が残るなら LAST_ADMIN にならない", async () => {
			const { cookie, userId: graduatingAdminId } = await signInAsAdmin("M2");
			await setCreatedAt(graduatingAdminId, BEFORE_START_OF_YEAR);
			const newAdminId = await insertUserCreatedAt(
				START_OF_YEAR,
				"新しい admin",
				"M2",
				"admin",
			);

			const res = await postPromotion(cookie, [
				{ userId: graduatingAdminId, path: "graduate" },
				{ userId: newAdminId, path: "graduate" },
			]);

			expect(res.status).toBe(200);
			expect(await findUser(graduatingAdminId)).toMatchObject({
				isEnrolled: false,
			});
			expect(await findUser(newAdminId)).toMatchObject({ isEnrolled: true });
		});

		test("GET の対象者に入らない", async () => {
			const { cookie } = await signInAsAdmin();
			await insertUserCreatedAt(START_OF_YEAR, "新入り", "M2");
			const memberId = await insertUserCreatedAt(
				BEFORE_START_OF_YEAR,
				"在学生",
				"B1",
			);

			const res = await getPromotion(cookie);

			const body = (await res.json()) as { targets: { id: string }[] };
			expect(body.targets.map(({ id }) => id)).toEqual([memberId]);
		});

		test("前の年度の4月に作られた人は、次の年度には対象になる", async () => {
			const { cookie } = await signInAsAdmin();
			const userId = await insertUserCreatedAt(
				START_OF_YEAR,
				"去年の新入り",
				"B1",
			);
			expect((await postPromotion(cookie)).status).toBe(200);
			expect(await findUser(userId)).toMatchObject({ grade: "B1" });
			currentTimeSpy.mockReturnValue(NEXT_PROMOTION_NOW);

			const res = await postPromotion(cookie);

			expect(res.status).toBe(200);
			expect(await findUser(userId)).toMatchObject({ grade: "B2" });
		});
	});

	// 学年更新の batch は文ごとに最新の確定済みの値を読むため、途中で学年の登録や役割の変更が確定すると、対象者が途中で増える。
	// タイミングに任せると再現しないので、確定していないトランザクションで行をロックして、処理の順番を固定する
	describe("学年更新と同時に、対象者が増える変更が来たとき", () => {
		let pool: Pool;
		let client: PoolClient;

		beforeEach(async () => {
			pool = new Pool({ connectionString: getIsolatedTestDatabaseUrl() });
			client = await pool.connect();
			await client.query("begin");
		});

		afterEach(async () => {
			await client.query("rollback");
			client.release();
			await pool.end();
		});

		// ロックを待っている文が count 個になるか、対象の処理が終わるまで待つ。ロックを待ったら true を返す
		async function waitUntilBlocked(count: number, work: unknown) {
			let isSettled = false;
			const settled = Promise.resolve(work).finally(() => {
				isSettled = true;
			});
			while (!isSettled) {
				const { rows } = await client.query(
					"select count(*)::int as count from pg_locks where not granted",
				);
				if (rows[0].count >= count) {
					return true;
				}
				await Bun.sleep(100);
			}
			await settled;
			return false;
		}

		test.each([
			["学年の登録", "student"],
			["teacher から student への変更", "teacher"],
		] as const)(
			"確定前の%sがあれば、確定を待ってから判定し、進路の抜けとして何も更新しない",
			async (_name, role) => {
				const { cookie } = await signInAsAdmin();
				const userId = await insertUser("途中で対象者", null, role);
				const otherId = await insertUser("ほかの人", "B1");
				await client.query(
					`update "users" set "grade" = 'B4', "role" = 'student' where "id" = $1`,
					[userId],
				);

				const promotion = postPromotion(cookie);
				await waitUntilBlocked(1, promotion);
				await client.query("commit");
				await client.query("begin");

				const res = await promotion;
				expect(res.status).toBe(409);
				expect(await res.json()).toMatchObject({
					error: { code: "GRADE_PROMOTION_PATH_REQUIRED" },
				});
				expect(await findPromotions()).toEqual([]);
				expect(await findUser(otherId)).toMatchObject({ grade: "B1" });
			},
			30_000,
		);

		test("更新の途中で学年を登録した人は、更新のあとに登録され、1つ上がらない", async () => {
			const { cookie } = await signInAsAdmin();
			const graduatingId = await insertUser("卒業", "M2");
			const reservationId = await insertFutureReservation(graduatingId);
			const lateId = await insertUser("途中で登録", null);
			// 記録の INSERT のあとの、予約の削除で batch を止める
			await client.query(
				`select "id" from "reservations" where "id" = $1 for update`,
				[reservationId],
			);

			const promotion = postPromotion(cookie, [
				{ userId: graduatingId, path: "graduate" },
			]);
			// ここで止まらないと、登録が更新の途中に来る順番を確かめたことにならない
			expect(await waitUntilBlocked(1, promotion)).toBe(true);
			const registration = testUsers
				.db()
				.update(users)
				.set({ grade: "B3" })
				.where(eq(users.id, lateId))
				.execute();
			await waitUntilBlocked(2, registration);
			await client.query("commit");
			await client.query("begin");

			const res = await promotion;
			await registration;
			expect(res.status).toBe(200);
			expect(await findUser(lateId)).toMatchObject({ grade: "B3" });
		}, 30_000);
	});

	describe("GET /api/admin/grade-promotions", () => {
		test("対象者だけを、進み先と一緒に返す", async () => {
			const { cookie } = await signInAsAdmin();
			const automaticId = await insertUser("自動", "B1");
			const choiceId = await insertUser("進路", "M2");
			await insertUser("先生", null, "teacher");
			await insertUser("学年なし", null);
			await markGraduated(await insertUser("卒業生", "B2"));

			const res = await getPromotion(cookie);

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				targets: [
					{
						id: automaticId,
						displayName: "自動",
						grade: "B1",
						promotion: { kind: "automatic", next: "B2" },
					},
					{
						id: choiceId,
						displayName: "進路",
						grade: "M2",
						promotion: { kind: "choice", continueGrade: "M2" },
					},
				],
			});
		});

		test("対象者は学年（GRADES の順）→ 表示名の順に並ぶ", async () => {
			const { cookie } = await signInAsAdmin();
			await insertUser("い", "MIDS_B1");
			await insertUser("い", "B2");
			await insertUser("あ", "B2");

			const res = await getPromotion(cookie);

			const body = (await res.json()) as {
				targets: { displayName: string; grade: string }[];
			};
			expect(
				body.targets.map(({ displayName, grade }) => [displayName, grade]),
			).toEqual([
				["あ", "B2"],
				["い", "B2"],
				["い", "MIDS_B1"],
			]);
		});

		test.each([
			["4月1日 0:00:00", "2044-04-01T00:00:00+09:00", true],
			["4月30日 23:59:59", "2044-04-30T23:59:59+09:00", true],
			["3月31日 23:59:59", "2044-03-31T23:59:59+09:00", false],
			["5月1日 0:00:00", "2044-05-01T00:00:00+09:00", false],
		])("%s（%s）の isOpen は %s", async (_name, now, isOpen) => {
			currentTimeSpy.mockReturnValue(new Date(now));
			const { cookie } = await signInAsAdmin();

			const res = await getPromotion(cookie);

			expect(await res.json()).toMatchObject({
				academicYear: PROMOTION_YEAR,
				isOpen,
				executed: null,
			});
		});

		test("実行済みなら、実行した日時と実行した人の表示名を返す", async () => {
			const { cookie } = await signInAsAdmin();
			expect((await postPromotion(cookie)).status).toBe(200);

			const res = await getPromotion(cookie);

			const body = (await res.json()) as {
				executed: { executedAt: string; executedByDisplayName: string };
			};
			expect(body.executed.executedByDisplayName).toBe("テスト");
			expect(Number.isNaN(Date.parse(body.executed.executedAt))).toBe(false);
		});

		test("前の年度の実行は、今の年度の実行済みに数えない", async () => {
			const { cookie } = await signInAsAdmin();
			expect((await postPromotion(cookie)).status).toBe(200);
			currentTimeSpy.mockReturnValue(NEXT_PROMOTION_NOW);

			const res = await getPromotion(cookie);

			expect(await res.json()).toMatchObject({
				academicYear: NEXT_PROMOTION_YEAR,
				isOpen: true,
				executed: null,
			});
		});
	});
});
