import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm";
import type { ConferenceListStatus } from "../../shared/conference-list-status";
import type { Db } from "../db/client";
import { createId } from "../db/id";
import {
	CONFERENCE_SERIES_NAME_UNIQUE,
	CONFERENCES_TITLE_UNIQUE,
	conferenceParticipants,
	conferenceSeries,
	conferences,
	users,
} from "../db/schema";
import { isUniqueViolation } from "../db/unique-violation";
import { isOwnParticipation } from "./conference-participant";

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
// 同じ締切の学会も毎回同じ順に並ぶよう、学会名、id の順で並べる。
// 並び順を変えたら、画面の説明文（client/routes/conferences/index.tsx の CONFERENCE_TABS の orderNote）も直す
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

// 詳細。無ければ null。
// 参加者の isMine は、userId（ログイン中の人）の行か。画面が自分の今の状態と、変更・取消に使う行を見分けるために使う
export async function findConference(
	db: Db,
	{ conferenceId, userId }: { conferenceId: string; userId: string },
) {
	const [conferenceRows, participants] = await db.batch([
		db
			.select({
				id: conferences.id,
				title: conferences.title,
				// 編集フォームで、今のシリーズを選んだ状態にするため
				seriesId: conferences.seriesId,
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
				// 本人の行かの条件は、変更・取消の API と同じもの（services/conference-participant.ts）を使う
				isMine: sql<boolean>`${isOwnParticipation(userId)}`,
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

// 登録・編集で保存する値（API の検証 shared/schemas.ts の conferenceInputSchema を通ったもの。空欄は null）
export type ConferenceInput = {
	seriesId: string;
	title: string;
	venue: string | null;
	url: string | null;
	submissionDeadline: string | null;
	submissionNote: string | null;
	startDate: string | null;
	endDate: string | null;
	scheduleNote: string | null;
	description: string | null;
	note: string | null;
};

export type CreateConferenceResult =
	| { ok: true; id: string }
	| {
			ok: false;
			reason: "CONFERENCE_SERIES_NOT_FOUND" | "CONFERENCE_TITLE_TAKEN";
	  };

export async function createConference(
	db: Db,
	input: ConferenceInput,
): Promise<CreateConferenceResult> {
	try {
		// シリーズを探してから入れる2段階にすると、その間にシリーズが消えたときに外部キーの違反で 500 になるため、
		// シリーズが見つかったときだけ入れる1文の INSERT にする（入らなければ、シリーズが無かった。services/announcement.ts と同じ）。
		// select のビルダーで渡し、Drizzle に「キーの名前と順番が conferences の列と同じか」を確かめさせる。
		// そのため、既定値のある列も省略せずに選ぶ
		const [inserted] = await db
			.insert(conferences)
			.select((qb) =>
				qb
					.select({
						id: sql<string>`${createId()}`.as("id"),
						seriesId: conferenceSeries.id,
						title: sql<string>`${input.title}`.as("title"),
						venue: sql<string | null>`${input.venue}`.as("venue"),
						url: sql<string | null>`${input.url}`.as("url"),
						submissionDeadline: sql<
							string | null
						>`${input.submissionDeadline}::date`.as("submissionDeadline"),
						submissionNote: sql<string | null>`${input.submissionNote}`.as(
							"submissionNote",
						),
						startDate: sql<string | null>`${input.startDate}::date`.as(
							"startDate",
						),
						endDate: sql<string | null>`${input.endDate}::date`.as("endDate"),
						scheduleNote: sql<string | null>`${input.scheduleNote}`.as(
							"scheduleNote",
						),
						description: sql<string | null>`${input.description}`.as(
							"description",
						),
						note: sql<string | null>`${input.note}`.as("note"),
						createdAt: sql<Date>`now()`.as("createdAt"),
						updatedAt: sql<Date>`now()`.as("updatedAt"),
					})
					.from(conferenceSeries)
					.where(eq(conferenceSeries.id, input.seriesId)),
			)
			.returning({ id: conferences.id });

		if (!inserted) {
			return { ok: false, reason: "CONFERENCE_SERIES_NOT_FOUND" };
		}
		return { ok: true, id: inserted.id };
	} catch (error) {
		// 同じ学会名があるかを先に SELECT で確かめると、確かめてから入れるまでの間に同じ名前で登録されうるため、UNIQUE 制約に任せる
		if (isUniqueViolation(error, CONFERENCES_TITLE_UNIQUE)) {
			return { ok: false, reason: "CONFERENCE_TITLE_TAKEN" };
		}
		throw error;
	}
}

export type UpdateConferenceResult =
	| { ok: true }
	| {
			ok: false;
			reason:
				| "CONFERENCE_NOT_FOUND"
				| "CONFERENCE_SERIES_NOT_FOUND"
				| "CONFERENCE_TITLE_TAKEN";
	  };

export async function updateConference(
	db: Db,
	{ conferenceId, input }: { conferenceId: string; input: ConferenceInput },
): Promise<UpdateConferenceResult> {
	let updated: { id: string }[];
	let found: { id: string }[];
	try {
		// 登録と同じ理由で、シリーズがあるときだけ書き換える1文の UPDATE にし、
		// 書き換えられなかったときの理由を調べる SELECT を batch で一緒に送る（services/announcement.ts の編集と同じ形）。
		// updatedAt は set に書かなくても、スキーマの $onUpdate で今の時刻になる
		[updated, found] = await db.batch([
			db
				.update(conferences)
				.set({
					seriesId: sql`${conferenceSeries.id}`,
					title: input.title,
					venue: input.venue,
					url: input.url,
					submissionDeadline: input.submissionDeadline,
					submissionNote: input.submissionNote,
					startDate: input.startDate,
					endDate: input.endDate,
					scheduleNote: input.scheduleNote,
					description: input.description,
					note: input.note,
				})
				.from(conferenceSeries)
				.where(
					and(
						eq(conferences.id, conferenceId),
						eq(conferenceSeries.id, input.seriesId),
					),
				)
				.returning({ id: conferences.id }),
			db
				.select({ id: conferences.id })
				.from(conferences)
				.where(eq(conferences.id, conferenceId)),
		]);
	} catch (error) {
		if (isUniqueViolation(error, CONFERENCES_TITLE_UNIQUE)) {
			return { ok: false, reason: "CONFERENCE_TITLE_TAKEN" };
		}
		throw error;
	}

	if (updated.length > 0) {
		return { ok: true };
	}
	// 学会があるのに書き換わらなかったのは、シリーズが無かったとき。
	// 学会もシリーズも無いときは、学会が無いことを先に伝える（URL の学会を開き直しても直らないため）
	return {
		ok: false,
		reason:
			found.length > 0 ? "CONFERENCE_SERIES_NOT_FOUND" : "CONFERENCE_NOT_FOUND",
	};
}

export type DeleteConferenceResult =
	| { ok: true }
	| { ok: false; reason: "CONFERENCE_NOT_FOUND" };

// 参加者の外部キーは RESTRICT のため、参加者 → 学会の順に消す（設計メモ db-conferences.md「削除の流れ」）
export async function deleteConference(
	db: Db,
	conferenceId: string,
): Promise<DeleteConferenceResult> {
	const [, , deleted] = await db.batch([
		// 先に学会の行をロックする。参加者の追加（services/conference-participant.ts の createParticipation）は学会の行を共有ロックするため、
		// この batch が終わるまで待つ（終わったあとは学会が無いため、追加は何も入れずに CONFERENCE_NOT_FOUND を返す）。
		// ロックしないと、参加者を消してから学会を消すまでの間に参加者が加わり、学会を消すときに外部キーの違反で 500 になる
		db
			.select({ id: conferences.id })
			.from(conferences)
			.where(eq(conferences.id, conferenceId))
			.for("update"),
		db
			.delete(conferenceParticipants)
			.where(eq(conferenceParticipants.conferenceId, conferenceId)),
		db
			.delete(conferences)
			.where(eq(conferences.id, conferenceId))
			.returning({ id: conferences.id }),
	]);

	if (deleted.length === 0) {
		return { ok: false, reason: "CONFERENCE_NOT_FOUND" };
	}
	return { ok: true };
}

// シリーズの一覧（登録・編集フォームのプルダウン用）。名前の順で、同じ並びが毎回返るよう id でも並べる
export function listConferenceSeries(db: Db) {
	return db
		.select({ id: conferenceSeries.id, name: conferenceSeries.name })
		.from(conferenceSeries)
		.orderBy(asc(conferenceSeries.name), asc(conferenceSeries.id));
}

export type CreateConferenceSeriesResult =
	| { ok: true; series: { id: string; name: string } }
	| { ok: false; reason: "CONFERENCE_SERIES_NAME_TAKEN" };

export async function createConferenceSeries(
	db: Db,
	name: string,
): Promise<CreateConferenceSeriesResult> {
	try {
		const [series] = await db
			.insert(conferenceSeries)
			.values({ id: createId(), name })
			.returning({ id: conferenceSeries.id, name: conferenceSeries.name });
		if (!series) {
			throw new Error("作ったシリーズが返りませんでした");
		}
		return { ok: true, series };
	} catch (error) {
		// 学会名と同じく、同じ名前があるかは UNIQUE 制約に任せる
		if (isUniqueViolation(error, CONFERENCE_SERIES_NAME_UNIQUE)) {
			return { ok: false, reason: "CONFERENCE_SERIES_NAME_TAKEN" };
		}
		throw error;
	}
}
