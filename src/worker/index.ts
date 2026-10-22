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
