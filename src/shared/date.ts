// 日付の計算。Worker（Cron・API）と画面の両方で使うため shared に置く（画面に zod を取り込まないよう、schemas.ts と分ける）

// 月カレンダーで表示できる月（YYYY-MM）。
// 年は 2000〜2099 に絞る（西暦 0 年などは PostgreSQL の date にできず、通すと 500 になるため）
export const MONTH_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;

export function isMonth(value: string | null): value is string {
	return value !== null && MONTH_PATTERN.test(value);
}

const tokyoDateFormat = new Intl.DateTimeFormat("en-US", {
	timeZone: "Asia/Tokyo",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

// 日本時間の日付（YYYY-MM-DD）。Workers も Cron も UTC で動くため、日付は必ず日本時間で決める（設計メモ リスク6）。
// 並び順はロケールによって変わるため、format の文字列ではなく部品から組み立てる
export function tokyoDate(now: Date): string {
	const parts = Object.fromEntries(
		tokyoDateFormat.formatToParts(now).map((part) => [part.type, part.value]),
	);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

// 月（YYYY-MM。isMonth で確かめた値）を count か月ずらす（負の数なら前の月）。
// 実行環境のタイムゾーンに左右されないよう、UTC の値だけで計算する
export function addMonths(month: string, count: number): string {
	const year = Number(month.slice(0, 4));
	const monthNumber = Number(month.slice(5, 7));
	return new Date(Date.UTC(year, monthNumber - 1 + count, 1))
		.toISOString()
		.slice(0, 7);
}
