import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { createAuth } from "./auth";
import { createDb } from "./db/client";
import type { Bindings } from "./env";
import { handleError } from "./error-handler";

const app = new Hono<{ Bindings: Bindings }>().basePath("/api");

app.onError(handleError);

// フロントからは better-auth のクライアントで呼ぶため、Hono RPC の型（AppType）には含めない。
// Workers では環境変数がリクエストごとに c.env で渡されるため、better-auth もリクエストごとに作る
// パスワードの再設定は使わない。better-auth の disabledPaths は完全一致で比べるため、
// パスに値を含むこの入口だけは better-auth に渡す前に塞ぐ（auth.ts の DISABLED_PATHS）
app.get("/auth/reset-password/*", (c) => c.notFound());
app.on(["GET", "POST"], "/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

const routes = app
	.get("/health", (c) => c.json({ status: "ok" as const }))
	// Worker から Neon に届くかを確かめるため（Issue #1）。デプロイ後の確認にも使う
	.get("/health/db", async (c) => {
		const db = createDb(c.env.DATABASE_URL);
		await db.execute(sql`select 1`);
		return c.json({ status: "ok" as const });
	});

// フロントの Hono RPC クライアントが API の型を参照するために export する
export type AppType = typeof routes;

export default app;
