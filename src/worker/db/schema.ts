import { relations, sql } from "drizzle-orm";
import {
	boolean,
	check,
	date,
	index,
	pgEnum,
	pgTable,
	smallint,
	text,
	time,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import { GRADES } from "../../shared/grade";
import { PARTICIPATION_STATUSES } from "../../shared/participation-status";
import { SLOT_KINDS } from "../../shared/schedule-template";
import { USER_ROLES } from "../../shared/user-role";

// 値の一覧は画面と共通にするため shared/user-role.ts に置いている
export const userRole = pgEnum("userRole", USER_ROLES);
// 値の一覧は画面と共通にするため shared/grade.ts に置いている
export const grade = pgEnum("grade", GRADES);
export const seminarDayStatus = pgEnum("seminarDayStatus", ["open", "closed"]);
// 値の一覧は画面と共通にするため shared/schedule-template.ts に置いている
export const slotKind = pgEnum("slotKind", SLOT_KINDS);
export const reservationStatus = pgEnum("reservationStatus", [
	"reserved",
	"done",
]);
// 値の一覧は画面と共通にするため shared/participation-status.ts に置いている。
// 参加者一覧の並び順に宣言の順を使うため、値の順を変えない
export const participationStatus = pgEnum(
	"participationStatus",
	PARTICIPATION_STATUSES,
);

// users / sessions / accounts / verifications は better-auth が読み書きするテーブル。
// 列と外部キーは better-auth の標準の定義に合わせる。そのため sessions / accounts の外部キーは
// db.md の「すべて RESTRICT」の例外で、better-auth の標準どおり CASCADE にする（db.md「削除時の挙動」）。
// ただし日時は db.md に合わせて timestamp with time zone にする
const timestamptz = () => timestamp({ withTimezone: true });

export const users = pgTable("users", {
	id: text().primaryKey(),
	name: text().notNull(),
	email: text().notNull().unique(),
	emailVerified: boolean().notNull().default(false),
	image: text(),
	createdAt: timestamptz().notNull().defaultNow(),
	updatedAt: timestamptz().notNull().defaultNow(),
	// ここから下はアプリで追加した列
	role: userRole().notNull().default("student"),
	// 先生とプロフィール登録前は NULL
	grade: grade(),
	// プロフィール登録前は NULL
	displayName: text(),
	isEnrolled: boolean().notNull().default(true),
});

export const sessions = pgTable(
	"sessions",
	{
		id: text().primaryKey(),
		expiresAt: timestamptz().notNull(),
		token: text().notNull().unique(),
		createdAt: timestamptz().notNull().defaultNow(),
		updatedAt: timestamptz().notNull().defaultNow(),
		ipAddress: text(),
		userAgent: text(),
		userId: text()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
	},
	(table) => [index("sessions_userId_idx").on(table.userId)],
);

export const accounts = pgTable(
	"accounts",
	{
		id: text().primaryKey(),
		accountId: text().notNull(),
		providerId: text().notNull(),
		userId: text()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		accessToken: text(),
		refreshToken: text(),
		idToken: text(),
		accessTokenExpiresAt: timestamptz(),
		refreshTokenExpiresAt: timestamptz(),
		scope: text(),
		password: text(),
		createdAt: timestamptz().notNull().defaultNow(),
		updatedAt: timestamptz().notNull().defaultNow(),
	},
	(table) => [index("accounts_userId_idx").on(table.userId)],
);

export const verifications = pgTable(
	"verifications",
	{
		id: text().primaryKey(),
		identifier: text().notNull(),
		value: text().notNull(),
		expiresAt: timestamptz().notNull(),
		createdAt: timestamptz().notNull().defaultNow(),
		updatedAt: timestamptz().notNull().defaultNow(),
	},
	(table) => [index("verifications_identifier_idx").on(table.identifier)],
);

// 開催日。休止日も status = closed の行で表す
export const seminarDays = pgTable("seminarDays", {
	id: text().primaryKey(),
	// Cron はこの UNIQUE を使い、同じ日付を二重に作らない（services/seminar-day.ts）
	date: date().notNull().unique(),
	status: seminarDayStatus().notNull().default("open"),
	closedReason: text(),
});

// 同じ日に同じ開始時刻の枠を2つ作らせない UNIQUE 制約の名前。
// 枠の編集（services/slot.ts）が、この制約の違反を「開始時刻がぶつかった」と見分けるために名前を使う。
// Drizzle が付ける既定の名前と同じだが、既定に任せず明示する（既定の付け方が変わっても見分け方がずれないように）
export const SLOTS_START_TIME_UNIQUE = "slots_seminarDayId_startTime_unique";

// 枠（スプシの1行に相当）。時間割（shared/schedule-template.ts）から作り、管理者が日ごとに編集できる。
// 列の型を変えるときは、services/seminar-day.ts の jsonb_to_recordset の型も合わせて直す
export const slots = pgTable(
	"slots",
	{
		id: text().primaryKey(),
		seminarDayId: text()
			.notNull()
			.references(() => seminarDays.id, { onDelete: "restrict" }),
		period: smallint().notNull(),
		startTime: time().notNull(),
		endTime: time().notNull(),
		kind: slotKind().notNull(),
	},
	// 開始 < 終了は、API の入力の検証（shared/schemas.ts の slotInputSchema）を通らない書き込みでも守るため CHECK でも確かめる
	(table) => [
		unique(SLOTS_START_TIME_UNIQUE).on(table.seminarDayId, table.startTime),
		check(
			"slots_startTime_endTime_check",
			sql`${table.startTime} < ${table.endTime}`,
		),
	],
);

// 予約。実施済み（done）も残し、発表回数は done の件数で数える。取消は行を物理削除する
export const reservations = pgTable("reservations", {
	id: text().primaryKey(),
	// 二重予約は、確認してから入れるのではなくこの UNIQUE で防ぐ（確認と登録の間に別の予約が割り込めないように）
	slotId: text()
		.notNull()
		.unique()
		.references(() => slots.id, { onDelete: "restrict" }),
	userId: text()
		.notNull()
		.references(() => users.id, { onDelete: "restrict" }),
	status: reservationStatus().notNull().default("reserved"),
	createdAt: timestamptz().notNull().defaultNow(),
	// DB のトリガーは使わず、Drizzle で更新するときに今の時刻を入れる
	updatedAt: timestamptz()
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date()),
});

// 全体連絡。開催日ごとに書き、表示期間中はトップに出す（設計メモ「全体連絡」）
export const announcements = pgTable(
	"announcements",
	{
		id: text().primaryKey(),
		seminarDayId: text()
			.notNull()
			.references(() => seminarDays.id, { onDelete: "restrict" }),
		authorId: text()
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		body: text().notNull(),
		// 空なら作成日（日本時間）から表示する
		displayFrom: date(),
		// 空なら開催日まで表示する
		displayUntil: date(),
		// 表示を始める日の判断に使うため、記録するだけの時刻と違い、API の現在時刻（now）を入れる（testing.md「現在時刻」）
		createdAt: timestamptz().notNull().defaultNow(),
		updatedAt: timestamptz()
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	// API の入力の検証（shared/schemas.ts）を通らない書き込みでも、期間が逆になった行を残さないため。
	// 片方が NULL のときは比較の結果も NULL になり、CHECK を通る
	(table) => [
		check(
			"announcements_displayFrom_displayUntil_check",
			sql`${table.displayFrom} <= ${table.displayUntil}`,
		),
	],
);

// 同じ年度に学年更新を2回させない UNIQUE 制約の名前。
// 学年更新（services/grade-promotion.ts）が、この制約の違反を「実行済み」と見分けるために名前を使う（SLOTS_START_TIME_UNIQUE と同じ理由で明示する）
export const GRADE_PROMOTIONS_ACADEMIC_YEAR_UNIQUE =
	"gradePromotions_academicYear_unique";

// 学年更新の記録。2回実行すると全員の学年が2つ上がるため、この UNIQUE で防ぐ
export const gradePromotions = pgTable("gradePromotions", {
	id: text().primaryKey(),
	// 更新後の年度（2027年4月の更新なら 2027）
	academicYear: smallint()
		.notNull()
		.unique(GRADE_PROMOTIONS_ACADEMIC_YEAR_UNIQUE),
	executedById: text()
		.notNull()
		.references(() => users.id, { onDelete: "restrict" }),
	executedAt: timestamptz().notNull().defaultNow(),
});

// 学会シリーズ（親学会。DEIM、IEEE iCast など）。年ごとの開催は conferences に持つ（設計メモ db-conferences.md）
export const conferenceSeries = pgTable("conferenceSeries", {
	id: text().primaryKey(),
	// 制約の名前は、学会の登録（#18）で違反を見分けるときに使うため、既定に任せず明示する（SLOTS_START_TIME_UNIQUE と同じ理由）
	name: text().notNull().unique("conferenceSeries_name_unique"),
});

// 学会の開催1回（DEIM 2027 など）。締切・開催日は「日付」と「自由記述の補足」で持つ（日付が決まっていない学会もあるため）
export const conferences = pgTable(
	"conferences",
	{
		id: text().primaryKey(),
		seriesId: text()
			.notNull()
			.references(() => conferenceSeries.id, { onDelete: "restrict" }),
		title: text().notNull().unique("conferences_title_unique"),
		venue: text(),
		url: text(),
		// 代表の締切。受付中の判定と並べ替えに使う（services/conference.ts）
		submissionDeadline: date(),
		submissionNote: text(),
		startDate: date(),
		endDate: date(),
		scheduleNote: text(),
		description: text(),
		note: text(),
		createdAt: timestamptz().notNull().defaultNow(),
		// 画面に「最終更新」として表示する。$onUpdate は Drizzle で更新したときだけ効くため、
		// 手で UPDATE するときは "updatedAt" = now() も一緒に書く（設計メモ db-conferences.md「7. 手で insert するときの例」）
		updatedAt: timestamptz()
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	// API の入力の検証を通らない書き込み（手での insert など）でも、開催日が逆になった行を残さないため。
	// 片方が NULL のときは比較の結果も NULL になり、CHECK を通る
	(table) => [
		check(
			"conferences_startDate_endDate_check",
			sql`${table.startDate} <= ${table.endDate}`,
		),
	],
);

// 学会への参加（users と conferences の中間テーブル）。取消は行を物理削除する
export const conferenceParticipants = pgTable(
	"conferenceParticipants",
	{
		id: text().primaryKey(),
		conferenceId: text()
			.notNull()
			.references(() => conferences.id, { onDelete: "restrict" }),
		userId: text()
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		status: participationStatus().notNull(),
	},
	// 同じ人が同じ学会に2行持たない。参加の表明（#19）は、確認してから入れるのではなくこの UNIQUE で防ぐ
	(table) => [
		unique("conferenceParticipants_conferenceId_userId_unique").on(
			table.conferenceId,
			table.userId,
		),
	],
);

// better-auth の joins（auth.ts）が、セッションとユーザーなどを1回の問い合わせでまとめて取るために使う。
// DB の外部キーは上の references で作っており、relations はクエリの組み立てにだけ使う（マイグレーションには影響しない）
export const usersRelations = relations(users, ({ many }) => ({
	sessions: many(sessions),
	accounts: many(accounts),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
	user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
	user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));
