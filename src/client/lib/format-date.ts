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

// 2027-03-05 → 2027年3月5日（金）。学会の一覧には前年以前の学会も並ぶため、年を付ける
export function formatDateWithYear(date: string) {
	return `${utcMidnight(date).getUTCFullYear()}年${formatDate(date)}`;
}

// 期間（開始日・終了日。どちらも YYYY-MM-DD か null）。両方とも空なら null を返し、表示は呼ぶ側に任せる（「未定」など）
export function formatDateRange(start: string | null, end: string | null) {
	if (start !== null && end !== null) {
		return start === end
			? formatDateWithYear(start)
			: `${formatDateWithYear(start)}〜${formatDateWithYear(end)}`;
	}
	if (start !== null) {
		return `${formatDateWithYear(start)}〜`;
	}
	if (end !== null) {
		return `〜${formatDateWithYear(end)}`;
	}
	return null;
}

const tokyoDateTimeFormat = new Intl.DateTimeFormat("en-US", {
	timeZone: "Asia/Tokyo",
	year: "numeric",
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

// 日時（API が返す ISO 形式の文字列）→ 2026年11月10日 14:30。DB は UTC で持つため、日本時間にして表示する。
// 並び順はロケールによって変わるため、format の文字列ではなく部品から組み立てる（shared/date.ts の tokyoDate と同じ理由）
export function formatDateTime(value: string) {
	const parts = Object.fromEntries(
		tokyoDateTimeFormat
			.formatToParts(new Date(value))
			.map((part) => [part.type, part.value]),
	);
	return `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
}
