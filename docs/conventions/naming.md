# 命名規約（このプロジェクト固有）

> 判断したものだけを書く。未定のまま残してよい。

## ファイル・ディレクトリ名

kebab-case（例: `schedule-template.ts`, `day-slot-list.tsx`）。React コンポーネントのファイルも同じ

選んだ理由: 大文字と小文字を区別しない OS でも事故が起きず、Tsumori と揃うため（2026-10-02, 初期構築時に決定。このプロジェクトのみに適用）

---

## boolean の命名

すべて `is〜` にそろえる（例: `isEnrolled`）

選んだ理由: 特になし（2026-10-16, DB設計時に決定。このプロジェクトのみに適用）

- 変数・プロパティだけでなく、boolean を返す関数の名前も `is〜` にそろえる（例: `isRetryable`、`isReservationExisting`。`should〜` / `exists〜` / `can〜` は使わない）

選んだ理由: 未記入（2026-10-23, Issue #7 のレビューで決定）
