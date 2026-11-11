import { Hono } from "hono";
import { API_ERROR_CODES, errorBody } from "../../shared/api-errors";
import { tokyoDate } from "../../shared/date";
import {
	conferenceInputSchema,
	conferenceParamSchema,
	conferenceSeriesInputSchema,
	conferencesQuerySchema,
} from "../../shared/schemas";
import { currentTime } from "../clock";
import { createDb } from "../db/client";
import { type AuthEnv, requireAuth, requireProfile } from "../middleware/auth";
import {
	createConference,
	createConferenceSeries,
	deleteConference,
	findConference,
	findConferences,
	listConferenceSeries,
	updateConference,
} from "../services/conference";
import { validateJson, validateParam, validateQuery } from "../validator";

const conferenceNotFound = errorBody(
	API_ERROR_CODES.CONFERENCE_NOT_FOUND,
	"学会が見つかりません",
);
const conferenceTitleTaken = errorBody(
	API_ERROR_CODES.CONFERENCE_TITLE_TAKEN,
	"同じ名前の学会がすでにあります",
);
const conferenceSeriesNotFound = errorBody(
	API_ERROR_CODES.CONFERENCE_SERIES_NOT_FOUND,
	"選んだシリーズが見つかりません",
);
const conferenceSeriesNameTaken = errorBody(
	API_ERROR_CODES.CONFERENCE_SERIES_NAME_TAKEN,
	"同じ名前のシリーズがすでにあります",
);

// 見るだけの GET には、プロフィール登録は求めない（全体連絡の一覧と同じ）。
// 書き込み（登録・編集・削除）は、全体連絡と同じく表示名の無い人にはさせないため requireProfile を付ける。役割では絞らない（誰でも編集できる。設計メモ「ユーザー」）。
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
	})
	.post("/", requireProfile, validateJson(conferenceInputSchema), async (c) => {
		const result = await createConference(
			createDb(c.env.DATABASE_URL),
			c.req.valid("json"),
		);
		if (result.ok) {
			return c.json({ id: result.id });
		}
		switch (result.reason) {
			case "CONFERENCE_SERIES_NOT_FOUND":
				return c.json(conferenceSeriesNotFound, 404);
			case "CONFERENCE_TITLE_TAKEN":
				return c.json(conferenceTitleTaken, 409);
		}
	})
	.patch(
		"/:id",
		requireProfile,
		validateParam(conferenceParamSchema),
		validateJson(conferenceInputSchema),
		async (c) => {
			const conferenceId = c.req.valid("param").id;
			const result = await updateConference(createDb(c.env.DATABASE_URL), {
				conferenceId,
				input: c.req.valid("json"),
			});
			if (result.ok) {
				return c.json({ id: conferenceId });
			}
			switch (result.reason) {
				case "CONFERENCE_NOT_FOUND":
					return c.json(conferenceNotFound, 404);
				case "CONFERENCE_SERIES_NOT_FOUND":
					return c.json(conferenceSeriesNotFound, 404);
				case "CONFERENCE_TITLE_TAKEN":
					return c.json(conferenceTitleTaken, 409);
			}
		},
	)
	.delete(
		"/:id",
		requireProfile,
		validateParam(conferenceParamSchema),
		async (c) => {
			const conferenceId = c.req.valid("param").id;
			const result = await deleteConference(
				createDb(c.env.DATABASE_URL),
				conferenceId,
			);
			if (!result.ok) {
				return c.json(conferenceNotFound, 404);
			}
			return c.json({ id: conferenceId });
		},
	);

// 学会シリーズ（登録・編集フォームのプルダウンと、フォームの中からの作成）。
// 学会と同じく、見るだけの GET はログインだけ、作成はプロフィール登録も求める
export const conferenceSeriesRoutes = new Hono<AuthEnv>()
	.use(requireAuth)
	.get("/", async (c) => {
		const series = await listConferenceSeries(createDb(c.env.DATABASE_URL));
		return c.json({ series });
	})
	.post(
		"/",
		requireProfile,
		validateJson(conferenceSeriesInputSchema),
		async (c) => {
			const result = await createConferenceSeries(
				createDb(c.env.DATABASE_URL),
				c.req.valid("json").name,
			);
			if (!result.ok) {
				return c.json(conferenceSeriesNameTaken, 409);
			}
			return c.json({ series: result.series });
		},
	);
