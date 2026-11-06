import { between, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/neon-http/migrator";
import { createDb, type Db } from "../../src/worker/db/client";
import {
	announcements,
	reservations,
	seminarDays,
	slots,
} from "../../src/worker/db/schema";

const MIGRATIONS_FOLDER = `${import.meta.dir}/../../drizzle`;

// 開発用 DB に書き込まないよう、テストは TEST_DATABASE_URL と TEST_ISOLATED_DATABASE_URL だけを読む（DATABASE_URL は見ない）
export function getTestDatabaseUrl(): string {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) {
		throw new Error(
			"TEST_DATABASE_URL が未設定です。ローカルでは .dev.vars.test を用意して bun run test で実行し、CI ではリポジトリの Secrets に設定してください",
		);
	}
	return url;
}

// URL から接続先（ホスト・ポート・DB 名）だけを取り出す。認証情報とクエリパラメーターは接続先を変えないため比べない。
// 表記が違うだけの同じ接続先を見逃さないよう、Neon のドライバー（@neondatabase/serverless の URL の解析）と同じ規則で読む。
// http: に置き換えて解析すると、ホスト名が小文字になり、パーセントエンコードが復号される。
// DB 名は、Neon のプロキシと同じく、パスの最初の要素だけを復号して読む（/neondb/ も /neondb/ignored も neondb に繋がるため）。
// ドライバーの規則に加えて、DNS 上は同じ意味の末尾のドットを除き、Neon のプール接続の -pooler を除く（直接接続と同じブランチに繋がるため）。
// 解析のエラーには入力の値が含まれることがあり、認証情報をログに残さないよう、値を出さないエラーに置き換える
function toDatabaseTarget(url: string): string {
	try {
		const { protocol } = new URL(url);
		const { hostname, port, pathname } = new URL(
			`http:${url.slice(protocol.length)}`,
		);
		const endpoint = hostname.replace(/\.$/, "").replace("-pooler.", ".");
		const [, databaseName = ""] = pathname.split("/");
		return `${endpoint}:${port || "5432"}/${decodeURIComponent(databaseName)}`;
	} catch {
		throw new Error(
			"TEST_DATABASE_URL または TEST_ISOLATED_DATABASE_URL の URL の形が正しくありません",
		);
	}
}

// DB 全体の状態を前提にするテスト（admin の人数など）だけが使う、専用の Neon ブランチ。
// そうしたテストは DB 内の admin を全員外すため、共有のブランチを指していたら、ほかのテストを壊す前に止める。
// 表記が違うだけの同じブランチも止めるよう、文字列のままではなく接続先で比べる
export function getIsolatedTestDatabaseUrl(): string {
	const url = process.env.TEST_ISOLATED_DATABASE_URL;
	if (!url) {
		throw new Error(
			"TEST_ISOLATED_DATABASE_URL が未設定です。テスト専用の Neon ブランチを作り、ローカルでは .dev.vars.test に、CI ではリポジトリの Secrets に設定してください",
		);
	}
	const sharedUrl = process.env.TEST_DATABASE_URL;
	if (sharedUrl && toDatabaseTarget(url) === toDatabaseTarget(sharedUrl)) {
		throw new Error(
			"TEST_ISOLATED_DATABASE_URL が TEST_DATABASE_URL と同じ接続先です。共有のブランチとは別のブランチにしてください",
		);
	}
	return url;
}

const migrationPromises = new Map<string, Promise<void>>();

// スキーマの変更後に適用し忘れたまま古い DB でテストしないよう、テストの開始時にマイグレーションを適用する。
// 複数のテストファイルから呼ばれても、同じプロセスの中（bun run test でまとめて動かすとき）では、接続先ごとに適用は1回だけにする。
// CI はファイルごとに別のプロセスで並列に動かすため、共有のブランチには先に migrate-test-db.ts で適用しておく。ここでも migrate は呼ぶが、適用済みのため新たに適用するものは無い。
// 専用のブランチは1回の実行の中で1つのファイルしか使わないため、ぶつからず、先に適用しておかなくてよい。
// 実行どうし（ローカルと CI など）が同時に使うと admin を外し合うため、同時に動かさない（README）
export async function setUpTestDb(databaseUrl = getTestDatabaseUrl()) {
	const db = createDb(databaseUrl);
	let migrationPromise = migrationPromises.get(databaseUrl);
	if (!migrationPromise) {
		migrationPromise = migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
		migrationPromises.set(databaseUrl, migrationPromise);
	}
	await migrationPromise;
	return db;
}

// テスト用 DB は共有されているため、ほかのデータを消さないよう、range（両端を含む）の開催日だけを片付ける。
// CI はテストファイルを並列に動かすため、range はファイルごとにほかのファイルと重ならない年にする（docs/conventions/testing.md）。
// 外部キーは RESTRICT のため、参照している側（連絡 → 開催日、予約 → 枠）から先に消す。参照するテーブルが増えたらここに足す
export async function deleteSeminarDaysBetween(
	db: Db,
	range: readonly [string, string],
) {
	const days = db
		.select({ id: seminarDays.id })
		.from(seminarDays)
		.where(between(seminarDays.date, ...range));
	const daySlots = db
		.select({ id: slots.id })
		.from(slots)
		.where(inArray(slots.seminarDayId, days));
	await db
		.delete(announcements)
		.where(inArray(announcements.seminarDayId, days));
	await db.delete(reservations).where(inArray(reservations.slotId, daySlots));
	await db.delete(slots).where(inArray(slots.seminarDayId, days));
	await db.delete(seminarDays).where(between(seminarDays.date, ...range));
}
