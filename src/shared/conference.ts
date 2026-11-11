// 学会の登録・編集で、API の検証（schemas.ts）と画面で同じものを使う値と関数。
// 画面でも使うため、zod を使う schemas.ts とは分けている（announcement.ts と同じ理由）

// 受け付ける文字数の上限。1行の項目は一覧・詳細に1行で出すため短く、補足・説明・メモは全体連絡の本文と同じにする（2026-11-11, Issue #18 で決定）
export const CONFERENCE_TITLE_MAX_LENGTH = 100;
export const CONFERENCE_SERIES_NAME_MAX_LENGTH = 100;
export const CONFERENCE_VENUE_MAX_LENGTH = 100;
// URL は一覧に出さず詳細にだけ出す。クエリ付きの URL などは長くなるため、ほかの1行の項目より長くする
export const CONFERENCE_URL_MAX_LENGTH = 2000;
// 複数行の項目（締切の補足・開催日の補足・説明・メモ）
export const CONFERENCE_MULTI_LINE_MAX_LENGTH = 1000;

// http:// か https:// で始まり、URL として読めるものか。API の検証（schemas.ts）・フォームの入力チェック・詳細画面のリンクで同じ条件を使う。
// javascript: などの URL をリンクにすると、押した人のブラウザでスクリプトが動くため（設計メモ リスク2）。
// 「始まる」だけだと https:// だけの文字列も通るため、URL として読めるかも確かめる
export function isHttpUrl(value: string): boolean {
	if (!/^https?:\/\//i.test(value)) {
		return false;
	}
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}
