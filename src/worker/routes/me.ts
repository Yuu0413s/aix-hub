import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { API_ERROR_CODES, errorBody } from "../../shared/api-errors";
import { createProfileSchema, updateProfileSchema } from "../../shared/schemas";
import { currentTime } from "../clock";
import { createDb } from "../db/client";
import { reservations, seminarDays, slots, users } from "../db/schema";
import {
	type AuthEnv,
	isProfileRegistered,
	requireAuth,
} from "../middleware/auth";
import {
	isReservationCancelableBy,
	isSlotStarted,
} from "../services/reservation";
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
	})
	// プロフィール未登録の人は予約を持たないため、ほかの人と同じ形で空の一覧と 0 になる
	.get("/reservations", async (c) => {
		const user = c.get("user");
		// teacher は予約しない（設計メモ「役割」）。役割を変える前に入った予約などが DB に残っていても、
		// teacher には空の一覧と 0 を返すことを API で保証する（運用で起きないことに頼らないため）
		if (user.role === "teacher") {
			return c.json({ presentationCount: 0, reservations: [] });
		}
		const db = createDb(c.env.DATABASE_URL);
		const now = currentTime();

		const rows = await db
			.select({
				id: reservations.id,
				date: seminarDays.date,
				startTime: slots.startTime,
				endTime: slots.endTime,
				status: reservations.status,
				// 取り消せるかの条件は、取消の API・日別の表と同じもの（services/reservation.ts）を使う
				isCancelable: sql<boolean>`${isReservationCancelableBy(user, now)}`,
				// 「済」にするのは毎晩の Cron のため、当日に開始時刻を過ぎた予約は reserved のまま。画面で予約中から外すために返す
				isStarted: sql<boolean>`${isSlotStarted(now)}`,
			})
			.from(reservations)
			.innerJoin(slots, eq(slots.id, reservations.slotId))
			.innerJoin(seminarDays, eq(seminarDays.id, slots.seminarDayId))
			.where(eq(reservations.userId, user.id))
			.orderBy(asc(seminarDays.date), asc(slots.startTime));

		return c.json({
			// 発表回数は、別に数えず一覧の done から出す（別の問い合わせにすると、一覧と回数が食い違うことがあるため）
			presentationCount: rows.filter((row) => row.status === "done").length,
			reservations: rows.map((row) => ({
				...row,
				// DB の time は 13:30:00 で返るため、日別の表（routes/days.ts）と同じ HH:MM にそろえる
				startTime: row.startTime.slice(0, 5),
				endTime: row.endTime.slice(0, 5),
			})),
		});
	});
