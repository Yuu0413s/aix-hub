import { Hono } from "hono";
import { API_ERROR_CODES, errorBody } from "../../shared/api-errors";
import {
	adminDayParamSchema,
	adminSlotParamSchema,
	adminUserParamSchema,
	gradePromotionInputSchema,
	seminarDayStatusInputSchema,
	slotInputSchema,
	userRoleInputSchema,
} from "../../shared/schemas";
import { currentTime } from "../clock";
import { createDb } from "../db/client";
import { type AuthEnv, requireAuth, requireRole } from "../middleware/auth";
import {
	executeGradePromotion,
	getGradePromotionStatus,
} from "../services/grade-promotion";
import { updateSeminarDayStatus } from "../services/seminar-day";
import { updateSlot } from "../services/slot";
import { listUsers, updateUserRole } from "../services/user";
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
	// 枠の種類・開始時刻・終了時刻の変更。presentation から presentation 以外にしたら予約を消す（services/slot.ts の updateSlot）
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
							"画面を開いたあとに枠が変わっています",
						),
						409,
					);
			}
		},
	)
	.get("/users", async (c) => {
		return c.json({ users: await listUsers(createDb(c.env.DATABASE_URL)) });
	})
	// 役割の変更。最後の admin は外せず、teacher にしたら学年と開始前の予約を消し、学年の無い人を student にするときは学年が要る（services/user.ts の updateUserRole）
	.patch(
		"/users/:id",
		validateParam(adminUserParamSchema),
		validateJson(userRoleInputSchema),
		async (c) => {
			const result = await updateUserRole(createDb(c.env.DATABASE_URL), {
				actorId: c.get("user").id,
				userId: c.req.valid("param").id,
				...c.req.valid("json"),
				now: currentTime(),
			});

			if (result.ok) {
				return c.json({
					user: result.user,
					deletedReservationCount: result.deletedReservationCount,
				});
			}
			switch (result.reason) {
				// 入口の確認を通ったあとに、ほかの管理者に外されたとき
				case "FORBIDDEN":
					return c.json(
						errorBody(
							API_ERROR_CODES.FORBIDDEN,
							"この操作を行う権限がありません",
						),
						403,
					);
				case "USER_NOT_FOUND":
					return c.json(
						errorBody(API_ERROR_CODES.USER_NOT_FOUND, "利用者が見つかりません"),
						404,
					);
				case "LAST_ADMIN":
					return c.json(
						errorBody(
							API_ERROR_CODES.LAST_ADMIN,
							"在籍中の管理者がいなくなるため、変更できません",
						),
						409,
					);
				case "GRADE_REQUIRED":
					return c.json(
						errorBody(API_ERROR_CODES.GRADE_REQUIRED, "学年を選んでください"),
						409,
					);
			}
		},
	)
	// 今の年度の学年更新の状況と対象者
	.get("/grade-promotions", async (c) => {
		return c.json(
			await getGradePromotionStatus(
				createDb(c.env.DATABASE_URL),
				currentTime(),
			),
		);
	})
	// 学年更新の実行（services/grade-promotion.ts の executeGradePromotion）
	.post(
		"/grade-promotions",
		validateJson(gradePromotionInputSchema),
		async (c) => {
			const result = await executeGradePromotion(createDb(c.env.DATABASE_URL), {
				actorId: c.get("user").id,
				paths: c.req.valid("json").paths,
				now: currentTime(),
			});

			if (result.ok) {
				const { ok: _ok, ...summary } = result;
				return c.json(summary);
			}
			switch (result.reason) {
				case "NOT_OPEN":
					return c.json(
						errorBody(
							API_ERROR_CODES.GRADE_PROMOTION_NOT_OPEN,
							"学年更新は4月の間だけ実行できます",
						),
						409,
					);
				case "ALREADY_EXECUTED":
					return c.json(
						errorBody(
							API_ERROR_CODES.GRADE_PROMOTION_ALREADY_EXECUTED,
							"この年度の学年更新は実行済みです",
						),
						409,
					);
				case "PATH_REQUIRED":
					return c.json(
						errorBody(
							API_ERROR_CODES.GRADE_PROMOTION_PATH_REQUIRED,
							"進路を選んでいない人がいます",
						),
						409,
					);
				case "LAST_ADMIN":
					return c.json(
						errorBody(
							API_ERROR_CODES.LAST_ADMIN,
							"在籍中の管理者がいなくなるため、実行できません",
						),
						409,
					);
			}
		},
	);
