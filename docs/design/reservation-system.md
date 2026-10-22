# 1on1 予約システム 設計メモ

- 作成日: 2026-10-02 / 改訂: 2026-10-16（DB 設計・フロント設計を反映）
- 開発方式: アジャイル（スプリントは区切らず、1 Issue = 1 PR で回す）
- 対象デバイス: スマホ / PC
- デプロイ先: Cloudflare Workers
- 前身: `seminar-1on1-GAS`（Googleスプレッドシート + GAS）
- DB の詳細: `docs/design/db-reservation.md` / `database.dbdiagram`

---

## 1. 目的

ゼミの1on1（発表・相談）予約を、スプレッドシートの日付タブ運用から
「カレンダーで日付を選ぶ → 空き枠を予約する」Webアプリに置き換える。

## 2. ユーザー

- ログイン: **Google ログイン必須**（better-auth）
- 利用可能アカウント: `@stu.musashino-u.ac.jp` / `@ds.musashino-u.ac.jp` / `@musashino-u.ac.jp`
  - Google の `hd` パラメータはヒントに過ぎないため、**サーバー側でメールドメインを必ず検証する**
  - `@` より後ろを3ドメインと **完全一致** で比較する（末尾一致にしない）

| 役割 | できること |
|---|---|
| student（学生） | 予約・取消 / 自分の予約一覧と発表回数を見る / 表示名を変える |
| teacher（先生） | 全体連絡を書く（自分の分を編集・削除）/ 全員の発表回数を見る。予約はしない |
| admin（管理者） | student の機能すべて / 全体連絡の管理（全員分）/ 他人の予約の取消 / 管理画面 |

- 新規ログインは `student`。最初の admin は手作業で DB を更新して作る
- 先生は初回のプロフィール登録で「教員（学年なし）」を選び、admin が役割を teacher に変える

### 公開範囲

| 情報 | 本人 | 他の学生 | 先生・管理者 |
|---|---|---|---|
| 予約者名・学年 | ○ | ○ | ○ |
| 発表回数 | ○ | × | ○（全員分） |

公開範囲の制御は **APIレスポンスで行う**（フロントで隠すだけにしない）。

### ログインの記録に保存するもの

`sessions` には、better-auth の標準どおり接続元の IP（`cf-connecting-ip`）と User-Agent を保存する（2026-10-22, Issue #2 で決定）。IP は回数制限で利用者を区別するためにも使う。

## 3. 課題

- 日付ごとにタブが増え続け、目的の日を探しにくい
- 人数が増え、同じセルへの同時書き込み・上書きが起こりうる
- スマホでのスプレッドシート編集は操作しづらい
- 「済」の判定がセル色（グレー）頼みで、手作業のミスが起きやすい

## 4. 機能

### MVP に含める

| # | 機能 | 誰が |
|---|---|---|
| 1 | Google ログイン（3ドメイン限定）＋ 初回プロフィール登録（表示名・学年） | 全員 |
| 2 | トップ：月カレンダー ＋ 今週の全体連絡 | 全員 |
| 3 | 日別の枠の表（スプシ風）→ 空き枠をクリック → 「予約しますか？」→ はい で確定 | student / admin |
| 4 | 自分の予約の確認・取消（マイページ / 日別の表の自分の名前から） | student / admin |
| 5 | マイページ：予約一覧・発表回数・表示名の変更（学年は変更不可） | 全員 |
| 6 | 全体連絡の作成・編集・削除（本人の分。admin は全員分） | teacher / admin |
| 7 | 発表回数一覧（全員分） | teacher / admin |
| 8 | 管理画面：休止日の登録（理由つき） | admin |
| 9 | 管理画面：日ごとの枠の編集 | admin |
| 10 | 管理画面：利用者一覧・役割の変更 | admin |
| 11 | 管理画面：学年更新（毎年4月。B4・MIDS B4・M2 は進路を選ぶ） | admin |
| 12 | 自動処理：金曜を4週間先まで生成 / 毎晩、過ぎた予約を「済」にする | – |

### MVP に含めない（優先順）

1. アカウント画面の研究内容・研究ステップ（中身が未定）
2. 予約ルールの制限（1日1枠まで など）
3. 通知・リマインド（メール / Slack）
4. スプレッドシートからのデータ移行

### スプシから引き継がないもの

相談内容・要望・先生からの連絡（予約ごと）・日ごとのメモ。
先生からの連絡は全体連絡にまとめ、相談内容・要望は別ドキュメントで管理する。

## 5. 画面構成

```
[ログイン] ──(初回のみ)──> [プロフィール登録]  表示名・学年（「教員（学年なし）」も選べる）
     │                          │
     └────────────┬─────────────┘
                  ▼
[トップ]  /                   月カレンダー ＋ 今週の全体連絡（teacher / admin はここから書く）
  │ 日付をクリック（過去の日付も開ける）
  ▼
[日別の枠の表]  /days/:date    スプシ風の表（時限・開始・終了・予約者名）
  │ 空き枠をクリック                    自分の名前をクリック → 取消
  ▼
(ダイアログ)「13:30〜13:50 を予約しますか？」→ はい / いいえ

ヘッダーから:
├── [マイページ]  /me           表示名の変更・自分の予約一覧（取消）・発表回数
├── [発表回数一覧]  /stats      teacher / admin にだけボタンを表示
└── [管理画面]  /admin          admin にだけボタンを表示
      ├── 学年更新
      ├── 開催日の管理（休止・理由・枠の編集）
      └── 利用者の管理（役割の変更）
```

- 休止日はカレンダー上でグレー。PC ではカーソルを合わせると「休講日」と表示し、クリックで理由を表示する（スマホはタップで理由を表示）
- 日別の表には、発表枠・休憩・先生からの共有・なし をすべて行として並べる
- 確認ダイアログはブラウザ標準の `<dialog>` を使う

## 6. データ構造

詳細は `docs/design/db-reservation.md`（判断理由つき）と `database.dbdiagram` を参照。

```
users ──< reservations >── slots >── seminarDays
  │  └──< gradePromotions                  │
  └──────────< announcements >─────────────┘
```

| テーブル | 要点 |
|---|---|
| `users` | better-auth + `role` / `grade` / `displayName` / `isEnrolled` |
| `seminarDays` | `date` UNIQUE、`status`（open / closed）、`closedReason` |
| `slots` | `period`（3〜6）、開始・終了時刻、`kind`。UNIQUE(seminarDayId, startTime) |
| `reservations` | `slotId` UNIQUE で二重予約を防ぐ。取消は物理削除。`status`（reserved / done） |
| `announcements` | 開催日・author・内容・表示期間（任意） |
| `gradePromotions` | 学年更新の記録。`academicYear` UNIQUE で二重実行を防ぐ |

- 発表回数は列に持たず、`done` の予約の件数で出す
- 時間割テンプレートはコード定数（`src/shared/schedule-template.ts`。GAS の `SCHEDULE` を移植）

## 7. API 設計

| メソッド | パス | 権限 | 内容 |
|---|---|---|---|
| `*` | `/api/auth/*` | – | better-auth |
| GET | `/api/me` | ログイン済 | 自分の情報・役割・プロフィール登録済みか |
| POST | `/api/me/profile` | ログイン済 | 初回のプロフィール登録（表示名・学年）。登録済みなら `409` |
| PATCH | `/api/me/profile` | ログイン済 | 表示名の変更（学年を含むと `400`）。未登録なら `409` |
| GET | `/api/me/reservations` | ログイン済 | 自分の予約一覧 ＋ 発表回数 |
| GET | `/api/days?month=YYYY-MM` | ログイン済 | 月内の開催日・状態・休止理由・空き枠の数 |
| GET | `/api/days/:date` | ログイン済 | その日の枠と予約者名 |
| POST | `/api/slots/:slotId/reservations` | student / admin | 予約。埋まっていれば `409` |
| DELETE | `/api/reservations/:id` | 本人 / admin | 取消 |
| GET | `/api/announcements?current` | ログイン済 | 表示期間中の全体連絡 |
| POST | `/api/announcements` | teacher / admin | 全体連絡の作成 |
| PATCH / DELETE | `/api/announcements/:id` | 書いた本人 / admin | 編集・削除 |
| GET | `/api/stats/presentations` | teacher / admin | 全員の発表回数 |
| POST | `/api/admin/grade-promotions` | admin | 学年更新（4月1日以降のみ実行可。同じ年度は `409`） |
| PATCH | `/api/admin/days/:date` | admin | 休止・再開と理由（行が無ければ作る。休止時は予約を削除） |
| PATCH | `/api/admin/slots/:id` | admin | 枠の編集（`presentation` 以外にしたら予約を削除） |
| GET | `/api/admin/users` | admin | 利用者一覧 |
| PATCH | `/api/admin/users/:id` | admin | 役割の変更（最後の admin は変更不可、`409`） |
| (Cron) | `scheduled` | – | 4週間先までの金曜を冪等に生成 / 過ぎた予約を `done` にする |

- フロントからは Hono RPC クライアントで呼び出す
- 入力検証は zod（`src/shared/schemas.ts`）
- 成功は `200`（作成も含む）、競合は `409`、権限不足は `403`、エラーは `{ error: { code, message } }`（`docs/conventions/api.md`）

## 8. フォルダ構成

```
1on2-reserve/
├── src/
│   ├── worker/
│   │   ├── index.ts                 エントリ（fetch / scheduled）
│   │   ├── auth.ts                  better-auth 設定（3ドメインの検証）
│   │   ├── error-handler.ts         想定外のエラー・HTTPException を共通の形で返す（秘密情報を伏せてログ）
│   │   ├── validator.ts             zod の検証エラーを共通の形の 400 で返す
│   │   ├── middleware/
│   │   │   └── auth.ts              requireAuth / requireRole / requireProfile（未登録なら 403）
│   │   ├── routes/
│   │   │   ├── me.ts
│   │   │   ├── days.ts
│   │   │   ├── reservations.ts
│   │   │   ├── announcements.ts
│   │   │   ├── stats.ts
│   │   │   └── admin.ts
│   │   ├── services/                ロジック本体（テストの中心）
│   │   │   ├── reservation.ts
│   │   │   ├── seminar-day.ts
│   │   │   ├── grade-promotion.ts
│   │   │   └── announcement.ts
│   │   ├── cron.ts
│   │   └── db/
│   │       ├── schema.ts
│   │       └── client.ts
│   ├── client/
│   │   ├── main.tsx
│   │   ├── routes/
│   │   │   ├── login.tsx
│   │   │   ├── onboarding.tsx
│   │   │   ├── home.tsx
│   │   │   ├── day.tsx
│   │   │   ├── me.tsx
│   │   │   ├── stats.tsx
│   │   │   └── admin/
│   │   │       ├── grade-promotion.tsx
│   │   │       ├── days.tsx
│   │   │       └── users.tsx
│   │   ├── components/              ヘッダー・カレンダー・枠の表・確認ダイアログ など
│   │   └── lib/
│   │       ├── api.ts
│   │       └── auth-client.ts       better-auth クライアント・ログイン確認の loader
│   └── shared/
│       ├── auth.ts                  許可ドメイン・ログインのエラーコード
│       ├── schedule-template.ts
│       ├── grade.ts                 学年の表示・進級の対応表
│       ├── profile.ts               表示名の上限（画面でも使うため zod と分ける）
│       ├── api-errors.ts            エラーレスポンスの code の一覧
│       └── schemas.ts
├── tests/                           src/ と同じ階層構造
├── drizzle/
├── docs/
├── index.html
├── vite.config.ts
├── drizzle.config.ts
└── wrangler.jsonc
```

- routes は HTTP の受け答え、services は判断（予約できるか など）を担当する。services を HTTP から切り離してテストする
- UI 部品はライブラリを使わず Tailwind で自作する。ダイアログのみブラウザ標準の `<dialog>`

### 技術スタック

| 層 | 採用 | 理由 |
|---|---|---|
| フロント | Vite + React 19 + React Router + TanStack Query + Tailwind 4 | Tsumori で経験済み |
| API | Hono（フロントと同一 Worker） | CORS・2系統デプロイの手間を無くす |
| DB | Neon（PostgreSQL）+ Drizzle | 経験済み |
| 認証 | better-auth（Google OAuth） | 経験済み・役割をアプリ内で管理できる |
| デプロイ | Cloudflare Workers | 決定済み |

## 9. 実装手順

1 Issue = 1 PR。機能ごとの縦割り（API と画面を同じ Issue に含める）。

| # | Issue | 中身 | 依存 |
|---|---|---|---|
| 1 | Neon 接続の検証・エラーのマスク | 接続方式の確定（トランザクションの可否）、ログのマスク | – |
| 2 | Google ログイン・3ドメイン制限 | better-auth 導入、users の追加列、ログイン画面 | 1 |
| 3 | プロフィール登録・権限チェック | POST / PATCH `/api/me/profile`、登録画面、`requireRole` | 2 |
| 4 | 開催日・枠の生成 | スキーマ、時間割テンプレート、金曜生成の Cron | 1 |
| 5 | 月カレンダー | `GET /api/days?month`、トップのカレンダー（休止日の表示） | 3, 4 |
| 6 | 日別の枠の表 | `GET /api/days/:date`、スプシ風の表 | 5 |
| 7 | 予約・取消 | 予約（409）、確認ダイアログ、表からの取消、毎晩「済」にする Cron | 6 |
| 8 | マイページ | 予約一覧・回数・取消・表示名の変更 | 7 |
| 9 | 全体連絡 | 作成・編集・削除、トップに表示 | 3, 4 |
| 10 | 発表回数一覧 | teacher / admin 用ページ | 7 |
| 11 | 管理：休止日 | 休止・再開・理由、予約の削除 | 4, 7 |
| 12 | 管理：枠の編集 | 種類・時刻の変更、予約の削除 | 7 |
| 13 | 管理：利用者と役割 | 一覧・役割の変更・最後の admin の保護 | 3 |
| 14 | 管理：学年更新 | 進級・進路選択・`gradePromotions` | 13 |
| – | **MVP リリース** | | |
| 15〜 | 研究内容・研究ステップ → 予約ルール → 通知 → データ移行 | | MVP |

## 10. リスク

| # | リスク | 対策 | Issue |
|---|---|---|---|
| 1 | Neon HTTP ドライバで、途中に判断を挟むトランザクションが使えない（2026-10-16 検証で確定）。学年更新・休止は複数の書き込みをまとめる必要がある | **HTTP（neon-http）+ `db.batch` を採用**（今の構成から変えずに済み、リクエストごとの接続の管理も要らないため）。`db.transaction()` は neon-http では必ず例外になる。`db.batch` は途中で失敗すると全体が取り消されることを開発用 DB で確認済み（DDL を含む batch で検証）。途中の結果で分岐する処理は、UNIQUE 制約での失敗や条件付きの1文の SQL で書く。それで書けない処理が出たら WebSocket（`Pool`）に切り替える | 1 |
| 2 | Neon のエラーに接続文字列が含まれログに漏れる（過去2回指摘） | `app.onError`（`src/worker/error-handler.ts`）で、`DATABASE_URL` の全体とパスワード部分を `***` に置き換えてからログに出し、レスポンスは共通の形の 500 にする。Drizzle のエラー文の `params:`（SQL に渡した値）も伏せる。better-auth（`/api/auth/*`）が自分で受け止めた DB のエラーは `onError` を通らないため、better-auth の `logger` でも同じく伏せる（`src/worker/auth.ts`、#2）。Cron（`scheduled`）のエラーは `onError` を通らないため #4 / #7 で扱う | 1, 2, 4, 7 |
| 3 | ドメイン制限のすり抜け（`hd` はヒントのみ。末尾一致だと `@evil-musashino-u.ac.jp` が通る） | `@` 以降を完全一致で比較し、テストで確認する | 2 |
| 4 | 大学の Google Workspace が外部アプリへのログインを制限している可能性 | 2026-10-16 に OAuth 2.0 Playground で確認。`@stu.musashino-u.ac.jp` は認可コードの発行まで成功（制限なし）。`@ds.` / `@musashino-u.ac.jp` は未確認 | 2 |
| 5 | OAuth 同意画面が「テスト」状態のときの人数上限・審査（**不確か**） | 確認する | 2 |
| 6 | タイムゾーン（Workers / Cron は UTC） | 日付の判定は Asia/Tokyo。`now` を注入してテストする | 4, 7, 9, 14 |
| 7 | Cron の重複実行 | `date` UNIQUE + `onConflictDoNothing`、「予約中だけ済にする」で冪等にする | 4, 7 |
| 8 | 最後の admin が役割を外すと、誰も管理画面に入れなくなる | admin が1人のときは役割を変更できない（409） | 13 |
| 9 | 枠の時刻編集で、開始時刻が同じ日の別の枠と重なる | UNIQUE 違反を 409 で返す | 12 |
| 10 | better-auth のテーブル名を複数形にできるか、追加列に enum を使えるか | 2026-10-22 に確認（better-auth 1.7）。Drizzle アダプタの `usePlural: true` で複数形にできる。追加列は `type: [...値の一覧]` で書け、DB 側は `pgEnum` で定義する | 2 |
| 11 | 移行期間のスプシとの二重管理 | 切替日を決め、スプシは閲覧専用にする運用ルールを作る | MVP 後 |
