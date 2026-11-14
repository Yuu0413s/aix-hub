import { useState } from "react";

// カレンダーの週の始まり。人によって選べるようにし、その端末のブラウザに保存する（DB には持たない）
export type WeekStart = "sunday" | "monday";

// 保存できたか。boolean ではなく名前の付いた値で返す（setter の名前のまま成否を返せるようにするため）
export type WeekStartSaveResult = "saved" | "failed";

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

	// 保存できたかを返す（選ぶ画面で、保存できなかったことを伝えるため）。
	// 保存できなかったときは表示も変えない。カレンダーは開くたびに保存された値を読むため、
	// 選ぶ画面の表示だけ変えると、カレンダーの並びと食い違う
	function setWeekStart(value: WeekStart): WeekStartSaveResult {
		try {
			localStorage.setItem(STORAGE_KEY, value);
		} catch {
			return "failed";
		}
		setWeekStartState(value);
		return "saved";
	}

	return [weekStart, setWeekStart] as const;
}
