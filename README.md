# 1on2-reserve

ゼミの1on1（発表・相談）の予約システム。カレンダーから日付を選び、空いている枠を予約する。

- 本番: https://aix-hub.yuu0413.com
- 対象デバイス: スマホ / PC
- 前身: Google スプレッドシート（日付ごとのタブ）＋ GAS。タブが増え続けて探しにくい、同じセルへの同時書き込み、スマホで編集しづらい、「済」をセルの色で手作業で付ける、といった問題を解消するために作った
- 設計: [docs/design/reservation-system.md](docs/design/reservation-system.md)（機能・画面・決めたことの理由）

## できること

大学の Google アカウントでログインする。ログインできるのは `@stu.musashino-u.ac.jp`（学生）と `@ds.musashino-u.ac.jp`（先生）だけ。最初のログインで、ドメインから役割が決まる（`@stu.` は student、`@ds.` は teacher）。admin は管理画面で役割を変えて作る。

| 役割 | できること |
|---|---|
| student（学生） | 枠の予約・取消 / 自分の予約一覧と発表回数を見る / 表示名を変える / 学会への参加を表明する |
| teacher（先生） | 全体連絡を書く（自分の分を編集・削除）/ 全員の発表回数を見る / 今日の予約者を見る。予約はしない |
| admin（管理者） | student の機能すべて / 全体連絡の管理（全員分）/ 他人の予約の取消 / 管理画面（開催日の休止・枠の編集、利用者の役割の変更、毎年4月の学年更新） |

主な画面:

| URL | 画面 |
|---|---|
| `/` | 月のカレンダーと今週の全体連絡 |
| `/days/:date` | その日の枠の表。空き枠を押して予約し、自分の名前を押して取り消す |
| `/me` | マイページ（表示名の変更・週の始まりの選択・予約一覧・発表回数） |
| `/stats` | 全員の発表回数（teacher / admin） |
| `/conferences` | 学会の一覧・登録と、参加の表明（検討中・投稿予定・投稿済み） |
| `/admin` | 管理画面（admin） |

毎日、日本時間の 0:05 に自動処理が動く（`wrangler.jsonc` の Cron。処理は `src/worker/cron.ts`）。

- 今日以降の金曜を4回分、開催日として作る
- 開始時刻を過ぎた予約を「済」にする（発表回数は「済」の件数なので、反映は翌日になる）

## 技術スタック

| 役割 | 使っているもの |
|---|---|
| ランタイム・パッケージ管理 | [Bun](https://bun.sh/) |
| 画面 | Vite + React + React Router + TanStack Query + Tailwind CSS |
| API | Hono（画面と同じ Cloudflare Worker で配信する。`/api/*` だけ Worker が処理し、それ以外は SPA を返す） |
| DB | Neon（PostgreSQL）+ Drizzle ORM |
| 認証 | better-auth（Google ログイン。メールのドメインはサーバー側で確かめる） |
| 配信 | Cloudflare Workers |
| テスト | bun test（DB を使うテストはテスト用の Neon ブランチに繋ぐ） |
| Lint・整形 | Biome |

## ディレクトリ構成

```
aix-hub/
├── src/
│   ├── worker/        API（Hono）。env.ts に環境変数の型、cron.ts に毎日の自動処理
│   │   ├── routes/    エンドポイント
│   │   ├── services/  予約・開催日などの処理
│   │   └── db/        Drizzle のスキーマと接続
│   ├── client/        画面（React）
│   │   ├── routes/    画面ごとのファイル
│   │   ├── components/ 画面の部品
│   │   └── lib/       API の呼び出し・エラーの文言・日付の表示など
│   └── shared/        画面と API の両方で使うもの（役割・学年・日付・入力のスキーマなど）
├── tests/             src/ と同じ階層でテストを置く
├── drizzle/           マイグレーション（db:generate の生成物。手で書き換えない）
└── docs/
    ├── design/        設計メモ
    └── conventions/   このプロジェクトの規約（API・DB・命名・テスト）
```

ファイルごとの役割は [CLAUDE.md](CLAUDE.md) にも書いてある。

## 開発を始める

### 前提

- [Bun](https://bun.sh/) 1.3 以上
- 開発用の Neon ブランチと、Google Cloud Console の OAuth クライアント（下の `.dev.vars` で使う）

### 手順

```bash
git clone https://github.com/Yuu0413s/aix-hub.git
cd aix-hub
bun install
cp .dev.vars.example .dev.vars   # 各キーを書き換える（下記）
bun run db:migrate               # 開発用 DB にテーブルを作る
bun run dev
```

`.dev.vars` に書くもの（秘密情報なので git には入れない。`.env` は使わない）:

| キー | 値 |
|---|---|
| `DATABASE_URL` | 開発用 Neon ブランチの接続文字列 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud Console の OAuth クライアント。リダイレクト URI に `http://localhost:5173/api/auth/callback/google` を登録する |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` で生成した値 |
| `BETTER_AUTH_URL` | `http://localhost:5173` |

起動後、表示された URL（既定は http://localhost:5173 ）を開くとログイン画面に移動する。大学の Google アカウントでログインし、初回はプロフィール登録の画面で登録する。カレンダーが表示されれば成功。

### 最初の admin を作る

管理画面で役割を変えられるのは admin だけのため、最初の1人は DB を直接更新して作る。

1. admin にする人が一度ログインし、プロフィールを登録する（`users` に行ができる）
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
| `bun run db:migrate` | マイグレーションを適用（`.dev.vars` の DB に対して） |

## 開発の進め方

### 流れ

1. やることを GitHub の Issue にする（バックログは GitHub Projects の「seminar-1on2-reserve」）
2. main からブランチを切る
3. 実装する。API（`src/worker`・`src/shared`）の変更は、先に `tests/` にテストを書いてから実装する。画面のテストは今は書いていない
4. `bun run test` / `bun run typecheck` / `bun run lint` を通してコミットする
5. main 向けに PR を作り、CI が通ってからマージする
6. 本番に反映するときは、main から「[本番に出す](#本番に出す)」の手順でデプロイする（マージしても自動ではデプロイされない）

### 名前の付け方

既存の履歴に合わせる。

- ブランチ: `<種別>/<Issue 番号>-<内容の英語の要約>`（例: `feat/35-week-start-on-mypage`）。種別は新機能が `feat`、バグ修正が `fix`、アプリの振る舞いを変えない設定などが `chore`
- コミット: `<種別>: <内容の日本語の要約>` の1行目に続けて、本文に `Refs #<Issue 番号>` を書く（種別は `feat` `fix` `docs` `test` `refactor` `chore` など）

### 規約と設計メモ

- 命名・API・DB・テストの決まりは [docs/conventions/](docs/conventions/) にある。迷ったらまずここを見る
- 機能や画面の仕様と、そう決めた理由は [docs/design/reservation-system.md](docs/design/reservation-system.md) にある。仕様を変えたら、ここも更新する
- DB のスキーマを変えたら `bun run db:generate` でマイグレーションを作り、生成された SQL も一緒にコミットする
- Worker の環境変数を増やすときは、`src/worker/env.ts` の `Bindings` に型を足し、`.dev.vars.example` にもキーを足す。本番には、デプロイの前に `wrangler secret put` で登録する（「[本番に出す](#本番に出す)」）

### CI

GitHub Actions（`.github/workflows/ci.yml`）で push / PR 時に Lint・型チェック・マイグレーションと Workers の型の更新漏れの検査・テスト・ビルドを実行する。テストはリポジトリの Secrets の `TEST_DATABASE_URL`（テスト用 Neon ブランチ）と `TEST_ISOLATED_DATABASE_URL`（DB 全体の状態を前提にするテスト専用の Neon ブランチ）を使い、時間を短くするためテストファイルを並列に動かす（ローカルの `bun run test` は1つずつ順番に動かす）。

## 本番に出す

本番は https://aix-hub.yuu0413.com 。Cloudflare Workers のカスタムドメインで配信している（`wrangler.jsonc` の `routes`）。`*.workers.dev` の URL は止めている（`workers_dev: false`）。better-auth は `BETTER_AUTH_URL` の URL でしかログインを完了できず、残すとログインできない入口が公開されたままになるため。

- デプロイは main から手で行う。CI からの自動デプロイはしない。ブランチから出すと、本番と main の内容がずれるため
- wrangler を非対話で動かすときは `WRANGLER_SEND_METRICS=false` を付ける（メトリクスの確認で止まることがあるため）
- `wrangler login` は、`yuu0413.com` を管理している Cloudflare アカウントで行う（別のアカウントだとカスタムドメインを扱えず、デプロイが失敗する）

### いつものデプロイ

```bash
git switch main && git pull
bun install
WRANGLER_SEND_METRICS=false bun run deploy
```

マージした内容によっては、デプロイの **前に** 次を行う。

| マージした内容 | デプロイの前にやること |
|---|---|
| `drizzle/` にマイグレーションが増えた | 本番 DB にマイグレーションを適用する（下の「本番 DB にマイグレーションを適用する」）。先にデプロイすると、新しいコードがまだ無い列やテーブルを読みにいくため |
| `src/worker/env.ts` の `Bindings` にキーが増えた | `wrangler secret put <キー>` で本番の値を登録する |

デプロイ後、https://aix-hub.yuu0413.com/api/health/db が `{"status":"ok"}` を返し、ログインできることを確かめる。

### 本番 DB にマイグレーションを適用する

`bun run db:migrate` は `.dev.vars`（開発用 DB）を読むので使わない。Neon の「Connect」で Branch を **production** にして接続文字列をコピーし、次のように渡す。

```bash
read -s "DATABASE_URL?本番の接続文字列: "   # zsh の書き方。貼り付けて Enter。入力は画面と履歴に残らない
export DATABASE_URL
echo ${#DATABASE_URL}                         # 文字数だけを出す。0 なら値が入っていないので read からやり直す
bunx drizzle-kit migrate
unset DATABASE_URL
```

Neon の SQL Editor（Branch は production）で `SELECT count(*) FROM drizzle.__drizzle_migrations;` を実行し、`drizzle/` にある SQL ファイルと同じ数が返れば成功。

### 戻すとき

`WRANGLER_SEND_METRICS=false bunx wrangler rollback` で1つ前のバージョンに戻せる。DB のマイグレーションは戻らないため、戻す先のコードが今の DB で動くかを確かめてから行う。

### 本番をはじめから作るとき

本番は 2026-11-15 に作った。Cloudflare のアカウントや Neon のプロジェクトを移すなど、作り直すときは次の順に行う。

1. **準備する**: main を最新にして `bun install` し、`WRANGLER_SEND_METRICS=false bunx wrangler login` と `bunx wrangler whoami` でアカウントを確かめる
2. **本番 DB にマイグレーションを適用する**: 上の「本番 DB にマイグレーションを適用する」と同じ
3. **デプロイする**: `WRANGLER_SEND_METRICS=false bun run deploy`。出力に `aix-hub.yuu0413.com (custom domain)` が出れば成功。DNS レコードと証明書は Cloudflare が作る。secret がまだ無いので、この時点ではサイトを開くとエラーになる（Worker が無い状態だと次の secret の登録が失敗することがあるため、先にデプロイする）
4. **secret を登録する**: 次の5つを1つずつ実行し、聞かれたら値を貼り付ける（値をコマンドに書かないので履歴に残らない）。`WRANGLER_SEND_METRICS=false bunx wrangler secret list` で5つの名前が並べば成功

   ```bash
   WRANGLER_SEND_METRICS=false bunx wrangler secret put DATABASE_URL
   WRANGLER_SEND_METRICS=false bunx wrangler secret put GOOGLE_CLIENT_ID
   WRANGLER_SEND_METRICS=false bunx wrangler secret put GOOGLE_CLIENT_SECRET
   WRANGLER_SEND_METRICS=false bunx wrangler secret put BETTER_AUTH_SECRET
   WRANGLER_SEND_METRICS=false bunx wrangler secret put BETTER_AUTH_URL
   ```

   | キー | 本番の値 |
   |---|---|
   | `DATABASE_URL` | Neon の production ブランチの接続文字列 |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 次の手順5で本番の URL を登録した OAuth クライアントの値（開発と別のクライアントにしたなら、`.dev.vars` の値ではない） |
   | `BETTER_AUTH_SECRET` | `openssl rand -base64 32 \| pbcopy` で新しく作った値。開発用の値は使い回さない |
   | `BETTER_AUTH_URL` | `https://aix-hub.yuu0413.com`（末尾に `/` を付けない） |

5. **OAuth クライアントに本番の URL を登録する**: Google Cloud Console の「認証情報」で OAuth クライアントを開き、次の2つを追加して保存する。開発と同じクライアントを使うなら、localhost の分は消さない。OAuth 同意画面が「テスト中」だと、テストユーザーに登録した人しかログインできないことがある
   - 承認済みの JavaScript 生成元: `https://aix-hub.yuu0413.com`
   - 承認済みのリダイレクト URI: `https://aix-hub.yuu0413.com/api/auth/callback/google`
6. **動作を確かめる**: 別のターミナルで `WRANGLER_SEND_METRICS=false bunx wrangler tail` を動かしてログを見ながら、大学の Google アカウントでログインし、各機能を使う。証明書の発行に数分かかることがあり、その間はつながらない

   | 症状 | よくある原因 |
   |---|---|
   | Google の画面に `redirect_uri_mismatch` | 手順5の URI の打ち間違いか、手順4と違うクライアントに登録した |
   | ログに「〜が未設定です」 | 手順4の登録漏れ |

7. **最初の admin を作る**: 「[最初の admin を作る](#最初の-admin-を作る)」と同じ手順を、production ブランチに対して行う
