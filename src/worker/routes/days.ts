import { and, asc, count, eq, gte, lt, notExists, sql } from "drizzle-orm";
import { Hono } from "hono";
import { API_ERROR_CODES, errorBody } from "../../shared/api-errors";
import { addMonths } from "../../shared/date";
import { dayParamSchema, monthDaysQuerySchema } from "../../shared/schemas";
import { currentTime } from "../clock";
import { createDb } from "../db/client";
import { reservations, seminarDays, slots, users } from "../db/schema";
import { type AuthEnv, isReserver, requireAuth } from "../middleware/auth";
import {
	reservationCancelableBy,
	slotAcceptsReservation,
} from "../services/reservation";
import { validateParam, validateQuery } from "../validator";

export const daysRoutes = new Hono<AuthEnv>()
	.use(requireAuth)
	.get("/", validateQuery(monthDaysQuerySchema), async (c) => {
		const { month } = c.req.valid("query");
		const db = createDb(c.env.DATABASE_URL);

		const rows = await db
			.select({
				date: seminarDays.date,
				status: seminarDays.status,
				closedReason: seminarDays.closedReason,
				availableSlotCount: count(slots.id),
			})
			.from(seminarDays)
			// 枠が1つも無い開催日も 0 件として返すため、inner join ではなく left join にする。
			// 予約のある枠は reserved・done のどちらでも数えない（過去の日に空きがあるように見せないため）
			.leftJoin(
				slots,
				and(
					eq(slots.seminarDayId, seminarDays.id),
					eq(slots.kind, "presentation"),
					notExists(
						db
							.select({ id: reservations.id })
							.from(reservations)
							.where(eq(reservations.slotId, slots.id)),
					),
				),
			)
			// 「翌月の 1 日より前」で区切る。月末の日付（28〜31 日）を計算しなくて済むようにするため
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
					availableSlotCount: isClosed ? 0 : row.availableSlotCount,
				};
			}),
		});
	})
	.get("/:date", validateParam(dayParamSchema), async (c) => {
		const { date } = c.req.valid("param");
		const db = createDb(c.env.DATABASE_URL);
		const user = c.get("user");
		const now = currentTime();
		// 予約の API（routes/reservations.ts）と同じく、teacher とプロフィール未登録の人は予約できない
		const isUserAllowedToReserve = isReserver(user);

		// 開催日と枠を batch で1回で送る（neon-http は問い合わせ1つごとに通信が1往復かかるため）。
		// 分離レベルは既定（READ COMMITTED）のままなので、2つの SELECT が同じ時点を見る保証はない。
		// 表示するだけの API で、ずれても次の取得で正しい表に戻るため許容する
		const [days, slotRows] = await db.batch([
			db
				.select({
					date: seminarDays.date,
					status: seminarDays.status,
					closedReason: seminarDays.closedReason,
				})
				.from(seminarDays)
				.where(eq(seminarDays.date, date)),
			db
				.select({
					id: slots.id,
					period: slots.period,
					startTime: slots.startTime,
					endTime: slots.endTime,
					kind: slots.kind,
					// 予約できるか・取り消せるかの条件は、予約・取消の API と同じもの（services/reservation.ts）を使う
					isSlotAccepting: sql<boolean>`${slotAcceptsReservation(now)}`,
					reservationId: reservations.id,
					displayName: users.displayName,
					grade: users.grade,
					// 予約の無い枠では NULL になるが、その枠では使わない
					isCancelable: sql<boolean>`${reservationCancelableBy(user, now)}`,
				})
				.from(slots)
				.innerJoin(seminarDays, eq(seminarDays.id, slots.seminarDayId))
				// 予約の無い枠も行として返すため left join にする
				.leftJoin(reservations, eq(reservations.slotId, slots.id))
				.leftJoin(users, eq(users.id, reservations.userId))
				.where(eq(seminarDays.date, date))
				.orderBy(asc(slots.startTime)),
		]);

		const day = days[0];
		if (!day) {
			return c.json(
				errorBody(
					API_ERROR_CODES.SEMINAR_DAY_NOT_FOUND,
					"この日は開催日ではありません",
				),
				404,
			);
		}

		return c.json({
			day: {
				date: day.date,
				status: day.status,
				// GET / と同じく、休止を取り消したあとに古い理由が残っていても出さない
				closedReason: day.status === "closed" ? day.closedReason : null,
			},
			slots: slotRows.map((row) => ({
				id: row.id,
				period: row.period,
				// DB の time は 13:30:00 で返るため、時間割（schedule-template.ts）と同じ HH:MM にそろえる
				startTime: row.startTime.slice(0, 5),
				endTime: row.endTime.slice(0, 5),
				kind: row.kind,
				isReservable:
					isUserAllowedToReserve &&
					row.isSlotAccepting &&
					row.reservationId === null,
				// 予約があるかは予約の id で判定する（表示名は users の列が NULL を許すため、予約の有無の判定に使わない）
				reservation:
					row.reservationId === null
						? null
						: {
								id: row.reservationId,
								displayName: row.displayName,
								grade: row.grade,
								isCancelable: row.isCancelable,
							},
			})),
		});
	});
