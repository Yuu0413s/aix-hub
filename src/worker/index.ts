import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { createAuth } from "./auth";
import { runScheduled } from "./cron";
import { createDb } from "./db/client";
import type { Bindings } from "./env";
import { handleError } from "./error-handler";
import { announcementRoutes } from "./routes/announcements";
import { daysRoutes } from "./routes/days";
import { meRoutes } from "./routes/me";
import { reservationRoutes } from "./routes/reservations";

// テストから app.request で呼ぶため、default とは別に export する
export const app = new Hono<{ Bindings: Bindings }>().basePath("/api");

app.onError(handleError);

// フロントからは better-auth のクライアントで呼ぶため、Hono RPC の型（AppType）には含めない。
// Workers では環境変数がリクエストごとに c.env で渡されるため、better-auth もリクエストごとに作る
// パスワードの再設定は使わない。better-auth の disabledPaths は完全一致で比べるため、
// パスに値を含むこの入口だけは better-auth に渡す前に塞ぐ（auth.ts の DISABLED_PATHS）
app.get("/auth/reset-password/*", (c) => c.notFound());
app.on(["GET", "POST"], "/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

// 別のサイトのフォームから、ログイン中の人になりすまして書き込ませる攻撃（CSRF）を防ぐ。
// 本文の無い POST（予約）や text/plain の POST は、ほかのサイトのフォームからクッキー付きで送れてしまうため、
// 送り元が同じオリジン（Sec-Fetch-Site: same-origin、または Origin がこの API と同じ）でなければ 403 にする。
// hono/csrf は、本文の種類（content-type）が無い書き込みを text/plain とみなすため、本文の無い DELETE（取消）も確かめる。
// GET・HEAD・OPTIONS と、JSON の本文のリクエスト（フォームからは送れない）は確かめない（hono/csrf の既定）。
// /auth/* は better-auth が送り元を確かめるため、上で先に処理し、ここは通らない
app.use(csrf());

const routes = app
	.get("/health", (c) => c.json({ status: "ok" as const }))
	// Worker から Neon に届くかを確かめるため（Issue #1）。デプロイ後の確認にも使う
	.get("/health/db", async (c) => {
		const db = createDb(c.env.DATABASE_URL);
		await db.execute(sql`select 1`);
		return c.json({ status: "ok" as const });
	})
	.route("/me", meRoutes)
	.route("/days", daysRoutes)
	.route("/", reservationRoutes)
	.route("/announcements", announcementRoutes);

// フロントの Hono RPC クライアントが API の型を参照するために export する
export type AppType = typeof routes;

// 引数の型は Workers のグローバルな型（ScheduledController など）を使わず、使う部分だけを書く。
// クライアントが AppType 経由でこのファイルを参照するため（env.ts の Bindings と同じ理由）
export default {
	fetch: app.fetch,
	// 実行が遅れても同じ日付で処理するよう、実際に起動した時刻ではなく、起動する予定だった時刻を現在時刻にする
	scheduled: (controller: { scheduledTime: number }, env: Bindings) =>
		runScheduled(env, new Date(controller.scheduledTime)),
};
