import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { users } from "../../../src/worker/db/schema";
import app from "../../../src/worker/index";
import { signInAsNewUser, testEnv, useTestUsers } from "../../helpers/sign-in";

type Method = "GET" | "POST" | "PATCH";

function request(
	method: Method,
	path: string,
	{ cookie, body }: { cookie?: string; body?: unknown } = {},
) {
	return app.request(
		path,
		{
			method,
			headers: {
				...(cookie ? { cookie } : {}),
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			// 文字列はそのまま送る（壊れた JSON を送るテストのため）
			body:
				body === undefined
					? undefined
					: typeof body === "string"
						? body
						: JSON.stringify(body),
		},
		testEnv(),
	);
}

describe("/api/me（テスト用 DB）", () => {
	const testUsers = useTestUsers();

	async function findUser(email: string) {
		const [user] = await testUsers
			.db()
			.select()
			.from(users)
			.where(eq(users.email, email));
		if (!user) {
			throw new Error(`${email} のユーザーが見つかりません`);
		}
		return user;
	}

	// ログインした直後（プロフィール未登録）のユーザーを作る
	async function signInAsUnregistered() {
		const email = testUsers.uniqueEmail();
		const cookie = await signInAsNewUser(email);
		return { email, cookie };
	}

	async function signInAsRegistered(
		profile = { displayName: "Shibata", grade: "B3" as const },
	) {
		const user = await signInAsUnregistered();
		const res = await request("POST", "/api/me/profile", {
			cookie: user.cookie,
			body: profile,
		});
		expect(res.status).toBe(200);
		return user;
	}

	describe("GET /api/me", () => {
		test("未ログインなら 401 を返す", async () => {
			const res = await request("GET", "/api/me");

			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({
				error: { code: "UNAUTHORIZED" },
			});
		});

		test("プロフィール未登録なら isProfileRegistered: false を返す", async () => {
			const { email, cookie } = await signInAsUnregistered();
			const { id } = await findUser(email);

			const res = await request("GET", "/api/me", { cookie });

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				id,
				email,
				displayName: null,
				grade: null,
				role: "student",
				isProfileRegistered: false,
			});
		});

		test("プロフィール登録後は、登録した値と isProfileRegistered: true を返す", async () => {
			const { email, cookie } = await signInAsRegistered();

			const res = await request("GET", "/api/me", { cookie });

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				email,
				displayName: "Shibata",
				grade: "B3",
				role: "student",
				isProfileRegistered: true,
			});
		});
	});

	describe("POST /api/me/profile", () => {
		test("表示名と学年を登録し、200 と登録後の自分の情報を返す", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "森谷", grade: "MIDS_B3" },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				email,
				displayName: "森谷",
				grade: "MIDS_B3",
				isProfileRegistered: true,
			});
			expect(await findUser(email)).toMatchObject({
				displayName: "森谷",
				grade: "MIDS_B3",
			});
		});

		test("教員（grade: null）として登録でき、役割は student のまま", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "森谷", grade: null },
			});

			expect(res.status).toBe(200);
			expect(await findUser(email)).toMatchObject({
				displayName: "森谷",
				grade: null,
				role: "student",
			});
		});

		test("表示名の前後の空白は取り除いて保存する", async () => {
			const { email, cookie } = await signInAsUnregistered();

			await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "  Shibata　", grade: "B3" },
			});

			expect((await findUser(email)).displayName).toBe("Shibata");
		});

		test("表示名は20文字まで登録できる", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "あ".repeat(20), grade: "B3" },
			});

			expect(res.status).toBe(200);
			expect((await findUser(email)).displayName).toBe("あ".repeat(20));
		});

		// 対のないサロゲートを拒否しても、正しく対になった絵文字まで弾かないことを確かめる
		// HTML の maxLength のような UTF-16 単位（絵文字1つ = 2）ではなく、1つを1文字と数える
		test("表示名は絵文字20個まで登録できる", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "😀".repeat(20), grade: "B3" },
			});

			expect(res.status).toBe(200);
			expect((await findUser(email)).displayName).toBe("😀".repeat(20));
		});

		test("絵文字を含む表示名は登録できる", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "しばた😀👍🏽", grade: "B3" },
			});

			expect(res.status).toBe(200);
			expect((await findUser(email)).displayName).toBe("しばた😀👍🏽");
		});

		test.each([
			["表示名が空", { displayName: "", grade: "B3" }],
			["表示名が空白だけ", { displayName: " 　 ", grade: "B3" }],
			["表示名が21文字", { displayName: "あ".repeat(21), grade: "B3" }],
			["表示名が無い", { grade: "B3" }],
			["学年が一覧に無い値", { displayName: "Shibata", grade: "B5" }],
			// 送り忘れと「教員を選んだ」を区別するため、教員は null を明示して送る
			["学年のキーが無い", { displayName: "Shibata" }],
			// 予約者名として全員に表示されるため、見えない名前や見た目の偽装になる文字は受け付けない
			["表示名がゼロ幅スペースだけ", { displayName: "\u200B", grade: "B3" }],
			[
				"表示名に文字の向きを変える文字",
				{ displayName: "a\u202Eb", grade: "B3" },
			],
			["表示名に改行", { displayName: "a\nb", grade: "B3" }],
			// PostgreSQL の text は NUL を保存できず、通すと 500 になる
			["表示名に NUL", { displayName: "a\u0000b", grade: "B3" }],
			// 対になっていないサロゲートは、Neon に送る JSON が壊れて 500 になる
			["表示名に対のないサロゲート", { displayName: "a\uD800b", grade: "B3" }],
			["表示名に行区切り", { displayName: "a\u2028b", grade: "B3" }],
			// 前後にあっても取り除かずに拒否する（trim は改行・行区切り・BOM も取り除いてしまう）
			["表示名の先頭に改行", { displayName: "\nShibata", grade: "B3" }],
			["表示名の先頭に行区切り", { displayName: "\u2028Shibata", grade: "B3" }],
			["表示名の先頭に BOM", { displayName: "\uFEFFShibata", grade: "B3" }],
			[
				"表示名の末尾にゼロ幅スペース",
				{ displayName: "Shibata\u200B", grade: "B3" },
			],
			// 1文字はコードポイント単位で数える（絵文字1つ = 1文字）
			["表示名が絵文字21個", { displayName: "😀".repeat(21), grade: "B3" }],
		])(
			"%s なら 400 と VALIDATION_ERROR を返し、登録しない",
			async (_, body) => {
				const { email, cookie } = await signInAsUnregistered();

				const res = await request("POST", "/api/me/profile", { cookie, body });

				expect(res.status).toBe(400);
				expect(await res.json()).toMatchObject({
					error: { code: "VALIDATION_ERROR" },
				});
				expect(await findUser(email)).toMatchObject({
					displayName: null,
					grade: null,
				});
			},
		);

		test("壊れた JSON なら 400 を共通の形で返す", async () => {
			const { cookie } = await signInAsUnregistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: "{not json",
			});

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "BAD_REQUEST" },
			});
		});

		test("登録済みなら 409 と PROFILE_ALREADY_REGISTERED を返し、1回目の内容のまま変えない", async () => {
			const { email, cookie } = await signInAsRegistered();

			const res = await request("POST", "/api/me/profile", {
				cookie,
				body: { displayName: "別の名前", grade: "M1" },
			});

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "PROFILE_ALREADY_REGISTERED" },
			});
			expect(await findUser(email)).toMatchObject({
				displayName: "Shibata",
				grade: "B3",
			});
		});

		// 「登録済みか調べてから更新する」2段階だと、同時に送られたときに両方とも通ってしまう
		test("同時に2回送っても、通るのは1回だけで、もう1回は 409 を返す", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const responses = await Promise.all([
				request("POST", "/api/me/profile", {
					cookie,
					body: { displayName: "一回目", grade: "B3" },
				}),
				request("POST", "/api/me/profile", {
					cookie,
					body: { displayName: "二回目", grade: "M1" },
				}),
			]);

			expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
			const user = await findUser(email);
			const succeeded = responses.findIndex((res) => res.status === 200);
			expect(user).toMatchObject(
				succeeded === 0
					? { displayName: "一回目", grade: "B3" }
					: { displayName: "二回目", grade: "M1" },
			);
		});

		test("未ログインなら 401 を返す", async () => {
			const res = await request("POST", "/api/me/profile", {
				body: { displayName: "Shibata", grade: "B3" },
			});

			expect(res.status).toBe(401);
		});
	});

	describe("PATCH /api/me/profile", () => {
		test("表示名だけを変え、学年は変えない。200 と変更後の自分の情報を返す", async () => {
			const { email, cookie } = await signInAsRegistered();

			const res = await request("PATCH", "/api/me/profile", {
				cookie,
				body: { displayName: "  しばた " },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				displayName: "しばた",
				grade: "B3",
			});
			expect(await findUser(email)).toMatchObject({
				displayName: "しばた",
				grade: "B3",
			});
		});

		test.each([
			["学年が含まれる", { displayName: "しばた", grade: "M1" }],
			["学年が null で含まれる", { displayName: "しばた", grade: null }],
			["表示名が空", { displayName: "" }],
			["表示名が21文字", { displayName: "あ".repeat(21) }],
			["表示名に文字の向きを変える文字", { displayName: "a\u202Eb" }],
			["表示名に対のないサロゲート", { displayName: "a\uD800b" }],
			["表示名の先頭に改行", { displayName: "\nしばた" }],
		])(
			"%s なら 400 と VALIDATION_ERROR を返し、変更しない",
			async (_, body) => {
				const { email, cookie } = await signInAsRegistered();

				const res = await request("PATCH", "/api/me/profile", { cookie, body });

				expect(res.status).toBe(400);
				expect(await res.json()).toMatchObject({
					error: { code: "VALIDATION_ERROR" },
				});
				expect(await findUser(email)).toMatchObject({
					displayName: "Shibata",
					grade: "B3",
				});
			},
		);

		// 表示名だけが入ると、学年を選ばないまま「登録済みの教員」と同じ状態になってしまう
		test("プロフィール未登録なら 409 と PROFILE_NOT_REGISTERED を返し、表示名は空のまま", async () => {
			const { email, cookie } = await signInAsUnregistered();

			const res = await request("PATCH", "/api/me/profile", {
				cookie,
				body: { displayName: "しばた" },
			});

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "PROFILE_NOT_REGISTERED" },
			});
			expect((await findUser(email)).displayName).toBeNull();
		});

		test("未ログインなら 401 を返す", async () => {
			const res = await request("PATCH", "/api/me/profile", {
				body: { displayName: "しばた" },
			});

			expect(res.status).toBe(401);
		});
	});
});
