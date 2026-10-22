import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { API_ERROR_CODES, errorBody } from "../../shared/api-errors";
import { createProfileSchema, updateProfileSchema } from "../../shared/schemas";
import { createDb } from "../db/client";
import { users } from "../db/schema";
import {
	type AuthEnv,
	isProfileRegistered,
	requireAuth,
} from "../middleware/auth";
import { validateJson } from "../validator";

type MeSource = Pick<
	typeof users.$inferSelect,
	"id" | "email" | "displayName" | "grade" | "role"
>;

// GET と、POST / PATCH の成功時は同じ形で返す（登録・変更の後に画面がもう一度取りに行かなくて済むように）
function toMeResponse(user: MeSource) {
	return {
		id: user.id,
		email: user.email,
		displayName: user.displayName,
		grade: user.grade,
		role: user.role,
		isProfileRegistered: isProfileRegistered(user),
	};
}

const meColumns = {
	id: users.id,
	email: users.email,
	displayName: users.displayName,
	grade: users.grade,
	role: users.role,
};

export const meRoutes = new Hono<AuthEnv>()
	.use(requireAuth)
	.get("/", (c) => {
		const user = c.get("user");
		// better-auth は値の無い追加列を undefined で返すことがあるため、DB と同じ null にそろえる
		return c.json(
			toMeResponse({
				...user,
				displayName: user.displayName ?? null,
				grade: user.grade ?? null,
			}),
		);
	})
	.post("/profile", validateJson(createProfileSchema), async (c) => {
		const { displayName, grade } = c.req.valid("json");
		const db = createDb(c.env.DATABASE_URL);

		// 「登録済みか調べてから更新する」2段階にすると、同時に送られたときに両方とも通ってしまうため、
		// 未登録であることを条件にした1文の UPDATE にし、更新できた行の有無で判定する
		const [updated] = await db
			.update(users)
			.set({ displayName, grade, updatedAt: new Date() })
			.where(and(eq(users.id, c.get("user").id), isNull(users.displayName)))
			.returning(meColumns);

		if (!updated) {
			return c.json(
				errorBody(
					API_ERROR_CODES.PROFILE_ALREADY_REGISTERED,
					"プロフィールは登録済みです",
				),
				409,
			);
		}
		return c.json(toMeResponse(updated));
	})
	.patch("/profile", validateJson(updateProfileSchema), async (c) => {
		const { displayName } = c.req.valid("json");
		const db = createDb(c.env.DATABASE_URL);

		// 未登録の人の表示名だけが入ると、学年を選ばないまま「登録済みの教員」と同じ状態になるため、
		// 登録済みであることを条件にする（POST と同じく1文の UPDATE で判定する）
		const [updated] = await db
			.update(users)
			.set({ displayName, updatedAt: new Date() })
			.where(and(eq(users.id, c.get("user").id), isNotNull(users.displayName)))
			.returning(meColumns);

		if (!updated) {
			return c.json(
				errorBody(
					API_ERROR_CODES.PROFILE_NOT_REGISTERED,
					"先にプロフィールを登録してください",
				),
				409,
			);
		}
		return c.json(toMeResponse(updated));
	});
