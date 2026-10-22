import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { users } from "../../../src/worker/db/schema";
import { handleError } from "../../../src/worker/error-handler";
import {
	type AuthEnv,
	requireAuth,
	requireProfile,
	requireRole,
} from "../../../src/worker/middleware/auth";
import { signInAsNewUser, testEnv, useTestUsers } from "../../helpers/sign-in";

// #3 の時点では役割が要る API がまだ無いため、テストの中だけでミドルウェアを掛けたアプリを作って確かめる
const testApp = new Hono<AuthEnv>()
	.onError(handleError)
	.get("/signed-in", requireAuth, (c) => c.json({ userId: c.get("user").id }))
	.get("/teacher-or-admin", requireAuth, requireRole("teacher", "admin"), (c) =>
		c.json({ ok: true }),
	)
	.get("/profile-required", requireAuth, requireProfile, (c) =>
		c.json({ ok: true }),
	);

function request(path: string, cookie?: string) {
	return testApp.request(
		path,
		{ headers: cookie ? { cookie } : {} },
		testEnv(),
	);
}

describe("requireAuth / requireRole / requireProfile（テスト用 DB）", () => {
	const testUsers = useTestUsers();

	async function updateUser(
		email: string,
		values: Partial<typeof users.$inferInsert>,
	) {
		await testUsers
			.db()
			.update(users)
			.set(values)
			.where(eq(users.email, email));
	}

	async function findUserId(email: string) {
		const [user] = await testUsers
			.db()
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, email));
		return user?.id;
	}

	describe("requireAuth", () => {
		test("クッキーが無ければ 401 と共通の形を返す", async () => {
			const res = await request("/signed-in");

			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({
				error: { code: "UNAUTHORIZED", message: "ログインしてください" },
			});
		});

		test("でたらめなクッキーなら 401 を返す", async () => {
			const res = await request(
				"/signed-in",
				"better-auth.session_token=bogus.bogus",
			);

			expect(res.status).toBe(401);
		});

		test("ログイン済みなら通し、後ろの処理でログイン中のユーザーを読める", async () => {
			const email = testUsers.uniqueEmail();
			const cookie = await signInAsNewUser(email);

			const res = await request("/signed-in", cookie);

			expect(res.status).toBe(200);
			const userId = await findUserId(email);
			expect(userId).toBeDefined();
			expect(await res.json()).toEqual({ userId });
		});
	});

	describe('requireRole("teacher", "admin")', () => {
		test("student は 403 と共通の形を返す", async () => {
			const cookie = await signInAsNewUser(testUsers.uniqueEmail());

			const res = await request("/teacher-or-admin", cookie);

			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({
				error: { code: "FORBIDDEN", message: "この操作を行う権限がありません" },
			});
		});

		// 403 が「役割以外の理由で落ちていた」のではないことを示すため、同じ人の役割だけを変えて通ることを確かめる
		test.each(["teacher", "admin"] as const)(
			"同じ人でも役割を %s にすると通る",
			async (role) => {
				const email = testUsers.uniqueEmail();
				const cookie = await signInAsNewUser(email);
				expect((await request("/teacher-or-admin", cookie)).status).toBe(403);

				await updateUser(email, { role });
				const res = await request("/teacher-or-admin", cookie);

				expect(res.status).toBe(200);
			},
		);

		test("未ログインなら、403 ではなく 401 を返す", async () => {
			const res = await request("/teacher-or-admin");

			expect(res.status).toBe(401);
		});
	});

	describe("requireProfile", () => {
		test("プロフィール未登録なら 403 と PROFILE_REQUIRED を返す", async () => {
			const cookie = await signInAsNewUser(testUsers.uniqueEmail());

			const res = await request("/profile-required", cookie);

			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({
				error: { code: "PROFILE_REQUIRED" },
			});
		});

		test.each([
			["学生", "B3"],
			["教員（学年なし）", null],
		] as const)("プロフィール登録済み（%s）なら通る", async (_, grade) => {
			const email = testUsers.uniqueEmail();
			const cookie = await signInAsNewUser(email);
			await updateUser(email, { displayName: "テスト", grade });

			const res = await request("/profile-required", cookie);

			expect(res.status).toBe(200);
		});
	});
});
