import { z } from "zod";
import { GRADES } from "./grade";
import { DISPLAY_NAME_MAX_LENGTH } from "./profile";

// 空白だけの名前は空とみなすため、前後の空白を取り除いてから長さを確かめる
const displayName = z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH);

// 教員は grade: null を明示して送る。キーの省略を許すと、送り忘れと「教員を選んだ」を区別できないため
export const createProfileSchema = z.object({
	displayName,
	grade: z.enum(GRADES).nullable(),
});

// 学年は自分では変えられない。grade などが含まれていたら、黙って無視せず検証エラーにする（変わったと誤解させないため）
export const updateProfileSchema = z.strictObject({
	displayName,
});
