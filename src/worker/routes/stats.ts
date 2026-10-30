import { and, asc, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import { reservations, users } from "../db/schema";
import {
	type AuthEnv,
	RESERVER_ROLES,
	requireAuth,
	requireRole,
} from "../middleware/auth";

// 発表回数は先生と管理者だけが全員分を見られる（設計メモ「公開範囲」）
export const statsRoutes = new Hono<AuthEnv>()
	.use(requireAuth, requireRole("teacher", "admin"))
	// 載せるのは、予約できる役割（teacher は予約しない）で在籍中の、プロフィール登録済みの人。0 回の人も載せる
	.get("/presentations", async (c) => {
		const db = createDb(c.env.DATABASE_URL);

		const rows = await db
			.select({
				id: users.id,
				// 下の WHERE で NULL を除いているため、型も string にそろえる
				displayName: sql<string>`${users.displayName}`,
				grade: users.grade,
				presentationCount: count(reservations.id),
			})
			.from(users)
			// done の条件は WHERE ではなく結合の条件に書く。WHERE に書くと、done の予約が無い人の行が消え、0 回の人が載らなくなるため
			.leftJoin(
				reservations,
				and(eq(reservations.userId, users.id), eq(reservations.status, "done")),
			)
			.where(
				and(
					inArray(users.role, RESERVER_ROLES),
					eq(users.isEnrolled, true),
					isNotNull(users.displayName),
				),
			)
			.groupBy(users.id)
			// 学年は enum の定義順（shared/grade.ts の GRADES の順）に並べ、学年の無い人（教員として登録した admin）は最後にする（設計メモ）。
			// PostgreSQL では昇順なら既定でも NULL は最後だが、既定は降順にすると逆（先頭）になる。
			// 並びの向きを変えても位置が黙って変わらないよう、nulls last と明示する（Drizzle の asc() では指定できないため sql で書く）。
			// 同じ学年・同じ表示名の人がいても毎回同じ順に並ぶよう、最後に id で並べる
			.orderBy(
				sql`${users.grade} asc nulls last`,
				asc(users.displayName),
				asc(users.id),
			);

		return c.json({ users: rows });
	});
