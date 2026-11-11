import { z } from "zod";
import { ANNOUNCEMENT_BODY_MAX_LENGTH } from "./announcement";
import {
	CONFERENCE_MULTI_LINE_MAX_LENGTH,
	CONFERENCE_SERIES_NAME_MAX_LENGTH,
	CONFERENCE_TITLE_MAX_LENGTH,
	CONFERENCE_URL_MAX_LENGTH,
	CONFERENCE_VENUE_MAX_LENGTH,
	isHttpUrl,
} from "./conference";
import { CONFERENCE_LIST_STATUSES } from "./conference-list-status";
import { isDate, isFriday, MONTH_PATTERN, TIME_PATTERN } from "./date";
import { GRADE_PROMOTION_PATHS, GRADES } from "./grade";
import { countCharacters, DISPLAY_NAME_MAX_LENGTH } from "./profile";
import { SLOT_KINDS } from "./schedule-template";
import { CLOSED_REASON_MAX_LENGTH } from "./seminar-day";
import { PRINTABLE_MULTI_LINE, PRINTABLE_SINGLE_LINE } from "./text";
import { USER_ROLES } from "./user-role";

// 予約者名として全員に表示されるため、見えない文字・書式文字などは受け付けない（PRINTABLE_SINGLE_LINE。拒否する文字は shared/text.ts）。
// そのあと、空白だけの名前は空とみなすため、前後の空白を取り除いてから長さを確かめる。
// 休止理由（closedReason）も、カレンダーに1行で全員に表示されるため同じ文字を拒否する
const displayName = z
	.string()
	.regex(PRINTABLE_SINGLE_LINE)
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

// 全体連絡の本文。複数行で書けるよう、改行とタブだけは許す（PRINTABLE_MULTI_LINE）
const announcementBody = z
	.string()
	.regex(PRINTABLE_MULTI_LINE)
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

// 管理者が休止・再開する日付。開催日は毎週金曜のため、金曜以外は受け付けない
export const adminDayParamSchema = z.object({
	date: z.string().refine((value) => isDate(value) && isFriday(value)),
});

const closedReason = z
	.string()
	.regex(PRINTABLE_SINGLE_LINE)
	.trim()
	.min(1)
	.refine((value) => countCharacters(value) <= CLOSED_REASON_MAX_LENGTH);

// 休止の理由は任意で、空なら null を明示して送る（キーの省略を許すと、送り忘れと「理由なし」を区別できないため）。
// 再開では理由を消すため、null だけを受け付ける（理由を送っても保存されないのに、保存されたと誤解させないため）
export const seminarDayStatusInputSchema = z.discriminatedUnion("status", [
	z.strictObject({
		status: z.literal("closed"),
		closedReason: closedReason.nullable(),
	}),
	z.strictObject({
		status: z.literal("open"),
		closedReason: z.null(),
	}),
]);

export const adminSlotParamSchema = z.object({ id });

const slotTime = z.string().regex(TIME_PATTERN);

// 枠の3項目（変更後の値と、変更前の値 previous の両方に使う）。時限（period）などの余計なキーは、黙って無視せず検証エラーにする。
// 変更後の値では、変わったと誤解させないため。previous では、比べていない項目を比べたと誤解させないため
const slotValues = z.strictObject({
	kind: z.enum(SLOT_KINDS),
	startTime: slotTime,
	endTime: slotTime,
});

// 枠の編集。全体連絡の編集と同じく、変えない項目も含めて3項目すべてを送らせる（開始と終了の前後をここで確かめられるように）。
// previous は画面で見ていた変更前の3項目。今の枠と違えば変えない（古い画面から、ほかの管理者の変更を黙って元に戻さないため）
export const slotInputSchema = z
	.strictObject({ ...slotValues.shape, previous: slotValues })
	// HH:MM は文字列のままで時刻の順に比べられる。DB の CHECK 制約（worker/db/schema.ts）と同じ条件
	.refine(({ startTime, endTime }) => startTime < endTime);

export const adminUserParamSchema = z.object({ id });

// 変えられるのは役割と、学年の無い人を student にするときの学年。ほかの余計なキーは、黙って無視せず検証エラーにする（変わったと誤解させないため）。
// 学年が要るかは今の学年で決まるためここでは確かめず、services/user.ts の updateUserRole で確かめる
export const userRoleInputSchema = z
	.strictObject({
		role: z.enum(USER_ROLES),
		grade: z.enum(GRADES).optional(),
	})
	.refine(({ role, grade }) => grade === undefined || role === "student");

// 学年更新の進路。誰の進路が要るかは今の学年で決まるためここでは確かめず、services/grade-promotion.ts で確かめる。
// 同じ人が2回あると、どちらの進路で更新するかが決まらないため受け付けない
export const gradePromotionInputSchema = z.strictObject({
	paths: z
		.array(
			z.strictObject({
				userId: id,
				path: z.enum(GRADE_PROMOTION_PATHS),
			}),
		)
		.refine(
			(paths) =>
				new Set(paths.map(({ userId }) => userId)).size === paths.length,
		),
});

// 学会の一覧のタブ（受付中 / 締切済み）。値が無いときも検証エラーにする（どちらのタブかを API が決めない）
export const conferencesQuerySchema = z.object({
	status: z.enum(CONFERENCE_LIST_STATUSES),
});

// 手で insert した学会も、id は英数字32文字で作る（db.md「主キー」）
export const conferenceParamSchema = z.object({ id });

// 学会の文字の項目。前後の空白を除いてから長さを確かめる（表示名と同じ）。
// 1行の項目（学会名・シリーズ名・開催地・URL）は画面に1行で出すため（URL は詳細だけ、ほかは一覧と詳細）、表示名と同じ文字を拒否する。
// 複数行の項目（締切の補足・開催日の補足・説明・メモ）は、全体連絡の本文と同じく改行とタブだけを許す
function conferenceText(pattern: RegExp, maxLength: number) {
	return z
		.string()
		.regex(pattern)
		.trim()
		.refine((value) => countCharacters(value) <= maxLength);
}

// 任意の項目は文字列で受け取り、空欄（前後の空白を除いて空）を空文字ではなく null にして保存する（2026-11-11, Issue #18 で決定）。
// 画面は入力欄の値（空欄なら ""）をそのまま送ればよく、null は受け付けない（全体連絡の空の日付は null で送らせるが、学会では "" にそろえた）。
// キーの省略も受け付けない（送り忘れと空欄を区別するため。こちらは全体連絡と同じ理由）
function emptyToNull(value: string) {
	return value === "" ? null : value;
}

// 任意の日付。日付の入力欄は空のとき "" を渡すため、"" を null にする
const optionalConferenceDate = z
	.string()
	.refine((value) => value === "" || isDate(value))
	.transform(emptyToNull);

// 複数行の項目（締切の補足・開催日の補足・説明・メモ）。改行とタブだけは許す
const optionalConferenceMultiLine = conferenceText(
	PRINTABLE_MULTI_LINE,
	CONFERENCE_MULTI_LINE_MAX_LENGTH,
).transform(emptyToNull);

// 学会の登録（POST）と編集（PATCH）で同じ形を使い、編集でもすべての項目を送らせる。
// 変えた項目だけを受け付けると、開始日だけを変えたときに既存の終了日との前後をここで確かめられず、
// DB の CHECK 制約で弾かれて 500 になるため（全体連絡と同じ理由）
export const conferenceInputSchema = z
	.strictObject({
		seriesId: id,
		title: conferenceText(
			PRINTABLE_SINGLE_LINE,
			CONFERENCE_TITLE_MAX_LENGTH,
		).min(1),
		venue: conferenceText(
			PRINTABLE_SINGLE_LINE,
			CONFERENCE_VENUE_MAX_LENGTH,
		).transform(emptyToNull),
		url: conferenceText(PRINTABLE_SINGLE_LINE, CONFERENCE_URL_MAX_LENGTH)
			.refine((value) => value === "" || isHttpUrl(value))
			.transform(emptyToNull),
		submissionDeadline: optionalConferenceDate,
		submissionNote: optionalConferenceMultiLine,
		startDate: optionalConferenceDate,
		endDate: optionalConferenceDate,
		scheduleNote: optionalConferenceMultiLine,
		description: optionalConferenceMultiLine,
		note: optionalConferenceMultiLine,
	})
	// YYYY-MM-DD は文字列のままで日付の順に比べられる。片方が空なら確かめない（DB の CHECK 制約と同じ範囲）
	.refine(
		({ startDate, endDate }) =>
			startDate === null || endDate === null || startDate <= endDate,
	);

export const conferenceSeriesInputSchema = z.strictObject({
	name: conferenceText(
		PRINTABLE_SINGLE_LINE,
		CONFERENCE_SERIES_NAME_MAX_LENGTH,
	).min(1),
});
