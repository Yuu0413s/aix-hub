import { and, eq, inArray, lt, type SQL, sql } from "drizzle-orm";
import { tokyoDate } from "../../shared/date";
import type { Db } from "../db/client";
import { createId } from "../db/id";
import { reservations, seminarDays, slots } from "../db/schema";
import type { Actor } from "./actor";

// 枠・予約の状態で決まる「予約を受け付けるか」「取り消せるか」の条件は、ここの SQL にだけ書き、
// 書き込み（INSERT / DELETE）と表示（日別の表 routes/days.ts の isReservable / isCancelable、マイページ routes/me.ts の isCancelable）の両方で使う。
// 別々に書くと、片方だけ直したときに「押せるのに 409 になる」などのずれが起きるため。
// 「開始したか」（isSlotStarted、マイページ routes/me.ts の isStarted）は表示でしか使わないが、
// 予約・取消の「開始前」と境界がずれないよう、同じ isNotStarted から作るためここに置く。
// 休止で消す予約（services/seminar-day.ts の updateSeminarDayStatus）と、編集できる枠（services/slot.ts の updateSlot）も、
// 同じ isNotStarted で「開始前」を決める。
// 誰が予約できるか（役割・プロフィール）は middleware/auth.ts の RESERVER_ROLES / isReserver を共有する。
// 枠がすでに埋まっているかは、INSERT では slotId の UNIQUE が、日別の表では予約の有無が決める

// 枠の開始日時がまだ来ていないか。開催日と開始時刻はタイムゾーンを持たないため、日本時間として読んでから比べる
// （Workers は UTC で動くため、そのまま比べると 9 時間ずれる。設計メモ リスク6）。
// slots と seminarDays を結合したクエリの中で使う。ほかの条件と同じく、全体を括弧で囲む（下の isSlotAcceptingReservation の説明）
export function isNotStarted(now: Date): SQL {
	return sql`((${seminarDays.date} + ${slots.startTime}) at time zone 'Asia/Tokyo' > ${now.toISOString()}::timestamptz)`;
}

// 枠が予約を受け付ける状態か（発表の枠・休止でない日・開始前）。すでに予約があるかは含まない。
// slots と seminarDays を結合したクエリの中で使う。
// 条件を返す関数は、ほかの条件と組み合わせても優先順位がずれないよう、全体を括弧で囲む
export function isSlotAcceptingReservation(now: Date): SQL {
	return sql`(${slots.kind} = 'presentation' and ${seminarDays.status} = 'open' and ${isNotStarted(now)})`;
}

// 枠の開始日時を過ぎたか（開始時刻ちょうども含む）。マイページで、「済」になる前の当日の予約を予約中から外すために使う。
// isNotStarted の否定にし、予約・取消の「開始前」と境界がずれないようにする。slots と seminarDays を結合したクエリの中で使う
export function isSlotStarted(now: Date): SQL {
	return sql`(not (${isNotStarted(now)}))`;
}

// actor が予約を取り消せるか。admin はいつでも（done も）取り消せる。
// 本人は、done になっておらず、開始前の予約だけ（発表した記録を本人が消せないようにするため）。
// reservations を含むクエリの中で使う。開始日時は予約の枠から副問い合わせで読むため、slots を結合していなくても使える
export function isReservationCancelableBy(actor: Actor, now: Date): SQL {
	if (actor.role === "admin") {
		return sql`true`;
	}
	// Drizzle の exists() は sql で書いた文を括弧で囲まず、構文エラーになるため、exists (...) を直接書く
	return sql`(${reservations.userId} = ${actor.id} and ${reservations.status} = 'reserved' and exists (
		select 1 from ${slots} inner join ${seminarDays} on ${seminarDays.id} = ${slots.seminarDayId}
		where ${slots.id} = ${reservations.slotId} and ${isNotStarted(now)}
	))`;
}

export type CreateReservationResult =
	| {
			ok: true;
			reservation: { id: string; slotId: string; status: "reserved" };
	  }
	| {
			ok: false;
			reason: "SLOT_NOT_FOUND" | "SLOT_TAKEN" | "SLOT_NOT_RESERVABLE";
	  };

export async function createReservation(
	db: Db,
	{ slotId, userId, now }: { slotId: string; userId: string; now: Date },
): Promise<CreateReservationResult> {
	// 「予約できるか確かめてから入れる」2段階にすると、確かめてから入れるまでの間に別の予約が割り込めるため、
	// 条件に合う枠だけを選んで入れる1文の INSERT にし、二重予約は slotId の UNIQUE（ON CONFLICT）で防ぐ。
	// 入らなかったときの理由を調べる SELECT も batch で一緒に送る（通信を1往復で済ませるため）。
	// 理由はレスポンスの文言を分けるためだけに使い、予約するかどうかの判断には使わない
	const [inserted, found] = await db.batch([
		db
			.insert(reservations)
			// select のビルダーで渡し、Drizzle に「キーの名前と順番が reservations の列と同じか」を確かめさせる
			// （services/seminar-day.ts と同じ理由）。そのため、既定値のある列も省略せずに選ぶ
			.select((qb) =>
				qb
					.select({
						id: sql<string>`${createId()}`.as("id"),
						slotId: slots.id,
						userId: sql<string>`${userId}`.as("userId"),
						status: sql<"reserved">`'reserved'::"reservationStatus"`.as(
							"status",
						),
						createdAt: sql<Date>`now()`.as("createdAt"),
						updatedAt: sql<Date>`now()`.as("updatedAt"),
					})
					.from(slots)
					.innerJoin(seminarDays, eq(seminarDays.id, slots.seminarDayId))
					.where(and(eq(slots.id, slotId), isSlotAcceptingReservation(now)))
					// 管理者が同時に休止したとき（services/seminar-day.ts の updateSeminarDayStatus）に、休止日の開始前の枠に予約が残らないよう、
					// 開催日の行に共有ロックを掛ける。ロックが無いと、休止がまだ確定していない間はこの SELECT が「開催中」と読んで予約を入れ、
					// 休止の側もまだ確定していないこの予約を見つけられずに消し残す。
					// - 休止が先なら：休止の確定を待ち、更新後の行で条件を確かめ直す（休止日なので入らない）
					// - 予約が先なら：休止の側がこの予約の確定を待ってから予約を消す
					// 枠の行にも同じ理由で共有ロックを掛ける。管理者が同時に枠の種類を presentation 以外に変えたとき
					// （services/slot.ts の updateSlot）に、その枠に予約が残らないようにするため
					.for("share", { of: [seminarDays, slots] }),
			)
			.onConflictDoNothing({ target: reservations.slotId })
			.returning({
				id: reservations.id,
				slotId: reservations.slotId,
				status: reservations.status,
			}),
		db
			.select({
				isAccepting: sql<boolean>`${isSlotAcceptingReservation(now)}`,
			})
			.from(slots)
			.innerJoin(seminarDays, eq(seminarDays.id, slots.seminarDayId))
			.where(eq(slots.id, slotId)),
	]);

	const reservation = inserted[0];
	if (reservation) {
		return {
			ok: true,
			reservation: { ...reservation, status: "reserved" },
		};
	}
	const slot = found[0];
	if (!slot) {
		return { ok: false, reason: "SLOT_NOT_FOUND" };
	}
	// 受け付けている枠に入らなかったのは、INSERT の時点で予約があった（UNIQUE とぶつかった）とき。
	// 「予約が無いなら予約できない枠」と予約の有無から決めると、batch は READ COMMITTED で動くため、
	// INSERT と SELECT の間にその予約が取り消されたときに、空いている枠を「予約できない」と返してしまう
	return {
		ok: false,
		reason: slot.isAccepting ? "SLOT_TAKEN" : "SLOT_NOT_RESERVABLE",
	};
}

export type CancelReservationResult =
	| { ok: true }
	| {
			ok: false;
			reason:
				| "RESERVATION_NOT_FOUND"
				| "FORBIDDEN"
				| "RESERVATION_NOT_CANCELABLE";
	  };

export async function cancelReservation(
	db: Db,
	{
		reservationId,
		actor,
		now,
	}: { reservationId: string; actor: Actor; now: Date },
): Promise<CancelReservationResult> {
	// 予約と同じく、取り消せるかを条件にした1文の DELETE にし、消せなかったときの理由を調べる SELECT を batch で一緒に送る
	const [deleted, found] = await db.batch([
		db
			.delete(reservations)
			.where(
				and(
					eq(reservations.id, reservationId),
					isReservationCancelableBy(actor, now),
				),
			)
			.returning({ id: reservations.id }),
		db
			.select({ userId: reservations.userId })
			.from(reservations)
			.where(eq(reservations.id, reservationId)),
	]);

	if (deleted.length > 0) {
		return { ok: true };
	}
	const reservation = found[0];
	if (!reservation) {
		return { ok: false, reason: "RESERVATION_NOT_FOUND" };
	}
	// 本人の予約なら、権限はあるが状態（開始後・done）で取り消せない。他人の予約なら権限が無い
	return {
		ok: false,
		reason:
			reservation.userId === actor.id
				? "RESERVATION_NOT_CANCELABLE"
				: "FORBIDDEN",
	};
}

// 開催日が今日（日本時間）より前の reserved を done にし、done にした件数を返す。
// reserved だけを対象にするため、何度実行しても結果が同じになり、Cron が失敗した翌晩にも追いつける
export async function markPastReservationsDone(
	db: Db,
	now: Date,
): Promise<number> {
	const updated = await db
		.update(reservations)
		.set({ status: "done" })
		.where(
			and(
				eq(reservations.status, "reserved"),
				inArray(
					reservations.slotId,
					db
						.select({ id: slots.id })
						.from(slots)
						.innerJoin(seminarDays, eq(seminarDays.id, slots.seminarDayId))
						.where(lt(seminarDays.date, tokyoDate(now))),
				),
			),
		)
		.returning({ id: reservations.id });
	return updated.length;
}
