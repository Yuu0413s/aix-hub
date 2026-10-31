import { Hono } from "hono";
import { API_ERROR_CODES, errorBody } from "../../shared/api-errors";
import {
	adminDayParamSchema,
	seminarDayStatusInputSchema,
} from "../../shared/schemas";
import { currentTime } from "../clock";
import { createDb } from "../db/client";
import { type AuthEnv, requireAuth, requireRole } from "../middleware/auth";
import { updateSeminarDayStatus } from "../services/seminar-day";
import { validateJson, validateParam } from "../validator";

// 管理画面の API。admin だけが使える（設計メモ「役割」）。
// 表示名は使わないため、発表回数一覧（routes/stats.ts）と同じく requireProfile は掛けない
export const adminRoutes = new Hono<AuthEnv>()
	.use(requireAuth, requireRole("admin"))
	// 開催日の休止・再開と休止理由。行が無い日は作る（services/seminar-day.ts の updateSeminarDayStatus）
	.patch(
		"/days/:date",
		validateParam(adminDayParamSchema),
		validateJson(seminarDayStatusInputSchema),
		async (c) => {
			const result = await updateSeminarDayStatus(
				createDb(c.env.DATABASE_URL),
				{
					date: c.req.valid("param").date,
					input: c.req.valid("json"),
					now: currentTime(),
				},
			);

			if (!result.ok) {
				return c.json(
					errorBody(
						API_ERROR_CODES.SEMINAR_DAY_PAST,
						"今日より前の開催日は変更できません",
					),
					409,
				);
			}
			return c.json({
				day: result.day,
				deletedReservationCount: result.deletedReservationCount,
			});
		},
	);
