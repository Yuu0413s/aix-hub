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
