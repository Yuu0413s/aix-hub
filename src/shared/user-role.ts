// 役割の一覧。DB の enum（worker/db/schema.ts）もここから作る。
// 画面でも使うため、DB のスキーマ側ではなくこちらに置く（画面のコードに Drizzle を取り込まないため）
export const USER_ROLES = ["student", "teacher", "admin"] as const;

export type UserRole = (typeof USER_ROLES)[number];

// 予約できる役割。teacher は予約しない（設計メモ「役割」）
export const RESERVER_ROLES = [
	"student",
	"admin",
] as const satisfies readonly UserRole[];

export const USER_ROLE_LABELS = {
	student: "学生",
	teacher: "先生",
	admin: "管理者",
} as const satisfies Record<UserRole, string>;
