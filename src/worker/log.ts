type LogLevel = "log" | "info" | "warn" | "error" | "debug";

// api.md の「ログの形」の表と同じ一覧。打ち間違えた名前で出すと Workers Logs で絞り込めなくなるため、型で止める
type LogEvent =
	| "apiUnhandledError"
	| "betterAuthLog"
	| "cronSeminarDaysCreated"
	| "cronReservationsMarkedDone"
	| "cronTaskFailed";

// Error などのオブジェクトは JSON にすると {} になり中身が消えるため、値は文字列・数値・文字列の配列に限る。
// 伏せる処理（maskSecrets）は呼び出し側で済ませ、伏せたあとの文字列を渡す
type LogValue = string | number | string[];

// Workers Logs で項目ごとに絞り込めるよう、ログを { event, ...fields } の1行の JSON 文字列で出す（api.md）。
// event を先頭に置くのは、生のログを目で読むときに何のログかが先に分かるようにするため。
// fields に event を入れられない型にして、event の上書きを防ぐ
export function writeLog(
	level: LogLevel,
	event: LogEvent,
	fields: Record<string, LogValue> & { event?: never },
): void {
	console[level](JSON.stringify({ event, ...fields }));
}
