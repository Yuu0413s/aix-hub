import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "./db/client";
import type { Bindings } from "./env";
import { handleError } from "./error-handler";

const app = new Hono<{ Bindings: Bindings }>().basePath("/api");

app.onError(handleError);

const routes = app
	.get("/health", (c) => c.json({ status: "ok" as const }))
	.get("/health/db", async (c) => {
		const db = createDb(c.env.DATABASE_URL);
		await db.execute(sql`select 1`);
		return c.json({ status: "ok" as const });
	});

// フロントの Hono RPC クライアントが API の型を参照するために export する
export type AppType = typeof routes;

export default app;
