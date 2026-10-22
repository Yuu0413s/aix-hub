# 1on2-reserve

## 概要

ゼミの1on1予約システム。スプレッドシートの日付タブ運用を置き換え、カレンダーから日付を選んで枠を予約する。
設計は `docs/design/reservation-system.md` を参照。

## 技術スタック

- ランタイム / パッケージ管理: Bun
- フロント: Vite + React + React Router + TanStack Query + Tailwind CSS
- API: Hono（フロントと同一の Cloudflare Worker で配信。`/api/*` のみ Worker、それ以外は SPA）
- DB: Neon PostgreSQL + Drizzle ORM
- 認証: better-auth（Google OAuth、大学ドメイン制限）
- デプロイ: Cloudflare Workers（`@cloudflare/vite-plugin`）
- テスト: bun test（`tests/` 配下）。DB を使うテストはテスト用の Neon ブランチに繋ぐ
- Lint / Format: Biome

## ディレクトリ構成

```
1on2-reserve/
├── src/
│   ├── worker/          Hono（API）。env.ts に Bindings 型
│   │   └── db/          Drizzle スキーマ・接続
│   ├── client/          React（SPA）
│   │   ├── routes/
│   │   └── lib/api.ts   Hono RPC クライアント
│   └── shared/          フロント・API 共通
├── tests/               src/ と同じ階層構造
├── drizzle/             マイグレーション（生成物）
└── docs/
    ├── design/          設計メモ
    └── conventions/     プロジェクト固有の規約
```

## コマンド

| コマンド | 用途 |
|---|---|
| `bun run dev` | 開発サーバー起動（API と SPA を同時に配信） |
| `bun run test` | テスト実行（`.dev.vars.test` の `TEST_DATABASE_URL` を読む） |
| `bun run typecheck` | 型チェック（`tsc -b`） |
| `bun run lint` / `bun run lint:fix` | Biome による Lint・整形チェック / 自動修正 |
| `bun run build` | 本番ビルド |
| `bun run deploy` | ビルドして Workers にデプロイ |
| `bun run cf-typegen` | `wrangler.jsonc` 変更後に Workers の型を再生成 |
| `bun run db:generate` / `db:migrate` | マイグレーション生成 / 適用（`.dev.vars` を読む） |

## このプロジェクト固有のルール

- 規約は `docs/conventions/` を最優先で参照する
- 秘密情報は `.dev.vars` に置く（`.env` は使わない）。`.dev.vars.example` のみ git 管理する
- Worker の環境変数の型は `src/worker/env.ts` の `Bindings` に追加する。
  クライアントが `AppType` 経由で Worker のコードを型参照するため、グローバルな `Env`（`worker-configuration.d.ts`）には依存させない
- tsconfig はブラウザ用（app）/ Worker 用（worker）/ 設定ファイル用（node）/ テスト用（test）に分かれている。DOM と Workers のグローバル型が衝突するため
- wrangler コマンドを非対話で実行するときは `WRANGLER_SEND_METRICS=false` を付ける（メトリクス確認プロンプトで止まることがある）
