import { eq, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { API_ERROR_CODES, errorBody } from "../../shared/api-errors";
import { tokyoDate } from "../../shared/date";
import {
	announcementInputSchema,
	announcementParamSchema,
	currentAnnouncementsQuerySchema,
} from "../../shared/schemas";
import { currentTime } from "../clock";
import { createDb, type Db } from "../db/client";
import { announcements, seminarDays, users } from "../db/schema";
import {
	type AuthEnv,
	type AuthUser,
	requireAuth,
	requireProfile,
	requireRole,
} from "../middleware/auth";
import {
	announcementDisplayOrder,
	createAnnouncement,
	deleteAnnouncement,
	isAnnouncementDisplayed,
	isAnnouncementEditableBy,
	isAnnouncementUpcoming,
	updateAnnouncement,
} from "../services/announcement";
import { validateJson, validateParam, validateQuery } from "../validator";

// 表示中の一覧（?current）と表示前の一覧（/upcoming）で同じ形・同じ並び順で返す
function findAnnouncements(db: Db, user: AuthUser, condition: SQL) {
	return db
		.select({
			id: announcements.id,
			date: seminarDays.date,
			body: announcements.body,
			displayFrom: announcements.displayFrom,
			displayUntil: announcements.displayUntil,
			authorDisplayName: users.displayName,
			// 編集できるかの条件は、編集・削除の API と同じもの（services/announcement.ts）を使う
			isEditable: sql<boolean>`${isAnnouncementEditableBy(user)}`,
		})
		.from(announcements)
		.innerJoin(seminarDays, eq(seminarDays.id, announcements.seminarDayId))
		.innerJoin(users, eq(users.id, announcements.authorId))
		.where(condition)
		.orderBy(...announcementDisplayOrder());
}

const announcementNotFound = errorBody(
	API_ERROR_CODES.ANNOUNCEMENT_NOT_FOUND,
	"連絡が見つかりません",
);
const seminarDayNotFound = errorBody(
	API_ERROR_CODES.SEMINAR_DAY_NOT_FOUND,
	"この日は開催日ではありません",
);
const forbidden = errorBody(
	API_ERROR_CODES.FORBIDDEN,
	"この連絡を変更する権限がありません",
);

// id の形の検証は、ログイン・権限の確認の後ろに置く（未ログインなら、送られた id に関係なく 401 を先に返すため。routes/reservations.ts と同じ）
export const announcementRoutes = new Hono<AuthEnv>()
	.use(requireAuth)
	// 「今週の全体連絡」。設計メモの API どおり ?current のときだけ受け付ける
	.get("/", validateQuery(currentAnnouncementsQuerySchema), async (c) => {
		const today = tokyoDate(currentTime());
		const rows = await findAnnouncements(
			createDb(c.env.DATABASE_URL),
			c.get("user"),
			isAnnouncementDisplayed(today),
		);
		return c.json({ announcements: rows });
	})
	// まだ表示が始まっていない連絡。トップに出ないため、書いた人（admin は全員分）が確認・編集できるように返す。
	// ?current と同じ場所にすると、クエリによって返す中身が変わり、RPC のレスポンスの型が混ざるため、パスを分ける
	.get("/upcoming", async (c) => {
		const user = c.get("user");
		const today = tokyoDate(currentTime());
		const rows = await findAnnouncements(
			createDb(c.env.DATABASE_URL),
			user,
			// and() は条件が無いと undefined を返す型のため、括弧で囲んだ2つの条件を直接つなぐ
			sql`${isAnnouncementUpcoming(today)} and ${isAnnouncementEditableBy(user)}`,
		);
		return c.json({ announcements: rows });
	})
	.post(
		"/",
		requireProfile,
		requireRole("teacher", "admin"),
		validateJson(announcementInputSchema),
		async (c) => {
			const result = await createAnnouncement(createDb(c.env.DATABASE_URL), {
				input: c.req.valid("json"),
				authorId: c.get("user").id,
				now: currentTime(),
			});
			if (!result.ok) {
				return c.json(seminarDayNotFound, 404);
			}
			return c.json({ id: result.id });
		},
	)
	// 書いた本人なら役割が変わっていても直せるため、役割では絞らない（services/announcement.ts の isAnnouncementEditableBy）
	.patch(
		"/:id",
		requireProfile,
		validateParam(announcementParamSchema),
		validateJson(announcementInputSchema),
		async (c) => {
			const announcementId = c.req.valid("param").id;
			const result = await updateAnnouncement(createDb(c.env.DATABASE_URL), {
				announcementId,
				input: c.req.valid("json"),
				actor: c.get("user"),
			});

			if (result.ok) {
				return c.json({ id: announcementId });
			}
			switch (result.reason) {
				case "ANNOUNCEMENT_NOT_FOUND":
					return c.json(announcementNotFound, 404);
				case "FORBIDDEN":
					return c.json(forbidden, 403);
				case "SEMINAR_DAY_NOT_FOUND":
					return c.json(seminarDayNotFound, 404);
			}
		},
	)
	.delete(
		"/:id",
		requireProfile,
		validateParam(announcementParamSchema),
		async (c) => {
			const announcementId = c.req.valid("param").id;
			const result = await deleteAnnouncement(createDb(c.env.DATABASE_URL), {
				announcementId,
				actor: c.get("user"),
			});

			if (result.ok) {
				return c.json({ id: announcementId });
			}
			switch (result.reason) {
				case "ANNOUNCEMENT_NOT_FOUND":
					return c.json(announcementNotFound, 404);
				case "FORBIDDEN":
					return c.json(forbidden, 403);
			}
		},
	);
