import { z } from "zod";
import { isDate, MONTH_PATTERN } from "./date";
import { GRADES } from "./grade";
import { countCharacters, DISPLAY_NAME_MAX_LENGTH } from "./profile";

// 予約者名として全員に表示されるため、次の文字は受け付けない（見えない名前や見た目の偽装、保存時の 500 を防ぐ）。
// 前後にあるものも取り除かずに拒否するため、trim より先に確かめる（trim は改行・行区切り・BOM も取り除いてしまう）
// - Cc: 改行・NUL などの制御文字（NUL は PostgreSQL の text に保存できない）
// - Cf: ゼロ幅スペースや文字の向きを変える文字などの書式文字
// - Cs: 対になっていないサロゲート（Neon に送る JSON が壊れて 500 になる）
// - Zl / Zp: 行区切り・段落区切り（改行と同じ働きをする）
// 見た目が空白になる普通の文字（ハングルの埋め字 U+3164 など）は分類が文字なので、ここでは防げない。
// そのあと、空白だけの名前は空とみなすため、前後の空白を取り除いてから長さを確かめる
const displayName = z
	.string()
	.regex(/^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]*$/u)
	.trim()
	.min(1)
	.refine((value) => countCharacters(value) <= DISPLAY_NAME_MAX_LENGTH);

// 教員は grade: null を明示して送る。キーの省略を許すと、送り忘れと「教員を選んだ」を区別できないため
export const createProfileSchema = z.object({
	displayName,
	grade: z.enum(GRADES).nullable(),
});

export const monthDaysQuerySchema = z.object({
	month: z.string().regex(MONTH_PATTERN),
});

export const dayParamSchema = z.object({
	date: z.string().refine(isDate),
});

// 学年は自分では変えられない。grade などが含まれていたら、黙って無視せず検証エラーにする（変わったと誤解させないため）
export const updateProfileSchema = z.strictObject({
	displayName,
});
