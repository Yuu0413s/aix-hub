import { relations } from "drizzle-orm";
import {
	boolean,
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
import { SLOT_KINDS } from "../../shared/schedule-template";

export const userRole = pgEnum("userRole", ["student", "teacher", "admin"]);
// 値の一覧は画面と共通にするため shared/grade.ts に置いている
export const grade = pgEnum("grade", GRADES);
export const seminarDayStatus = pgEnum("seminarDayStatus", ["open", "closed"]);
// 値の一覧は画面と共通にするため shared/schedule-template.ts に置いている
export const slotKind = pgEnum("slotKind", SLOT_KINDS);

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
	(table) => [unique().on(table.seminarDayId, table.startTime)],
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
