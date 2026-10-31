import { Hono } from "hono";
import { API_ERROR_CODES, errorBody } from "../../shared/api-errors";
import {
	adminDayParamSchema,
	adminSlotParamSchema,
	seminarDayStatusInputSchema,
	slotInputSchema,
} from "../../shared/schemas";
import { currentTime } from "../clock";
import { createDb } from "../db/client";
import { type AuthEnv, requireAuth, requireRole } from "../middleware/auth";
import { updateSeminarDayStatus } from "../services/seminar-day";
import { updateSlot } from "../services/slot";
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
	)
	// 枠の種類・開始時刻・終了時刻の変更。presentation 以外にしたら予約を消す（services/slot.ts の updateSlot）
	.patch(
		"/slots/:id",
		validateParam(adminSlotParamSchema),
		validateJson(slotInputSchema),
		async (c) => {
			const { previous, ...input } = c.req.valid("json");
			const result = await updateSlot(createDb(c.env.DATABASE_URL), {
				slotId: c.req.valid("param").id,
				input,
				previous,
				now: currentTime(),
			});

			if (result.ok) {
				const { slot } = result;
				return c.json({
					slot: {
						...slot,
						// DB の time は 13:30:00 で返るため、日別の表（routes/days.ts）と同じ HH:MM にそろえる
						startTime: slot.startTime.slice(0, 5),
						endTime: slot.endTime.slice(0, 5),
					},
					deletedReservationCount: result.deletedReservationCount,
				});
			}
			switch (result.reason) {
				case "SLOT_NOT_FOUND":
					return c.json(
						errorBody(API_ERROR_CODES.SLOT_NOT_FOUND, "枠が見つかりません"),
						404,
					);
				case "SLOT_STARTED":
					return c.json(
						errorBody(
							API_ERROR_CODES.SLOT_STARTED,
							"開始時刻を過ぎた枠は変更できません",
						),
						409,
					);
				case "SLOT_START_TIME_TAKEN":
					return c.json(
						errorBody(
							API_ERROR_CODES.SLOT_START_TIME_TAKEN,
							"同じ日に同じ開始時刻の枠があります",
						),
						409,
					);
				case "SLOT_CHANGED":
					return c.json(
						errorBody(
							API_ERROR_CODES.SLOT_CHANGED,
							"ほかの管理者がこの枠を変更しました",
						),
						409,
					);
			}
		},
	);
