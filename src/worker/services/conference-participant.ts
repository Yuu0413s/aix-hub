import { and, eq, type SQL, sql } from "drizzle-orm";
import type { ParticipationStatus } from "../../shared/participation-status";
import type { Db } from "../db/client";
import { createId } from "../db/id";
import {
	CONFERENCE_PARTICIPANTS_USER_UNIQUE,
	conferenceParticipants,
	conferences,
} from "../db/schema";
import { isUniqueViolation } from "../db/unique-violation";

// 参加者の行が userId の人のものか。書き込み（状態の変更・取消の UPDATE / DELETE）と、
// 表示（学会の詳細 services/conference.ts の isMine）の両方で使う。
// 別々に書くと、片方だけ直したときに「ボタンは出るのに 403 になる」などのずれが起きるため（services/reservation.ts と同じ理由）。
// conferenceParticipants を含むクエリの中で使う。ほかの条件と組み合わせても優先順位がずれないよう、全体を括弧で囲む
export function isOwnParticipation(userId: string): SQL {
	return sql`(${conferenceParticipants.userId} = ${userId})`;
}

export type CreateParticipationResult =
	| { ok: true; id: string }
	| {
			ok: false;
			reason: "CONFERENCE_NOT_FOUND" | "CONFERENCE_ALREADY_PARTICIPATING";
	  };

// userId の人を、学会の参加者に加える。他人を加える経路は作らない（呼ぶ側はログイン中の人の id を渡す）
export async function createParticipation(
	db: Db,
	{
		conferenceId,
		userId,
		status,
	}: { conferenceId: string; userId: string; status: ParticipationStatus },
): Promise<CreateParticipationResult> {
	try {
		// 学会を探してから入れる2段階にすると、その間に学会が消えたときに外部キーの違反で 500 になるため、
		// 学会が見つかったときだけ入れる1文の INSERT にする（入らなければ、学会が無かった。services/conference.ts の createConference と同じ）
		const [inserted] = await db
			.insert(conferenceParticipants)
			// select のビルダーで渡し、Drizzle に「キーの名前と順番が conferenceParticipants の列と同じか」を確かめさせる
			.select((qb) =>
				qb
					.select({
						id: sql<string>`${createId()}`.as("id"),
						conferenceId: conferences.id,
						userId: sql<string>`${userId}`.as("userId"),
						status:
							sql<ParticipationStatus>`${status}::"participationStatus"`.as(
								"status",
							),
					})
					.from(conferences)
					.where(eq(conferences.id, conferenceId))
					// 学会の削除（services/conference.ts の deleteConference）と同時のときに、500 ではなく 404 にするため、学会の行に共有ロックを掛ける。
					// 削除は学会の行を FOR UPDATE でロックしてから参加者 → 学会の順に消す。
					// - 削除が先なら：削除の確定を待ち、学会が消えたことを読み直して何も入れない（CONFERENCE_NOT_FOUND）
					// - 追加が先なら：削除の側がこの追加の確定を待ってから、加わった参加者ごと消す
					// ロックが無いと、削除の確定前の学会を読んで入れ、外部キーの確認で削除の確定を待ったあとに外部キーの違反になる
					.for("share"),
			)
			.returning({ id: conferenceParticipants.id });

		if (!inserted) {
			return { ok: false, reason: "CONFERENCE_NOT_FOUND" };
		}
		return { ok: true, id: inserted.id };
	} catch (error) {
		// すでに参加しているかを先に SELECT で確かめると、確かめてから入れるまでの間に同じ人の追加（別のタブなど）が割り込めるため、
		// UNIQUE(conferenceId, userId) に任せる（Issue #19 の方針）
		if (isUniqueViolation(error, CONFERENCE_PARTICIPANTS_USER_UNIQUE)) {
			return { ok: false, reason: "CONFERENCE_ALREADY_PARTICIPATING" };
		}
		throw error;
	}
}

// 本人の行でないときは FORBIDDEN、行が無い（または URL の学会の参加者でない）ときは CONFERENCE_PARTICIPANT_NOT_FOUND
export type ParticipationChangeResult =
	| { ok: true }
	| {
			ok: false;
			reason: "CONFERENCE_PARTICIPANT_NOT_FOUND" | "FORBIDDEN";
	  };

type ParticipantTarget = {
	conferenceId: string;
	participantId: string;
	// 操作するログイン中の人。本人の行だけを変えられる
	userId: string;
};

// URL の学会の、participantId の行か
function isTargetParticipant({
	conferenceId,
	participantId,
}: ParticipantTarget): SQL | undefined {
	return and(
		eq(conferenceParticipants.id, participantId),
		eq(conferenceParticipants.conferenceId, conferenceId),
	);
}

// 書き込めなかった理由を調べる SELECT。書き込みと同じ batch で送る。
// 理由はレスポンスを分けるためだけに使い、書き込むかどうかの判断には使わない（判断は書き込みの条件が行う）
function findTargetParticipant(db: Db, target: ParticipantTarget) {
	return db
		.select({ id: conferenceParticipants.id })
		.from(conferenceParticipants)
		.where(isTargetParticipant(target));
}

function changeFailure(found: { id: string }[]): ParticipationChangeResult {
	// 行があるのに書き込めなかったのは、本人の行でないとき
	return {
		ok: false,
		reason: found.length > 0 ? "FORBIDDEN" : "CONFERENCE_PARTICIPANT_NOT_FOUND",
	};
}

export async function updateParticipation(
	db: Db,
	{ status, ...target }: ParticipantTarget & { status: ParticipationStatus },
): Promise<ParticipationChangeResult> {
	// 本人の行かを確かめてから書き換える2段階にせず、本人の行であることを条件にした1文の UPDATE にする
	// （予約の取消 services/reservation.ts の cancelReservation と同じ形）
	const [updated, found] = await db.batch([
		db
			.update(conferenceParticipants)
			.set({ status })
			.where(
				and(isTargetParticipant(target), isOwnParticipation(target.userId)),
			)
			.returning({ id: conferenceParticipants.id }),
		findTargetParticipant(db, target),
	]);

	if (updated.length > 0) {
		return { ok: true };
	}
	return changeFailure(found);
}

export async function deleteParticipation(
	db: Db,
	target: ParticipantTarget,
): Promise<ParticipationChangeResult> {
	// 状態の変更と同じく、本人の行であることを条件にした1文の DELETE にする
	const [deleted, found] = await db.batch([
		db
			.delete(conferenceParticipants)
			.where(
				and(isTargetParticipant(target), isOwnParticipation(target.userId)),
			)
			.returning({ id: conferenceParticipants.id }),
		findTargetParticipant(db, target),
	]);

	if (deleted.length > 0) {
		return { ok: true };
	}
	return changeFailure(found);
}
