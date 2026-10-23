// 画面でも使う値。zod を使う schemas.ts に置くと、画面のコードに zod まで取り込まれるため分けている
export const DISPLAY_NAME_MAX_LENGTH = 20;

// 「1文字」はコードポイント単位で数える（絵文字1つ = 1文字）。
// サーバーの検証と画面の入力チェックで数え方がずれないよう、どちらもこの関数を使う
// （HTML の maxLength は UTF-16 単位で数えるため、絵文字が2文字分になり、ずれる）
export function countCharacters(value: string): number {
	// Array.from(value).length と同じ数え方。配列を作らないのは、API に直接送られた大きな文字列で
	// 文字列と同じ長さの配列を作り、Workers のメモリを無駄に使わないため（for...of はコードポイントごとに回る）
	let count = 0;
	for (const _ of value) {
		count++;
	}
	return count;
}
