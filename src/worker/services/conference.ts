import { asc, desc, eq, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
	conferenceParticipants,
	conferenceSeries,
	conferences,
	users,
} from "../db/schema";

export type ConferenceListStatus = "open" | "closed";

// 受付中か。today は日本時間の YYYY-MM-DD（Workers は UTC で動くため、呼ぶ側が tokyoDate で決める。設計メモ リスク4）。
// 締切が空欄の学会も受付中にする（設計メモ リスク6）。条件を返す関数は、ほかの条件と組み合わせても優先順位がずれないよう、全体を括弧で囲む
export function isConferenceOpen(today: string): SQL {
	return sql`(${conferences.submissionDeadline} is null or ${conferences.submissionDeadline} >= ${today}::date)`;
}

// 締切済みか。締切が空欄なら比較の結果が NULL になり、締切済みに入らない（受付中にだけ入る）
export function isConferenceClosed(today: string): SQL {
	return sql`(${conferences.submissionDeadline} < ${today}::date)`;
}

// 受付中は締切が近い順で、締切が空欄の学会は最後。締切済みは最近締め切った順（2026-11-10, Issue #17 で決定）。
// PostgreSQL の既定では、昇順なら NULL は最後だが、降順にすると先頭になる。向きを変えても位置が黙って変わらないよう nulls last と明示する。
// 同じ締切の学会も毎回同じ順に並ぶよう、学会名、id の順で並べる
function conferenceListOrder(status: ConferenceListStatus): SQL[] {
	const deadlineOrder =
		status === "open"
			? sql`${conferences.submissionDeadline} asc nulls last`
			: sql`${conferences.submissionDeadline} desc nulls last`;
	return [deadlineOrder, asc(conferences.title), asc(conferences.id)];
}

// 参加者は投稿済み → 投稿予定 → 検討中の順、同じ状態の中では表示名の順。
// enum は宣言の順（shared/participation-status.ts の検討中 → 投稿予定 → 投稿済み）で比べられるため、降順にすると投稿済みが先頭になる
function participantOrder(): SQL[] {
	return [
		desc(conferenceParticipants.status),
		sql`${users.displayName} asc nulls last`,
		asc(conferenceParticipants.id),
	];
}

// 一覧。学会ごとに参加者を取ると学会の数だけ問い合わせが増えるため、学会と参加者を同じ条件で別々に取り、batch で1回で送る
export async function findConferences(
	db: Db,
	{ status, today }: { status: ConferenceListStatus; today: string },
) {
	const condition =
		status === "open" ? isConferenceOpen(today) : isConferenceClosed(today);

	const [conferenceRows, participantRows] = await db.batch([
		db
			.select({
				id: conferences.id,
				title: conferences.title,
				seriesName: conferenceSeries.name,
				venue: conferences.venue,
				submissionDeadline: conferences.submissionDeadline,
				startDate: conferences.startDate,
				endDate: conferences.endDate,
			})
			.from(conferences)
			.innerJoin(
				conferenceSeries,
				eq(conferenceSeries.id, conferences.seriesId),
			)
			.where(condition)
			.orderBy(...conferenceListOrder(status)),
		db
			.select({
				conferenceId: conferenceParticipants.conferenceId,
				displayName: users.displayName,
				status: conferenceParticipants.status,
			})
			.from(conferenceParticipants)
			.innerJoin(
				conferences,
				eq(conferences.id, conferenceParticipants.conferenceId),
			)
			.innerJoin(users, eq(users.id, conferenceParticipants.userId))
			.where(condition)
			.orderBy(...participantOrder()),
	]);

	// 学会の id は主キーのため重複せず、振り分けのキーにできる
	const participantsByConference = new Map<
		string,
		{
			displayName: string | null;
			status: (typeof participantRows)[number]["status"];
		}[]
	>();
	for (const { conferenceId, ...participant } of participantRows) {
		const participants = participantsByConference.get(conferenceId) ?? [];
		participants.push(participant);
		participantsByConference.set(conferenceId, participants);
	}

	return conferenceRows.map((conference) => ({
		...conference,
		participants: participantsByConference.get(conference.id) ?? [],
	}));
}

// 詳細。無ければ null
export async function findConference(db: Db, conferenceId: string) {
	const [conferenceRows, participants] = await db.batch([
		db
			.select({
				id: conferences.id,
				title: conferences.title,
				seriesName: conferenceSeries.name,
				venue: conferences.venue,
				url: conferences.url,
				submissionDeadline: conferences.submissionDeadline,
				submissionNote: conferences.submissionNote,
				startDate: conferences.startDate,
				endDate: conferences.endDate,
				scheduleNote: conferences.scheduleNote,
				description: conferences.description,
				note: conferences.note,
				createdAt: conferences.createdAt,
				updatedAt: conferences.updatedAt,
			})
			.from(conferences)
			.innerJoin(
				conferenceSeries,
				eq(conferenceSeries.id, conferences.seriesId),
			)
			.where(eq(conferences.id, conferenceId)),
		db
			.select({
				id: conferenceParticipants.id,
				displayName: users.displayName,
				grade: users.grade,
				status: conferenceParticipants.status,
			})
			.from(conferenceParticipants)
			.innerJoin(users, eq(users.id, conferenceParticipants.userId))
			.where(eq(conferenceParticipants.conferenceId, conferenceId))
			.orderBy(...participantOrder()),
	]);

	const conference = conferenceRows[0];
	if (!conference) {
		return null;
	}
	return { ...conference, participants };
}
