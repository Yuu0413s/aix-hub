// 日付の計算。Worker（Cron・API）と画面の両方で使うため shared に置く（画面に zod を取り込まないよう、schemas.ts と分ける）

// 月カレンダーで表示できる月（YYYY-MM）。
// 年は 2000〜2099 に絞る（西暦 0 年などは PostgreSQL の date にできず、通すと 500 になるため）
export const MONTH_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;

export function isMonth(value: string | null): value is string {
	return value !== null && MONTH_PATTERN.test(value);
}

// 日別の表で開ける日付（YYYY-MM-DD）。年の範囲は MONTH_PATTERN と同じ理由で 2000〜2099 に絞る
const DATE_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// 形式に加えて、実在する日か（2/30 などでないか）も確かめる。通すと PostgreSQL の date に変換できず 500 になるため。
// Date は 2/30 を 3/1 に繰り越すため、日付に戻して元の文字列と同じかで判定する
export function isDate(value: string): boolean {
	return (
		DATE_PATTERN.test(value) &&
		utcMidnight(value).toISOString().slice(0, 10) === value
	);
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

// 日付（YYYY-MM-DD）を、その日の UTC の 0:00 として持つ。
// 以降は getUTCDay() などの UTC の値だけで曜日・日付を計算し、実行環境のタイムゾーンに左右されないようにする
export function utcMidnight(date: string): Date {
	return new Date(`${date}T00:00:00Z`);
}

// 以下の month は YYYY-MM（isMonth で確かめた値）。計算は UTC の値だけで行う（utcMidnight と同じ理由）
export function splitMonth(month: string) {
	return {
		year: Number(month.slice(0, 4)),
		monthNumber: Number(month.slice(5, 7)),
	};
}

// 月を count か月ずらす（負の数なら前の月）
export function addMonths(month: string, count: number): string {
	const { year, monthNumber } = splitMonth(month);
	return new Date(Date.UTC(year, monthNumber - 1 + count, 1))
		.toISOString()
		.slice(0, 7);
}

// 月の日数（28〜31）。翌月の「0 日」は今月の末日になる（Date.UTC は範囲外の日を前後の月に繰り越す）
export function daysInMonth(month: string): number {
	const { year, monthNumber } = splitMonth(month);
	return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

// getUTCDay() の曜日の番号（日曜=0 … 土曜=6）で金曜。開催日は毎週金曜
export const FRIDAY = 5;

// date（YYYY-MM-DD。isDate で確かめた値）が金曜か
export function isFriday(date: string): boolean {
	return utcMidnight(date).getUTCDay() === FRIDAY;
}

// 月内の金曜の日付（YYYY-MM-DD）を日付の順に返す。管理画面で、開催日の行がまだ無い金曜も並べるために使う
export function fridaysInMonth(month: string): string[] {
	return Array.from(
		{ length: daysInMonth(month) },
		(_, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
	).filter(isFriday);
}
