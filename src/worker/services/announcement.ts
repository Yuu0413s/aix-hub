import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { createId } from "../db/id";
import { announcements, seminarDays } from "../db/schema";
import type { Actor } from "./reservation";

// 連絡を「編集できるか」「表示中か」「表示前か」の条件は、ここの SQL にだけ書き、
// 書き込み（UPDATE / DELETE）と表示（routes/announcements.ts の一覧・isEditable）の両方で使う（services/reservation.ts と同じ理由）

// 表示を始める日。開始日が空なら作成日。作成日時は UTC で持つため、日本時間の日付にしてから使う（設計メモ リスク6）
function displayStartDate(): SQL {
	return sql`coalesce(${announcements.displayFrom}, (${announcements.createdAt} at time zone 'Asia/Tokyo')::date)`;
}

// 表示を終える日（この日まで表示する）。終了日が空なら開催日。seminarDays を結合したクエリの中で使う
function displayEndDate(): SQL {
	return sql`coalesce(${announcements.displayUntil}, ${seminarDays.date})`;
}

// today（日本時間の YYYY-MM-DD）が表示期間に入っているか。seminarDays を結合したクエリの中で使う。
// 条件を返す関数は、ほかの条件と組み合わせても優先順位がずれないよう、全体を括弧で囲む
export function isAnnouncementDisplayed(today: string): SQL {
	return sql`(${displayStartDate()} <= ${today}::date and ${today}::date <= ${displayEndDate()})`;
}

// まだ表示が始まっていないか（表示を始める日が today より後）
export function isAnnouncementUpcoming(today: string): SQL {
	return sql`(${displayStartDate()} > ${today}::date)`;
}

// actor が連絡を編集・削除できるか。admin は全員分、それ以外は自分が書いた分だけ。
// 書いた本人は、あとで役割が変わっても自分の分を直せる（2026-10-30, Issue #9 で決定）
export function isAnnouncementEditableBy(actor: Actor): SQL {
	if (actor.role === "admin") {
		return sql`true`;
	}
	return sql`(${announcements.authorId} = ${actor.id})`;
}

// 一覧の並び順。表示を始める日の昇順で、同じ日なら作成した順
export function announcementDisplayOrder(): SQL[] {
	return [asc(displayStartDate()), asc(announcements.createdAt)];
}

export type AnnouncementInput = {
	// 連絡を書く開催日（YYYY-MM-DD）
	date: string;
	body: string;
	displayFrom: string | null;
	displayUntil: string | null;
};

export type CreateAnnouncementResult =
	| { ok: true; id: string }
	| { ok: false; reason: "SEMINAR_DAY_NOT_FOUND" };

export async function createAnnouncement(
	db: Db,
	{
		input,
		authorId,
		now,
	}: { input: AnnouncementInput; authorId: string; now: Date },
): Promise<CreateAnnouncementResult> {
	// 開催日を探してから入れる2段階にすると、その間に開催日が消えたときに外部キーの違反で 500 になるため、
	// 開催日が見つかったときだけ入れる1文の INSERT にする（入らなければ、開催日が無かった）
	const [inserted] = await db
		.insert(announcements)
		// select のビルダーで渡し、Drizzle に「キーの名前と順番が announcements の列と同じか」を確かめさせる
		// （services/reservation.ts と同じ理由）。そのため、既定値のある列も省略せずに選ぶ
		.select((qb) =>
			qb
				.select({
					id: sql<string>`${createId()}`.as("id"),
					seminarDayId: seminarDays.id,
					authorId: sql<string>`${authorId}`.as("authorId"),
					body: sql<string>`${input.body}`.as("body"),
					displayFrom: sql<string | null>`${input.displayFrom}::date`.as(
						"displayFrom",
					),
					displayUntil: sql<string | null>`${input.displayUntil}::date`.as(
						"displayUntil",
					),
					createdAt: sql<Date>`${now.toISOString()}::timestamptz`.as(
						"createdAt",
					),
					updatedAt: sql<Date>`now()`.as("updatedAt"),
				})
				.from(seminarDays)
				.where(eq(seminarDays.date, input.date)),
		)
		.returning({ id: announcements.id });

	if (!inserted) {
		return { ok: false, reason: "SEMINAR_DAY_NOT_FOUND" };
	}
	return { ok: true, id: inserted.id };
}

export type UpdateAnnouncementResult =
	| { ok: true }
	| {
			ok: false;
			reason: "ANNOUNCEMENT_NOT_FOUND" | "FORBIDDEN" | "SEMINAR_DAY_NOT_FOUND";
	  };

export async function updateAnnouncement(
	db: Db,
	{
		announcementId,
		input,
		actor,
	}: { announcementId: string; input: AnnouncementInput; actor: Actor },
): Promise<UpdateAnnouncementResult> {
	// 予約の取消（services/reservation.ts）と同じく、編集できるかと開催日があるかを条件にした1文の UPDATE にし、
	// 書き換えられなかったときの理由を調べる SELECT を batch で一緒に送る
	const [updated, found] = await db.batch([
		db
			.update(announcements)
			.set({
				seminarDayId: sql`${seminarDays.id}`,
				body: input.body,
				displayFrom: input.displayFrom,
				displayUntil: input.displayUntil,
			})
			.from(seminarDays)
			.where(
				and(
					eq(announcements.id, announcementId),
					eq(seminarDays.date, input.date),
					isAnnouncementEditableBy(actor),
				),
			)
			.returning({ id: announcements.id }),
		findEditability(db, announcementId, actor),
	]);

	if (updated.length > 0) {
		return { ok: true };
	}
	const announcement = found[0];
	if (!announcement) {
		return { ok: false, reason: "ANNOUNCEMENT_NOT_FOUND" };
	}
	// 編集できる人の連絡が書き換わらなかったのは、開催日が無かったとき。
	// 権限を先に確かめ、他人の連絡については開催日があるかを答えない
	return {
		ok: false,
		reason: announcement.isEditable ? "SEMINAR_DAY_NOT_FOUND" : "FORBIDDEN",
	};
}

export type DeleteAnnouncementResult =
	| { ok: true }
	| { ok: false; reason: "ANNOUNCEMENT_NOT_FOUND" | "FORBIDDEN" };

export async function deleteAnnouncement(
	db: Db,
	{ announcementId, actor }: { announcementId: string; actor: Actor },
): Promise<DeleteAnnouncementResult> {
	const [deleted, found] = await db.batch([
		db
			.delete(announcements)
			.where(
				and(
					eq(announcements.id, announcementId),
					isAnnouncementEditableBy(actor),
				),
			)
			.returning({ id: announcements.id }),
		findEditability(db, announcementId, actor),
	]);

	if (deleted.length > 0) {
		return { ok: true };
	}
	return {
		ok: false,
		reason: found[0] ? "FORBIDDEN" : "ANNOUNCEMENT_NOT_FOUND",
	};
}

// 書き込めなかったときの理由を調べる。理由はレスポンスを分けるためだけに使い、書き込むかどうかの判断には使わない
function findEditability(db: Db, announcementId: string, actor: Actor) {
	return db
		.select({ isEditable: sql<boolean>`${isAnnouncementEditableBy(actor)}` })
		.from(announcements)
		.where(eq(announcements.id, announcementId));
}
