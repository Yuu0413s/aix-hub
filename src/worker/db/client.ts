import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// 接続方式は HTTP（neon-http）を採用する（Issue #1 で検証。設計メモ リスク1）。
// - db.transaction() は使えない（neon-http では必ず例外を投げる）
// - 複数の書き込みをまとめるときは db.batch([...]) を使う。途中で失敗すると全体が取り消される
// - batch では途中の結果を見て次の SQL を変えられない。それが必要になったら WebSocket（Pool）に切り替える
export function createDb(databaseUrl: string) {
	return drizzle(neon(databaseUrl), { schema });
}
