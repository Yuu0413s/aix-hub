// 学年の一覧。DB の enum（worker/db/schema.ts）もここから作る。
// 画面でも使うため、DB のスキーマ側ではなくこちらに置く（画面のコードに Drizzle を取り込まないため）
export const GRADES = [
	"B1",
	"B2",
	"B3",
	"B4",
	"M1",
	"M2",
	"MIDS_B1",
	"MIDS_B2",
	"MIDS_B3",
	"MIDS_B4",
] as const;

export type Grade = (typeof GRADES)[number];

// 学年更新で進路を選ぶ人（B4・MIDS_B4・M2）の選択肢。continue の行き先は学年で決まる（GRADE_PROMOTION_RULES）。
// 行き先の学年を直接送らせないのは、B4 に「M2 のまま」を指定するような矛盾を、値の形の上で起こせなくするため
export const GRADE_PROMOTION_PATHS = ["graduate", "continue"] as const;

export type GradePromotionPath = (typeof GRADE_PROMOTION_PATHS)[number];

export type GradePromotionRule =
	| { kind: "automatic"; next: Grade }
	| { kind: "choice"; continueGrade: Grade };

// 学年更新の対応表。Record にして、学年を足したときの書き忘れを型チェックで見つける
export const GRADE_PROMOTION_RULES: Record<Grade, GradePromotionRule> = {
	B1: { kind: "automatic", next: "B2" },
	B2: { kind: "automatic", next: "B3" },
	B3: { kind: "automatic", next: "B4" },
	B4: { kind: "choice", continueGrade: "M1" },
	M1: { kind: "automatic", next: "M2" },
	M2: { kind: "choice", continueGrade: "M2" },
	MIDS_B1: { kind: "automatic", next: "MIDS_B2" },
	MIDS_B2: { kind: "automatic", next: "MIDS_B3" },
	MIDS_B3: { kind: "automatic", next: "MIDS_B4" },
	MIDS_B4: { kind: "choice", continueGrade: "M1" },
};

// MIDS_B3 → MIDS B3
export function formatGrade(grade: Grade): string {
	return grade.replace("_", " ");
}

// 予約者名などの表示（例: Shibata(B3)）。学年の無い教員は名前だけにする
export function formatDisplayName(
	displayName: string,
	grade: Grade | null,
): string {
	return grade === null ? displayName : `${displayName}(${formatGrade(grade)})`;
}
