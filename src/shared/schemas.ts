import { z } from "zod";
import { ANNOUNCEMENT_BODY_MAX_LENGTH } from "./announcement";
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

// 主キーの形（英数字32文字。worker/db/id.ts の createId と同じ）。
// 形を確かめずに DB に渡すと、%00（NUL）などが PostgreSQL の text に渡せず 500 になるため
const id = z.string().regex(/^[A-Za-z0-9]{32}$/);

export const slotParamSchema = z.object({ slotId: id });

export const reservationParamSchema = z.object({ id });

// 学年は自分では変えられない。grade などが含まれていたら、黙って無視せず検証エラーにする（変わったと誤解させないため）
export const updateProfileSchema = z.strictObject({
	displayName,
});

// 全体連絡の本文。表示名と同じく見えない文字・書式文字などは拒否するが、複数行で書けるよう改行（\n）とタブだけは許す。
// CR（\r）は許さない（ブラウザの入力欄は改行を \n にそろえて渡すため、画面から送る分には困らない）
const announcementBody = z
	.string()
	.regex(/^(?:[\n\t]|[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}])*$/u)
	.trim()
	.min(1)
	.refine((value) => countCharacters(value) <= ANNOUNCEMENT_BODY_MAX_LENGTH);

const nullableDate = z.string().refine(isDate).nullable();

// 作成（POST）と編集（PATCH）で同じ形を使い、編集でもすべての項目を送らせる。
// 変えた項目だけを受け付けると、開始日だけを変えたときに既存の終了日との前後をここで確かめられず、
// DB の CHECK 制約で弾かれて 500 になるため。空の開始日・終了日は null を明示して送る（送り忘れと区別するため）
export const announcementInputSchema = z
	.strictObject({
		// 連絡を書く開催日
		date: z.string().refine(isDate),
		body: announcementBody,
		displayFrom: nullableDate,
		displayUntil: nullableDate,
	})
	// YYYY-MM-DD は文字列のままで日付の順に比べられる。片方が空なら確かめない（DB の CHECK 制約と同じ範囲）
	.refine(
		({ displayFrom, displayUntil }) =>
			displayFrom === null ||
			displayUntil === null ||
			displayFrom <= displayUntil,
	);

// ?current（値なし）のときだけ受け付ける。値なしのクエリは空文字で渡る
export const currentAnnouncementsQuerySchema = z.object({
	current: z.literal(""),
});

export const announcementParamSchema = z.object({ id });
