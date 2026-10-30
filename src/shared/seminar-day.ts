// 休止理由の上限（文字数は profile.ts の countCharacters で数える）。
// 画面でも使う値。zod を使う schemas.ts に置くと、画面のコードに zod まで取り込まれるため分けている（profile.ts と同じ理由）
export const CLOSED_REASON_MAX_LENGTH = 100;
