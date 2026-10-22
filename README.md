# 1on2-reserve

ゼミの1on1予約システム。カレンダーから日付を選び、空いている枠を予約する。

- 対象デバイス: スマホ / PC
- デプロイ先: Cloudflare Workers
- 設計: [docs/design/reservation-system.md](docs/design/reservation-system.md)

## セットアップ

### 前提

- [Bun](https://bun.sh/) 1.3 以上

### 手順

```bash
git clone <このリポジトリ>
cd 1on2-reserve
bun install
cp .dev.vars.example .dev.vars   # 各キーを書き換える（下記）
bun run db:migrate               # 開発用 DB にテーブルを作る
bun run dev
```

`.dev.vars` に書くもの:

| キー | 値 |
|---|---|
| `DATABASE_URL` | 開発用 Neon ブランチの接続文字列 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud Console の OAuth クライアント。リダイレクト URI に `http://localhost:5173/api/auth/callback/google` を登録する |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` で生成した値 |
| `BETTER_AUTH_URL` | `http://localhost:5173` |

起動後、表示された URL（既定は http://localhost:5173 ）を開くとログイン画面に移動する。大学の Google アカウントでログインし、「API: ok」と表示されれば成功。

### テスト用 DB

DB を使うテストは、テスト用の Neon ブランチに繋ぐ。`.dev.vars.test` に `TEST_DATABASE_URL=<テスト用ブランチの接続文字列>` を書き、`bun run test` で実行する（マイグレーションはテストの開始時に自動で適用される）。

## コマンド

| コマンド | 用途 |
|---|---|
| `bun run dev` | 開発サーバー起動（API と画面を同時に配信） |
| `bun run test` | テスト実行（`.dev.vars.test` の `TEST_DATABASE_URL` を読む） |
| `bun run typecheck` | 型チェック |
| `bun run lint` | Lint・整形チェック（`bun run lint:fix` で自動修正） |
| `bun run build` | 本番ビルド |
| `bun run deploy` | ビルドして Cloudflare Workers にデプロイ |
| `bun run cf-typegen` | `wrangler.jsonc` 変更後に Workers の型を再生成 |
| `bun run db:generate` | スキーマからマイグレーションを生成 |
| `bun run db:migrate` | マイグレーションを適用 |

## CI

GitHub Actions（`.github/workflows/ci.yml`）で push / PR 時に Lint・型チェック・テスト・ビルドを実行する。テストはリポジトリの Secrets の `TEST_DATABASE_URL`（テスト用 Neon ブランチ）を使う。
