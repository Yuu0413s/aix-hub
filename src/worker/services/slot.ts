import { and, eq, exists, inArray, sql } from "drizzle-orm";
import type { SlotKind } from "../../shared/schedule-template";
import type { Db } from "../db/client";
import {
	reservations,
	SLOTS_START_TIME_UNIQUE,
	seminarDays,
	slots,
} from "../db/schema";
import { isUniqueViolation } from "../db/unique-violation";
import { isNotStarted } from "./reservation";

export type SlotInput = {
	kind: SlotKind;
	startTime: string;
	endTime: string;
};

export type UpdateSlotResult =
	| {
			ok: true;
			slot: {
				id: string;
				period: number;
				startTime: string;
				endTime: string;
				kind: SlotKind;
			};
			// 種類を presentation から presentation 以外にして消した予約の件数（0 か 1）
			deletedReservationCount: number;
	  }
	| {
			ok: false;
			reason:
				| "SLOT_NOT_FOUND"
				| "SLOT_STARTED"
				| "SLOT_START_TIME_TAKEN"
				| "SLOT_CHANGED";
	  };

// 管理者が枠の種類・開始時刻・終了時刻を変える。種類を presentation から presentation 以外にしたら、その枠の予約を消す（時刻だけなら残す）。
// 開始時刻を過ぎた枠は変えない（2026-10-31, Issue #12 で決定）。休止（services/seminar-day.ts）と同じく、発表済みの予約を消したり、
// 過去の記録を書き換えたりしないため。
// previous（画面で見ていた変更前の値）が今の枠と違うときも変えない。3項目をすべて上書きするため、古い画面から保存すると、
// 変えていない項目まで古い値に戻し、ほかの管理者の変更（break にした枠など）を黙って取り消してしまうため
export async function updateSlot(
	db: Db,
	{
		slotId,
		input,
		previous,
		now,
	}: { slotId: string; input: SlotInput; previous: SlotInput; now: Date },
): Promise<UpdateSlotResult> {
	// 枠を変えてよいか（開始前で、今の値が previous と同じ）。枠のロック・予約の DELETE・枠の UPDATE の3つの文で同じ条件を使い、
	// どの文も更新する前の値で判定する。条件に合わなければ、どの文も何もしない（予約だけが消えることもない）
	const isEditableSlot = and(
		eq(slots.id, slotId),
		eq(slots.kind, previous.kind),
		eq(slots.startTime, previous.startTime),
		eq(slots.endTime, previous.endTime),
		exists(
			db
				.select({ id: seminarDays.id })
				.from(seminarDays)
				.where(and(eq(seminarDays.id, slots.seminarDayId), isNotStarted(now))),
		),
	);
	// 条件を入れた1文の UPDATE にする（確かめてから更新するまでの間に結果が変わらないように）。
	// ほかの管理者が同じ枠を同時に更新していたら、その確定を待ってから、確定後の値で確かめ直す
	const updateSlotRow = db
		.update(slots)
		.set(input)
		.where(isEditableSlot)
		.returning({
			id: slots.id,
			period: slots.period,
			startTime: slots.startTime,
			endTime: slots.endTime,
			kind: slots.kind,
		});
	// 更新できなかったときの理由を調べる。UPDATE で外れたときは枠が変わっていないため、今の枠で判定できる
	const findSlot = db
		.select({ isNotStarted: sql<boolean>`${isNotStarted(now)}` })
		.from(slots)
		.innerJoin(seminarDays, eq(seminarDays.id, slots.seminarDayId))
		.where(eq(slots.id, slotId));

	// 枠の更新と予約の削除は batch で送り、両方成功するか両方失敗するかのどちらかにする（設計メモ リスク1）。
	// 開始時刻が同じ日のほかの枠とぶつかると UNIQUE 違反で batch 全体が取り消され、予約も消えない
	let updated: Awaited<typeof updateSlotRow>;
	let deletedCount = 0;
	let found: Awaited<typeof findSlot>;
	// 予約を消すのは、種類を presentation から presentation 以外に変えるときだけ。時刻だけの変更や、presentation 以外どうしの変更では、
	// 予約の DELETE を送らない（時刻だけの変更では予約を消さないことを、形でも分かるように）。
	// UPDATE は「今の種類が previous と同じ」を条件にしているため、更新できたときの元の種類は previous.kind で決まる
	const isRemovingPresentation =
		previous.kind === "presentation" && input.kind !== "presentation";
	try {
		if (!isRemovingPresentation) {
			[updated, found] = await db.batch([updateSlotRow, findSlot]);
		} else {
			let deleted: { id: string }[];
			[, deleted, updated, found] = await db.batch([
				// 先に枠の行をロックする。同時に来た予約の INSERT（services/reservation.ts の FOR SHARE）は、
				// - ロックより先なら：ロックがその確定を待つため、次の DELETE（新しい文なので確定した予約が見える）で消える
				// - ロックより後なら：この batch の終わりを待ってから、変更後の種類で予約できるかを確かめ直す（presentation 以外なので入らない）
				// ロックせずに DELETE → UPDATE の順にすると、2つの文の間に入った予約が presentation 以外の枠に残る。
				// UPDATE → DELETE の順にすると、DELETE の時点では UPDATE が効いたかを条件で確かめられない（今の値は変更後の値になっている）。
				// UPDATE の結果を使う1文（データ変更 CTE）にしないのは、1つの文の中では文の開始時点のデータしか見えず、
				// UPDATE が待った予約の INSERT の確定後も、同じ文の DELETE からその予約が見えないため
				db
					.select({ id: slots.id })
					.from(slots)
					.where(isEditableSlot)
					.for("update"),
				db
					.delete(reservations)
					.where(
						inArray(
							reservations.slotId,
							db.select({ id: slots.id }).from(slots).where(isEditableSlot),
						),
					)
					.returning({ id: reservations.id }),
				updateSlotRow,
				findSlot,
			]);
			deletedCount = deleted.length;
		}
	} catch (error) {
		if (isUniqueViolation(error, SLOTS_START_TIME_UNIQUE)) {
			return { ok: false, reason: "SLOT_START_TIME_TAKEN" };
		}
		throw error;
	}

	const slot = updated[0];
	if (slot) {
		return { ok: true, slot, deletedReservationCount: deletedCount };
	}
	const current = found[0];
	if (!current) {
		return { ok: false, reason: "SLOT_NOT_FOUND" };
	}
	// 開始済みなら、取り直しても変えられないため、previous が違っていても SLOT_STARTED を返す
	return {
		ok: false,
		reason: current.isNotStarted ? "SLOT_CHANGED" : "SLOT_STARTED",
	};
}
