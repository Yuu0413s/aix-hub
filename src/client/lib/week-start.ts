import { useState } from "react";

// カレンダーの週の始まり。人によって選べるようにし、その端末のブラウザに保存する（DB には持たない）
export type WeekStart = "sunday" | "monday";

const STORAGE_KEY = "weekStart";
const DEFAULT_WEEK_START: WeekStart = "sunday";

// プライベートブラウズなどでは localStorage の読み書きが例外になるため、読めなければ既定に戻す。
// 保存された値が想定外（手で書き換えられた など）のときも既定にする
function readWeekStart(): WeekStart {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		if (value === "sunday" || value === "monday") {
			return value;
		}
	} catch {
		// 下で既定を返す
	}
	return DEFAULT_WEEK_START;
}

export function useWeekStart() {
	const [weekStart, setWeekStartState] = useState(readWeekStart);

	function setWeekStart(value: WeekStart) {
		setWeekStartState(value);
		try {
			localStorage.setItem(STORAGE_KEY, value);
		} catch {
			// 保存できなくても、開いている間は選んだ表示のままにする
		}
	}

	return [weekStart, setWeekStart] as const;
}
