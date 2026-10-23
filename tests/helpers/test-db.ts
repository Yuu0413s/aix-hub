import { between, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/neon-http/migrator";
import { createDb, type Db } from "../../src/worker/db/client";
import { seminarDays, slots } from "../../src/worker/db/schema";

const MIGRATIONS_FOLDER = `${import.meta.dir}/../../drizzle`;

// 開発用 DB に書き込まないよう、テストは TEST_DATABASE_URL だけを読む（DATABASE_URL は見ない）
export function getTestDatabaseUrl(): string {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) {
		throw new Error(
			"TEST_DATABASE_URL が未設定です。.dev.vars.test を用意し、bun run test で実行してください",
		);
	}
	return url;
}

let migrationPromise: Promise<void> | undefined;

// スキーマの変更後に適用し忘れたまま古い DB でテストしないよう、テストの開始時にマイグレーションを適用する。
// 複数のテストファイルから呼ばれても、適用は1回だけにする
export async function setUpTestDb() {
	const db = createDb(getTestDatabaseUrl());
	migrationPromise ??= migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	await migrationPromise;
	return db;
}

// テスト用 DB は共有されているため、ほかのデータを消さないよう、range（両端を含む）の開催日だけを片付ける。
// 外部キーは RESTRICT のため、開催日を参照している行（枠）から先に消す。参照するテーブルが増えたらここに足す
export async function deleteSeminarDaysBetween(
	db: Db,
	range: readonly [string, string],
) {
	const days = db
		.select({ id: seminarDays.id })
		.from(seminarDays)
		.where(between(seminarDays.date, ...range));
	await db.delete(slots).where(inArray(slots.seminarDayId, days));
	await db.delete(seminarDays).where(between(seminarDays.date, ...range));
}
