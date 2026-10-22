import {
	boolean,
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("userRole", ["student", "teacher", "admin"]);
export const grade = pgEnum("grade", [
	"B1",
	"B2",
	"B3",
	"B4",
	"M1",
	"M2",
	"MIDS_B1",
	"MIDS_B2",
	"MIDS_B3",
	"MIDS_B4",
]);

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
