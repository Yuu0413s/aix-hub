# API 規約（このプロジェクト固有）

> 判断したものだけを書く。未定のまま残してよい。

## エンドポイント設計

**未定**

論点の例:
- リソース名は複数形か
- ネスト（`/slots/:id/reservations`）をどこまで許すか

選んだ理由:

---

## ステータスコード

- 二重予約などの競合は `409 Conflict`
- 権限不足は `403 Forbidden`（存在を隠すための 404 は使わない）
- 作成成功も `200 OK`（`201` は使わない）

選んだ理由: 未記入（2026-10-16, フロント設計時に決定）

- 未ログインは `401 Unauthorized`
- 入力の検証エラーは `400 Bad Request`（`422` は使わない）

選んだ理由: 今後も利用したいため（2026-10-22, Issue #3 で決定）

---

## エラーレスポンスの形

共通の形にそろえる: `{ error: { code: "SLOT_TAKEN", message: "..." } }`
フロントは `code` を見て表示を分ける

選んだ理由: 未記入（2026-10-16, フロント設計時に決定）

### 想定外のエラー（500）

- `500` で `{ error: { code: "INTERNAL_SERVER_ERROR", message: "サーバーでエラーが発生しました" } }` を返す（エラーの中身はレスポンスに出さない）
- ログには、エラーの種類・メッセージ・stack を `cause` までたどって出す。ただし `DATABASE_URL` の全体とパスワード部分は `***` に置き換える
- `HTTPException` は、ステータスを変えずに返す（本文は下の「HTTPException」のとおり共通の形にそろえる）

選んだ理由: 未記入（2026-10-16, Issue #1 で決定）

- ログでは、SQL に渡した値（Drizzle のエラー文の `params:`）も `***` に置き換える（セッショントークンなどが含まれるため）

選んだ理由: 未記入（2026-10-22, Issue #2 のレビューで決定）

### HTTPException

- Hono の `HTTPException`（壊れた JSON など）も、ステータスを変えずに共通の形 `{ error: { code, message } }` にそろえる
- `code` はステータスから決める（`400` → `BAD_REQUEST`、`401` → `UNAUTHORIZED`、`403` → `FORBIDDEN`、`404` → `NOT_FOUND`、`409` → `CONFLICT`、それ以外は `HTTP_ERROR`）

選んだ理由: 今後も利用したいため（2026-10-22, Issue #3 で決定）

---

## ログの形

- Worker のログは、`{ event, ...項目 }` の形の1行の JSON 文字列で出す（`src/worker/log.ts` の `writeLog` を使う）。Workers Logs で項目ごとに絞り込むため
- 重さは console のメソッドで分ける（失敗は `console.error`、結果の記録は `console.log`）。JSON の中には入れない
- `DATABASE_URL`（全体とパスワード）と SQL に渡した値（`params:`）は、JSON にする前に伏せ、伏せたあとの文字列を項目に入れる。JSON にすると `"` や `\` の形が変わり、あとから伏せると一致しなくなるため
- 項目の値は、文字列・数値・文字列の配列だけにする（Error などのオブジェクトは JSON にすると中身が消えるため）
- リクエストの `path` には、クエリ文字列を含めない（ログインの途中の `code` や `state` など、ログに残してはいけない値が入るため）

| event | 出す場所 | 項目 | 重さ |
|---|---|---|---|
| `apiUnhandledError` | `app.onError`（想定外のエラー） | `method`, `path`, `error` | error |
| `betterAuthLog` | better-auth の logger | `message` | better-auth のレベル |
| `cronSeminarDaysCreated` | Cron の開催日の作成 | `dates`, `count`, `scheduledTime` | log |
| `cronReservationsMarkedDone` | Cron の予約の「済」への更新 | `count`, `scheduledTime` | log |
| `cronTaskFailed` | Cron の処理の失敗 | `task`, `error`, `scheduledTime` | error |

- `scheduledTime` は、Cron が処理の基準にした時刻（起動する予定だった時刻）を ISO 形式にした文字列

### event の名前

- キャメルケースにする（例: `apiUnhandledError`）

選んだ理由: 統一感を持たせたいから（2026-11-13, Issue #22 で決定）
