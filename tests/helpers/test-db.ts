import { migrate } from "drizzle-orm/neon-http/migrator";
import { createDb } from "../../src/worker/db/client";

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

let migrated: Promise<void> | undefined;

// スキーマの変更後に適用し忘れたまま古い DB でテストしないよう、テストの開始時にマイグレーションを適用する。
// 複数のテストファイルから呼ばれても、適用は1回だけにする
export async function setUpTestDb() {
	const db = createDb(getTestDatabaseUrl());
	migrated ??= migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	await migrated;
	return db;
}
