import {
	and,
	asc,
	desc,
	eq,
	exists,
	isNotNull,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Grade } from "../../shared/grade";
import type { UserRole } from "../../shared/user-role";
import type { Db } from "../db/client";
import { reservations, users } from "../db/schema";
import { isReservationCancelableBy } from "./reservation";

const adminUserColumns = {
	id: users.id,
	displayName: users.displayName,
	email: users.email,
	grade: users.grade,
	role: users.role,
	isEnrolled: users.isEnrolled,
};

export type AdminUser = {
	id: string;
	displayName: string | null;
	email: string;
	grade: typeof users.$inferSelect.grade;
	role: UserRole;
	isEnrolled: boolean;
};

// 管理画面の利用者一覧。役割を変える相手を探せるよう、卒業生とプロフィール未登録の人も載せる
export function listUsers(db: Db): Promise<AdminUser[]> {
	return (
		db
			.select(adminUserColumns)
			.from(users)
			// 学年は enum の定義順。学年の無い人を後ろにする nulls last は、routes/stats.ts と同じく明示する
			.orderBy(
				desc(users.isEnrolled),
				sql`${users.grade} asc nulls last`,
				sql`${users.displayName} asc nulls last`,
				asc(users.id),
			)
	);
}

export type UpdateUserRoleResult =
	| {
			ok: true;
			user: AdminUser;
			// teacher にして消した予約の件数
			deletedReservationCount: number;
	  }
	| { ok: false; reason: "USER_NOT_FOUND" | "LAST_ADMIN" | "GRADE_REQUIRED" };

// 管理者が役割を変える。変更後に在籍中の admin が1人も残らない変更はしない（設計メモ リスク8）。
// 卒業生を数えないのは、大学のアカウントが消えるとログインできず、誰も管理画面に入れなくなるため。
// teacher にするときは、学年を null にし、開始前の予約を消す（teacher は学年を持たず、予約もしないため。
// マイページに予約一覧が出ないため、残すと本人が気づかないまま枠が埋まり続ける）。
// 学生は学年を必ず持つため、学年の無い人を student にするときは grade が要る。学年のある人の学年は変えない
// （学年の編集はこの処理の役割ではなく、画面が古く、学年が空に見えていたときに上書きしないため）
export async function updateUserRole(
	db: Db,
	{
		userId,
		role,
		grade,
		now,
	}: { userId: string; role: UserRole; grade?: Grade; now: Date },
): Promise<UpdateUserRoleResult> {
	const otherAdmins = alias(users, "otherAdmins");
	const isGradeMissing = role === "student" && grade === undefined;
	const isChangeableUser = and(
		eq(users.id, userId),
		isGradeMissing ? isNotNull(users.grade) : undefined,
		// admin のままなら人数は減らない。今の役割が admin でない人の変更にも人数の条件を掛けない
		// （掛けると、admin が卒業生だけのときに新しい admin を作れなくなる）
		role === "admin"
			? undefined
			: or(
					ne(users.role, "admin"),
					exists(
						db
							.select({ id: otherAdmins.id })
							.from(otherAdmins)
							.where(
								and(
									eq(otherAdmins.role, "admin"),
									eq(otherAdmins.isEnrolled, true),
									ne(otherAdmins.id, userId),
								),
							),
					),
				),
	);

	// admin 全員と対象者の行を先にロックする。ロックが無いと、2人が同時に互いを外したときに、
	// どちらも相手の変更が確定する前の値を読み（「もう1人いる」）、両方とも通って admin が0人になる。
	// ロックを待ったあとの次の文は、確定後の値を読むため、後の人は最新の人数で判定される。
	// 全員のロックを同じ順番で取り、互いに待ち続ける（デッドロック）ことを防ぐため、id の順に並べる。
	// 対象者の行もロックするのは、同時に来た予約の INSERT（services/reservation.ts の FOR SHARE）と順番を決めるため
	const lockRows = db
		.select({ id: users.id })
		.from(users)
		.where(or(eq(users.role, "admin"), eq(users.id, userId)))
		.orderBy(asc(users.id))
		.for("update");
	const updateUserRow = db
		.update(users)
		.set({
			role,
			updatedAt: new Date(),
			...(role === "teacher" ? { grade: null } : {}),
			...(grade !== undefined
				? { grade: sql`coalesce(${users.grade}, ${grade}::"grade")` }
				: {}),
		})
		.where(isChangeableUser)
		.returning(adminUserColumns);
	// 更新できなかったときの理由を調べる
	const findUser = db
		.select({ grade: users.grade })
		.from(users)
		.where(eq(users.id, userId));

	let updated: Awaited<typeof updateUserRow>;
	let found: Awaited<typeof findUser>;
	let deletedCount = 0;
	// 役割の更新と予約の削除は batch で送り、両方成功するか両方失敗するかのどちらかにする（設計メモ リスク1）
	if (role === "teacher") {
		let deleted: { id: string }[];
		[, deleted, updated, found] = await db.batch([
			lockRows,
			db
				.delete(reservations)
				.where(
					and(
						// 消すのは本人が取り消せる予約（開始前で「済」でないもの）。発表した記録と発表回数は残す
						isReservationCancelableBy({ id: userId, role }, now),
						exists(
							db.select({ id: users.id }).from(users).where(isChangeableUser),
						),
					),
				)
				.returning({ id: reservations.id }),
			updateUserRow,
			findUser,
		]);
		deletedCount = deleted.length;
	} else {
		[, updated, found] = await db.batch([lockRows, updateUserRow, findUser]);
	}

	const user = updated[0];
	if (user) {
		return { ok: true, user, deletedReservationCount: deletedCount };
	}
	const current = found[0];
	if (!current) {
		return { ok: false, reason: "USER_NOT_FOUND" };
	}
	return {
		ok: false,
		reason:
			isGradeMissing && current.grade === null
				? "GRADE_REQUIRED"
				: "LAST_ADMIN",
	};
}
