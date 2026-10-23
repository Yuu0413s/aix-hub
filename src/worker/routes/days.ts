import { and, asc, count, eq, gte, lt } from "drizzle-orm";
import { Hono } from "hono";
import { addMonths } from "../../shared/date";
import { monthDaysQuerySchema } from "../../shared/schemas";
import { createDb } from "../db/client";
import { seminarDays, slots } from "../db/schema";
import { type AuthEnv, requireAuth } from "../middleware/auth";
import { validateQuery } from "../validator";

export const daysRoutes = new Hono<AuthEnv>()
	.use(requireAuth)
	.get("/", validateQuery(monthDaysQuerySchema), async (c) => {
		const { month } = c.req.valid("query");
		const db = createDb(c.env.DATABASE_URL);

		// 「翌月の 1 日より前」で区切る。月末の日付（28〜31 日）を計算しなくて済むようにするため
		const rows = await db
			.select({
				date: seminarDays.date,
				status: seminarDays.status,
				closedReason: seminarDays.closedReason,
				presentationSlotCount: count(slots.id),
			})
			.from(seminarDays)
			// 枠が1つも無い開催日も 0 件として返すため、inner join ではなく left join にする。
			// #7 で予約ができたら、予約の無い枠だけを数える条件をここに足す
			.leftJoin(
				slots,
				and(
					eq(slots.seminarDayId, seminarDays.id),
					eq(slots.kind, "presentation"),
				),
			)
			.where(
				and(
					gte(seminarDays.date, `${month}-01`),
					lt(seminarDays.date, `${addMonths(month, 1)}-01`),
				),
			)
			.groupBy(seminarDays.id)
			.orderBy(asc(seminarDays.date));

		return c.json({
			days: rows.map((row) => {
				const isClosed = row.status === "closed";
				return {
					date: row.date,
					status: row.status,
					// 休止を取り消したあとに古い理由が残っていても、画面に出さないため
					closedReason: isClosed ? row.closedReason : null,
					// 休止日は予約できないため、枠が残っていても空きは 0 にする
					availableSlotCount: isClosed ? 0 : row.presentationSlotCount,
				};
			}),
		});
	});
