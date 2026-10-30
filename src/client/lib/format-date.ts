import { splitMonth, utcMidnight } from "../../shared/date";

// getUTCDay() の曜日の番号（日曜=0 … 土曜=6）の順に並べる
export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

// 2032-03-05 → 3月5日（金）。date は実在する日付（isDate で確かめた値）
export function formatDate(date: string) {
	const day = utcMidnight(date);
	return `${day.getUTCMonth() + 1}月${day.getUTCDate()}日（${WEEKDAY_LABELS[day.getUTCDay()]}）`;
}

// 2032-03 → 2032年3月。month は月の形（isMonth で確かめた値）。トップのカレンダーと管理画面の月の見出しで使う
export function formatMonth(month: string) {
	const { year, monthNumber } = splitMonth(month);
	return `${year}年${monthNumber}月`;
}
