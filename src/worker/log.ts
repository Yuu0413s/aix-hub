type LogLevel = "log" | "info" | "warn" | "error" | "debug";

// Error などのオブジェクトは JSON にすると {} になり中身が消えるため、値は文字列・数値・文字列の配列に限る。
// 伏せる処理（maskSecrets）は呼び出し側で済ませ、伏せたあとの文字列を渡す
type LogValue = string | number | string[];

// Workers Logs で項目ごとに絞り込めるよう、ログを { event, ...fields } の1行の JSON 文字列で出す（api.md）。
// fields に event を入れられない型にして、event の上書きを防ぐ
export function writeLog(
	level: LogLevel,
	event: string,
	fields: Record<string, LogValue> & { event?: never },
): void {
	console[level](JSON.stringify({ event, ...fields }));
}
