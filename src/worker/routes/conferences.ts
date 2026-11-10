import { Hono } from "hono";
import { API_ERROR_CODES, errorBody } from "../../shared/api-errors";
import { tokyoDate } from "../../shared/date";
import {
	conferenceParamSchema,
	conferencesQuerySchema,
} from "../../shared/schemas";
import { currentTime } from "../clock";
import { createDb } from "../db/client";
import { type AuthEnv, requireAuth } from "../middleware/auth";
import { findConference, findConferences } from "../services/conference";
import { validateParam, validateQuery } from "../validator";

const conferenceNotFound = errorBody(
	API_ERROR_CODES.CONFERENCE_NOT_FOUND,
	"学会が見つかりません",
);

// 見るだけなので、プロフィール登録は求めない（全体連絡の一覧と同じ）。
// id の形の検証は、ログインの確認の後ろに置く（未ログインなら、送られた id に関係なく 401 を先に返すため。routes/announcements.ts と同じ）
export const conferenceRoutes = new Hono<AuthEnv>()
	.use(requireAuth)
	.get("/", validateQuery(conferencesQuerySchema), async (c) => {
		const rows = await findConferences(createDb(c.env.DATABASE_URL), {
			status: c.req.valid("query").status,
			today: tokyoDate(currentTime()),
		});
		return c.json({ conferences: rows });
	})
	.get("/:id", validateParam(conferenceParamSchema), async (c) => {
		const conference = await findConference(
			createDb(c.env.DATABASE_URL),
			c.req.valid("param").id,
		);
		if (!conference) {
			return c.json(conferenceNotFound, 404);
		}
		return c.json({ conference });
	});
