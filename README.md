# 1on2-reserve

ゼミの1on1予約システム。カレンダーから日付を選び、空いている枠を予約する。

- 対象デバイス: スマホ / PC
- デプロイ先: Cloudflare Workers（本番の URL: https://aix-hub.yuu0413.com ）
- 設計: [docs/design/reservation-system.md](docs/design/reservation-system.md)

## セットアップ

### 前提

- [Bun](https://bun.sh/) 1.3 以上

### 手順

```bash
git clone <このリポジトリ>
cd aix-hub
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

起動後、表示された URL（既定は http://localhost:5173 ）を開くとログイン画面に移動する。大学の Google アカウントでログインし、初回はプロフィール登録の画面で登録する。カレンダーが表示されれば成功。

### 最初の admin を作る

管理画面で役割を変えられるのは admin だけのため、最初の1人は DB を直接更新して作る。

1. admin にする人が一度ログインする（`users` に行ができる）
2. 対象の DB（Neon の SQL Editor など）で次の SQL を実行する

```sql
UPDATE users SET role = 'admin', "updatedAt" = now() WHERE email = '<admin にする人のメールアドレス>';
```

更新した行が1行であることを確かめる（0行なら、ログインがまだか、メールアドレスが違う）。2人目以降は、管理画面の「利用者の管理」から変更する。

### テスト用 DB

DB を使うテストは、テスト用の Neon ブランチに繋ぐ。`.dev.vars.test` に次の2つを書き、`bun run test` で実行する（マイグレーションはテストの開始時に自動で適用される）。

| キー | 値 |
|---|---|
| `TEST_DATABASE_URL` | テスト用ブランチの接続文字列。ほかのテストファイルと共有する |
| `TEST_ISOLATED_DATABASE_URL` | DB 全体の状態を前提にするテスト（`tests/worker/routes/admin-isolated-db.test.ts`）専用のブランチの接続文字列。テストが DB 内の admin を全員外し、全員の学年を更新するため、`TEST_DATABASE_URL` や開発用・本番用とは別のブランチにする |

`admin-isolated-db.test.ts` はブランチ内の admin を全員外し、全員の学年を更新するため、同じ専用ブランチで同時に動かさない（ローカルと CI の同時実行も含む）。動かすと、互いのデータを書き換え合ってたまに失敗する。

## 本番に出す

本番は https://aix-hub.yuu0413.com で、Cloudflare Workers のカスタムドメインで配信する（`wrangler.jsonc` の `routes`）。`*.workers.dev` の URL は止めている（`workers_dev: false`）。better-auth は `BETTER_AUTH_URL` の URL でしかログインを完了できないため。

デプロイは main の内容から手で行う（CI からの自動デプロイはしない）。ブランチから出すと、本番と main の内容がずれるため。

### 前提

- `yuu0413.com` を管理している Cloudflare アカウントで `wrangler login` する（別のアカウントだとカスタムドメインを作れず、デプロイが失敗する）
- Neon の production ブランチと、Google Cloud Console の OAuth クライアントを触れる

wrangler を非対話で動かすときは `WRANGLER_SEND_METRICS=false` を付ける（メトリクスの確認で止まることがあるため）。

### 初回の手順

**1. 準備する**

```bash
git switch main && git pull
bun install
WRANGLER_SEND_METRICS=false bunx wrangler login
WRANGLER_SEND_METRICS=false bunx wrangler whoami   # yuu0413.com のあるアカウントか確かめる
```

**2. 本番 DB にマイグレーションを適用する**

`bun run db:migrate` は `.dev.vars`（開発用 DB）を読むので使わない。Neon の「Connect」で Branch を **production** にして接続文字列をコピーし、次のように渡す。

```bash
read -s "DATABASE_URL?本番の接続文字列: "   # zsh の書き方。入力が画面と履歴に残らない
export DATABASE_URL
bunx drizzle-kit migrate
unset DATABASE_URL
```

Neon の SQL Editor（Branch は production）で `SELECT count(*) FROM drizzle.__drizzle_migrations;` を実行し、`drizzle/` にある SQL ファイルと同じ数が返れば成功。

**3. デプロイする**

```bash
WRANGLER_SEND_METRICS=false bun run deploy
```

出力に `aix-hub.yuu0413.com (custom domain)` が出れば成功。secret をまだ登録していないので、この時点ではサイトを開くとエラーになる（Worker が無い状態だと次の secret の登録が失敗することがあるため、先にデプロイする）。

**4. secret を登録する**

次の5つを1つずつ実行し、聞かれたら値を貼り付ける（値をコマンドに書かないので履歴に残らない）。

```bash
WRANGLER_SEND_METRICS=false bunx wrangler secret put DATABASE_URL
WRANGLER_SEND_METRICS=false bunx wrangler secret put GOOGLE_CLIENT_ID
WRANGLER_SEND_METRICS=false bunx wrangler secret put GOOGLE_CLIENT_SECRET
WRANGLER_SEND_METRICS=false bunx wrangler secret put BETTER_AUTH_SECRET
WRANGLER_SEND_METRICS=false bunx wrangler secret put BETTER_AUTH_URL
```

| キー | 本番の値 |
|---|---|
| `DATABASE_URL` | 手順2と同じ production ブランチの接続文字列 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 開発と同じ OAuth クライアントの値 |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32 \| pbcopy` で新しく作った値。開発用の値は使い回さない |
| `BETTER_AUTH_URL` | `https://aix-hub.yuu0413.com`（末尾に `/` を付けない） |

`WRANGLER_SEND_METRICS=false bunx wrangler secret list` で5つの名前が並べば成功。

**5. OAuth クライアントに本番の URL を追加する**

Google Cloud Console の「認証情報」で OAuth クライアントを開き、次の2つを **追加** する（localhost の分は開発で使うので消さない）。

- 承認済みの JavaScript 生成元: `https://aix-hub.yuu0413.com`
- 承認済みのリダイレクト URI: `https://aix-hub.yuu0413.com/api/auth/callback/google`

OAuth 同意画面が「テスト中」だと、テストユーザーに登録した人しかログインできないことがある。

**6. 動作を確認する**

別のターミナルで `WRANGLER_SEND_METRICS=false bunx wrangler tail` を動かしてログを見ながら、https://aix-hub.yuu0413.com で大学の Google アカウントでログインし、各機能を使う。証明書の発行に数分かかることがあり、その間はつながらない。

| 症状 | よくある原因 |
|---|---|
| Google の画面に `redirect_uri_mismatch` | 手順5の URI の打ち間違い |
| ログに「〜が未設定です」 | 手順4の登録漏れ |

**7. 最初の admin を作る**

「[最初の admin を作る](#最初の-admin-を作る)」と同じ手順を、production ブランチに対して行う。

### 2回目以降の手順

コードだけが変わったときは、main を最新にして `WRANGLER_SEND_METRICS=false bun run deploy` を実行する。`drizzle/` にマイグレーションが増えたときは、デプロイの **前に** 手順2を行う（新しいコードが、まだ無い列やテーブルを読みにいかないようにするため）。`Bindings`（`src/worker/env.ts`）にキーが増えたときは、デプロイの前に手順4で登録する。

### 戻すとき

`WRANGLER_SEND_METRICS=false bunx wrangler rollback` で1つ前のバージョンに戻せる。DB のマイグレーションは戻らないため、戻す先のコードが今の DB で動くか確かめてから行う。

## コマンド

| コマンド | 用途 |
|---|---|
| `bun run dev` | 開発サーバー起動（API と画面を同時に配信） |
| `bun run test` | テスト実行（`.dev.vars.test` の `TEST_DATABASE_URL` と `TEST_ISOLATED_DATABASE_URL` を読む） |
| `bun run typecheck` | 型チェック |
| `bun run lint` | Lint・整形チェック（`bun run lint:fix` で自動修正） |
| `bun run build` | 本番ビルド |
| `bun run deploy` | ビルドして Cloudflare Workers にデプロイ |
| `bun run cf-typegen` | `wrangler.jsonc` 変更後に Workers の型を再生成（`.dev.vars` は読まない。読むと `.dev.vars` の無い CI の検査と結果が変わるため） |
| `bun run db:generate` | スキーマからマイグレーションを生成 |
| `bun run db:migrate` | マイグレーションを適用 |

## CI

GitHub Actions（`.github/workflows/ci.yml`）で push / PR 時に Lint・型チェック・マイグレーションと Workers の型の更新漏れの検査・テスト・ビルドを実行する。テストはリポジトリの Secrets の `TEST_DATABASE_URL`（テスト用 Neon ブランチ）と `TEST_ISOLATED_DATABASE_URL`（DB 全体の状態を前提にするテスト専用の Neon ブランチ）を使い、時間を短くするためテストファイルを並列に動かす（ローカルの `bun run test` は1つずつ順番に動かす）。
