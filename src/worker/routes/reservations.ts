import { Hono } from "hono";
import { API_ERROR_CODES, errorBody } from "../../shared/api-errors";
import { createDb } from "../db/client";
import {
	type AuthEnv,
	RESERVER_ROLES,
	requireAuth,
	requireProfile,
	requireRole,
} from "../middleware/auth";
import { cancelReservation, createReservation } from "../services/reservation";

// /slots と /reservations の2つのパスを持つため、index.ts では "/" に登録する。
// "/" に登録したアプリで use() を使うと、ミドルウェアが /api のすべてのパス（/health など）に掛かるため、
// ミドルウェアはルートごとに掛ける
export const reservationRoutes = new Hono<AuthEnv>()
	.post(
		"/slots/:slotId/reservations",
		requireAuth,
		requireProfile,
		requireRole(...RESERVER_ROLES),
		async (c) => {
			const result = await createReservation(createDb(c.env.DATABASE_URL), {
				slotId: c.req.param("slotId"),
				userId: c.get("user").id,
				now: new Date(),
			});

			if (result.ok) {
				return c.json({ reservation: result.reservation });
			}
			switch (result.reason) {
				case "SLOT_NOT_FOUND":
					return c.json(
						errorBody(API_ERROR_CODES.SLOT_NOT_FOUND, "枠が見つかりません"),
						404,
					);
				case "SLOT_TAKEN":
					return c.json(
						errorBody(
							API_ERROR_CODES.SLOT_TAKEN,
							"この枠はすでに予約されています",
						),
						409,
					);
				case "SLOT_NOT_RESERVABLE":
					return c.json(
						errorBody(
							API_ERROR_CODES.SLOT_NOT_RESERVABLE,
							"この枠は予約できません",
						),
						409,
					);
			}
		},
	)
	.delete("/reservations/:id", requireAuth, requireProfile, async (c) => {
		const reservationId = c.req.param("id");
		const result = await cancelReservation(createDb(c.env.DATABASE_URL), {
			reservationId,
			actor: c.get("user"),
			now: new Date(),
		});

		if (result.ok) {
			return c.json({ id: reservationId });
		}
		switch (result.reason) {
			case "RESERVATION_NOT_FOUND":
				return c.json(
					errorBody(
						API_ERROR_CODES.RESERVATION_NOT_FOUND,
						"予約が見つかりません",
					),
					404,
				);
			case "FORBIDDEN":
				return c.json(
					errorBody(
						API_ERROR_CODES.FORBIDDEN,
						"この予約を取り消す権限がありません",
					),
					403,
				);
			case "RESERVATION_NOT_CANCELABLE":
				return c.json(
					errorBody(
						API_ERROR_CODES.RESERVATION_NOT_CANCELABLE,
						"開始時刻を過ぎた予約・実施済みの予約は取り消せません",
					),
					409,
				);
		}
	});
