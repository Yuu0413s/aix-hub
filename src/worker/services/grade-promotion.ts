import {
	and,
	asc,
	eq,
	exists,
	inArray,
	isNotNull,
	lt,
	not,
	notExists,
	notInArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { tokyoDate } from "../../shared/date";
import {
	GRADE_PROMOTIONS,
	GRADES,
	type Grade,
	type GradePromotion,
	type GradePromotionPath,
} from "../../shared/grade";
import { RESERVER_ROLES } from "../../shared/user-role";
import type { Db } from "../db/client";
import { createId } from "../db/id";
import {
	GRADE_PROMOTIONS_ACADEMIC_YEAR_UNIQUE,
	gradePromotions,
	reservations,
	users,
} from "../db/schema";
import { isUniqueViolation } from "../db/unique-violation";
import { isReservationUpcoming } from "./reservation";

const CHOICE_GRADES = GRADES.filter(
	(grade) => GRADE_PROMOTIONS[grade].kind === "choice",
);
const AUTOMATIC_GRADES = GRADES.filter(
	(grade) => GRADE_PROMOTIONS[grade].kind === "automatic",
);

// 学年更新の年度と、実行できる期間。年度は日本時間の暦年で数え（2027年4月の更新なら 2027）、実行できるのは4月の間だけ。
// 4月以外を止めるのは、学年が正しい時期に実行すると全員が1つ上がってしまい、画面から元に戻せないため
function academicYearOf(now: Date): number {
	return Number(tokyoDate(now).slice(0, 4));
}

function isGradePromotionOpen(now: Date): boolean {
	return tokyoDate(now).slice(5, 7) === "04";
}

// 更新の対象者。在籍中で学年のある、予約できる役割の人（学生と、学年のある admin）。teacher と学年の無い人は対象にしない。
// 否定（teacher でない）で書かないのは、役割が増えたときに黙って対象に入らないようにするため。
// その年度の4月1日（日本時間）以降に作られたアカウントも対象にしない。登録のときに4月時点の正しい学年を選んでいるため、更新すると1つ上がりすぎる
function isPromotionTarget(academicYear: number) {
	return and(
		eq(users.isEnrolled, true),
		isNotNull(users.grade),
		inArray(users.role, RESERVER_ROLES),
		lt(users.createdAt, new Date(`${academicYear}-04-01T00:00:00+09:00`)),
	);
}

function isChoiceTarget(academicYear: number) {
	return and(
		isPromotionTarget(academicYear),
		inArray(users.grade, CHOICE_GRADES),
	);
}

export type GradePromotionTarget = {
	id: string;
	displayName: string | null;
	email: string;
	grade: Grade;
	promotion: GradePromotion;
};

export type GradePromotionStatus = {
	academicYear: number;
	isOpen: boolean;
	executed: { executedAt: Date; executedByDisplayName: string | null } | null;
	targets: GradePromotionTarget[];
};

// 管理画面に出す、今の年度の実行状況と対象者。対象者の条件を画面に書くと API の判定とずれるため、ここで返す
export async function getGradePromotionStatus(
	db: Db,
	now: Date,
): Promise<GradePromotionStatus> {
	const academicYear = academicYearOf(now);
	const [executedRows, targetRows] = await db.batch([
		db
			.select({
				executedAt: gradePromotions.executedAt,
				executedByDisplayName: users.displayName,
			})
			.from(gradePromotions)
			.innerJoin(users, eq(users.id, gradePromotions.executedById))
			.where(eq(gradePromotions.academicYear, academicYear)),
		db
			.select({
				id: users.id,
				displayName: users.displayName,
				email: users.email,
				grade: users.grade,
			})
			.from(users)
			.where(isPromotionTarget(academicYear))
			// 学年は enum の定義順。未登録の人を後ろにする nulls last は、services/user.ts の listUsers と同じく明示する
			.orderBy(
				asc(users.grade),
				sql`${users.displayName} asc nulls last`,
				asc(users.id),
			),
	]);

	return {
		academicYear,
		isOpen: isGradePromotionOpen(now),
		executed: executedRows[0] ?? null,
		// 対象者は学年を必ず持つ（isPromotionTarget）が、SELECT の型には表れないため確かめる
		targets: targetRows.flatMap(({ grade, ...target }) =>
			grade === null
				? []
				: [{ ...target, grade, promotion: GRADE_PROMOTIONS[grade] }],
		),
	};
}

export type ExecuteGradePromotionResult =
	| {
			ok: true;
			academicYear: number;
			// 更新した人数。卒業にした人と「M2 のまま」の人も含む
			updatedCount: number;
			graduatedCount: number;
			// 卒業にして消した予約の件数
			deletedReservationCount: number;
	  }
	| {
			ok: false;
			reason: "NOT_OPEN" | "ALREADY_EXECUTED" | "PATH_REQUIRED" | "LAST_ADMIN";
	  };

// 学年更新を実行する。学年の更新と記録は両方成功するか両方失敗するかのどちらかにするため、batch で送る（設計メモ リスク1）。
// batch は途中の結果で分岐できないため、次の順に送り、条件を SQL に書く。
// 1. admin 全員と対象者の行をロックする
// 2. 実行済みの記録を読む（理由を返すため）
// 3. 進路の抜けがなく、在籍中の admin が残るときだけ、記録を INSERT する。条件を通った同じ年度の2回目は UNIQUE 違反で batch 全体が取り消される
// 4. 3 で記録が入ったときだけ、卒業する人の開始前の予約を消す
// 5. 同じ条件で、学年と isEnrolled を更新する
// 6. 進路が抜けている人を読む（3 で入らなかった理由を返すため）
export async function executeGradePromotion(
	db: Db,
	{
		actorId,
		paths,
		now,
	}: {
		actorId: string;
		paths: { userId: string; path: GradePromotionPath }[];
		now: Date;
	},
): Promise<ExecuteGradePromotionResult> {
	if (!isGradePromotionOpen(now)) {
		return { ok: false, reason: "NOT_OPEN" };
	}
	const academicYear = academicYearOf(now);
	const isTarget = isPromotionTarget(academicYear);
	const isChoice = isChoiceTarget(academicYear);

	const pathUserIds = paths.map(({ userId }) => userId);
	const graduateIds = paths
		.filter(({ path }) => path === "graduate")
		.map(({ userId }) => userId);
	const continueIds = paths
		.filter(({ path }) => path === "continue")
		.map(({ userId }) => userId);

	// paths に対象外の人や自動で上がる人が入っていても無視する（画面を開いたあとに teacher へ変わった人などで、全体を止めないため）。
	// そのため、卒業するかは paths だけで決めず、進路を選ぶ対象者かも確かめる
	const isGraduating: SQL = sql`(${isChoice} and ${inArray(users.id, graduateIds)})`;
	const isPathMissing = and(isChoice, notInArray(users.id, pathUserIds));

	// 卒業で在籍中の admin が0人になるか。役割の変更（services/user.ts の updateUserRole）と同じく、卒業生の admin は数えない
	// （大学のアカウントが消えるとログインできず、誰も管理画面に入れなくなるため）。
	// 誰も卒業しないときは止めない（止めると、admin が卒業生だけのときに実行できなくなる）
	const isAdmin = eq(users.role, "admin");
	const findGraduatingAdmin = db
		.select({ id: users.id })
		.from(users)
		.where(and(isAdmin, isGraduating));
	const findRemainingAdmin = db
		.select({ id: users.id })
		.from(users)
		.where(and(isAdmin, eq(users.isEnrolled, true), not(isGraduating)));

	// 3 で記録が入ったか。年度で探さず、この実行の id で探す。年度で探すと、同じ年度の2回目で 3 が0行になったとき
	// （進路の抜けや最後の admin の条件に当たり、UNIQUE 違反にならないとき）に1回目の記録に当たり、更新が走ってしまう
	const promotionId = createId();
	const isPromotionInserted = exists(
		db
			.select({ id: gradePromotions.id })
			.from(gradePromotions)
			.where(eq(gradePromotions.id, promotionId)),
	);

	// CASE は1文の中で元の学年を見て決める。別々の文に分けると、B1 → B2 のあとに B2 → B3 が当たり、同じ人が2つ上がるため
	const gradeCases = GRADES.map((grade) => {
		const promotion = GRADE_PROMOTIONS[grade];
		return promotion.kind === "automatic"
			? sql`when ${eq(users.grade, grade)} then ${promotion.next}::"grade"`
			: sql`when (${eq(users.grade, grade)} and ${inArray(users.id, continueIds)}) then ${promotion.continueGrade}::"grade"`;
	});

	try {
		const [, executed, inserted, deleted, updated, pathMissing] =
			await db.batch([
				// ロックが無いと、2回同時に送ったときや、同時の役割の変更と互いに「もう1人 admin がいる」と読んだときに、
				// 確定前の値で判定してしまう。役割の変更（services/user.ts）と同じく id の順に取り、互いに待ち続けることを防ぐ
				db
					.select({ id: users.id })
					.from(users)
					.where(or(isAdmin, isTarget))
					.orderBy(asc(users.id))
					.for("update"),
				db
					.select({ id: gradePromotions.id })
					.from(gradePromotions)
					.where(eq(gradePromotions.academicYear, academicYear)),
				db
					.insert(gradePromotions)
					// select のビルダーで渡し、Drizzle に「キーの名前と順番が gradePromotions の列と同じか」を確かめさせる
					// （services/reservation.ts と同じ理由）。そのため、既定値のある列も省略せずに選ぶ
					.select((qb) =>
						qb
							.select({
								id: sql<string>`${promotionId}`.as("id"),
								academicYear: sql<number>`${academicYear}::smallint`.as(
									"academicYear",
								),
								executedById: sql<string>`${actorId}`.as("executedById"),
								executedAt: sql<Date>`now()`.as("executedAt"),
							})
							.from(users)
							.where(
								and(
									eq(users.id, actorId),
									notExists(
										db
											.select({ id: users.id })
											.from(users)
											.where(isPathMissing),
									),
									or(
										notExists(findGraduatingAdmin),
										exists(findRemainingAdmin),
									),
								),
							),
					)
					.returning({ id: gradePromotions.id }),
				db
					.delete(reservations)
					.where(
						and(
							inArray(
								reservations.userId,
								db.select({ id: users.id }).from(users).where(isGraduating),
							),
							isReservationUpcoming(now),
							isPromotionInserted,
						),
					)
					.returning({ id: reservations.id }),
				db
					.update(users)
					.set({
						grade: sql`case ${sql.join(gradeCases, sql` `)} else ${users.grade} end`,
						// SET の式はどちらも更新前の行を見るため、学年の更新と順番を気にしなくてよい
						isEnrolled: sql`not ${isGraduating}`,
						updatedAt: new Date(),
					})
					.where(
						and(
							isTarget,
							or(
								inArray(users.grade, AUTOMATIC_GRADES),
								and(isChoice, inArray(users.id, pathUserIds)),
							),
							isPromotionInserted,
						),
					)
					.returning({ isEnrolled: users.isEnrolled }),
				db.select({ id: users.id }).from(users).where(isPathMissing).limit(1),
			]);

		if (inserted.length > 0) {
			return {
				ok: true,
				academicYear,
				updatedCount: updated.length,
				graduatedCount: updated.filter(({ isEnrolled }) => !isEnrolled).length,
				deletedReservationCount: deleted.length,
			};
		}
		// 実行済みを先に確かめる。1回目のあとは元の B3 が B4 になっていて進路の抜けが出るため、
		// 後にすると、2回目の実行に「進路を選んでください」と返してしまう
		if (executed.length > 0) {
			return { ok: false, reason: "ALREADY_EXECUTED" };
		}
		return {
			ok: false,
			reason: pathMissing.length > 0 ? "PATH_REQUIRED" : "LAST_ADMIN",
		};
	} catch (error) {
		if (isUniqueViolation(error, GRADE_PROMOTIONS_ACADEMIC_YEAR_UNIQUE)) {
			return { ok: false, reason: "ALREADY_EXECUTED" };
		}
		throw error;
	}
}
