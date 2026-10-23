import { generateRandomString } from "better-auth/crypto";

// 主キーを better-auth が作る id と同じ形式（英数字32文字）にそろえる（db.md「主キー」）。
// better-auth の id を作る関数（generateId）は公開されていないため、同じ文字の種類と長さを指定して作る
export function createId(): string {
	return generateRandomString(32, "a-z", "A-Z", "0-9");
}
