// 学会の登録・編集で受け付ける文字数の上限。API の検証（schemas.ts）と画面のフォームで同じ値を使う。
// 画面でも使うため、zod を使う schemas.ts とは分けている（announcement.ts と同じ理由）。
// 1行の項目は一覧・詳細に1行で出すため短く、補足・説明・メモは全体連絡の本文と同じにする（2026-11-11, Issue #18 で決定）
export const CONFERENCE_TITLE_MAX_LENGTH = 100;
export const CONFERENCE_SERIES_NAME_MAX_LENGTH = 100;
export const CONFERENCE_VENUE_MAX_LENGTH = 100;
export const CONFERENCE_URL_MAX_LENGTH = 2000;
// 締切の補足・開催日の補足・説明・メモ
export const CONFERENCE_TEXT_MAX_LENGTH = 1000;
