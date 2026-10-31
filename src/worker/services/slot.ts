import { and, eq, exists, inArray, ne, sql } from "drizzle-orm";
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
			// 種類を presentation 以外にして消した予約の件数（0 か 1）
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

// 管理者が枠の種類・開始時刻・終了時刻を変える。種類を presentation 以外にしたら、その枠の予約を消す（時刻だけなら残す）。
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
	// 開始前か・今の値が previous と同じかを条件にした1文の UPDATE にする（確かめてから更新するまでの間に結果が変わらないように）。
	// 条件は更新する前の値で判定する。ほかの管理者が同じ枠を同時に更新していたら、その確定を待ってから、確定後の値で確かめ直す
	const updateSlotRow = db
		.update(slots)
		.set(input)
		.where(
			and(
				eq(slots.id, slotId),
				eq(slots.kind, previous.kind),
				eq(slots.startTime, previous.startTime),
				eq(slots.endTime, previous.endTime),
				exists(
					db
						.select({ id: seminarDays.id })
						.from(seminarDays)
						.where(
							and(eq(seminarDays.id, slots.seminarDayId), isNotStarted(now)),
						),
				),
			),
		)
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
	try {
		if (input.kind === "presentation") {
			// 発表の枠のままなら予約は消えないため、予約の DELETE は送らない（時刻だけの変更では予約を消さないことを、形でも分かるように）
			[updated, found] = await db.batch([updateSlotRow, findSlot]);
		} else {
			let deleted: { id: string }[];
			[updated, deleted, found] = await db.batch([
				updateSlotRow,
				// UPDATE を先に送る。UPDATE で枠の行にロックが掛かり、同時に来た予約の INSERT（services/reservation.ts の FOR SHARE）は
				// この batch の終わりを待ってから、変更後の種類で予約できるかを確かめ直す。
				// 逆に DELETE を先にすると、DELETE と UPDATE の間に入った予約が presentation 以外の枠に残る。
				// 「今の種類が presentation 以外」を条件にする。UPDATE が外れたときは種類が変わらないため、元が presentation なら消さない。
				// 元から presentation 以外の枠（ほかの管理者が先に変えた枠など）には、予約は presentation の枠にしか入らないため、消す予約が無い
				db
					.delete(reservations)
					.where(
						inArray(
							reservations.slotId,
							db
								.select({ id: slots.id })
								.from(slots)
								.where(
									and(eq(slots.id, slotId), ne(slots.kind, "presentation")),
								),
						),
					)
					.returning({ id: reservations.id }),
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
