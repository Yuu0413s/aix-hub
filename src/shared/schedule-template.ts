// 枠の種類の一覧。DB の enum（worker/db/schema.ts）もここから作る。
// 画面でも使うため、DB のスキーマ側ではなくこちらに置く（画面のコードに Drizzle を取り込まないため）
// - unavailable（なし）は時間割には使わず、管理者が日ごとに枠を編集するときに使う
export const SLOT_KINDS = [
	"presentation",
	"break",
	"teacher_share",
	"unavailable",
] as const;

export type SlotKind = (typeof SLOT_KINDS)[number];

export type ScheduleTemplateSlot = {
	// 3〜6。表示時に 3rd などへ変換する
	period: number;
	startTime: string;
	endTime: string;
	kind: SlotKind;
};

// 毎週金曜の時間割。Cron が開催日を作るときに、この枠をそのまま作る。
// GAS の SCHEDULE（config.js）を移植し、時限を全枠に持たせた。
// 16:30〜17:00 だけは GAS から変えている（先生からの共有を 16:40 までにし、発表を 16:40 からにした）
export const SCHEDULE_TEMPLATE: readonly ScheduleTemplateSlot[] = [
	{ period: 3, startTime: "13:10", endTime: "13:30", kind: "teacher_share" },
	{ period: 3, startTime: "13:30", endTime: "13:50", kind: "presentation" },
	{ period: 3, startTime: "13:50", endTime: "14:00", kind: "break" },
	{ period: 3, startTime: "14:00", endTime: "14:20", kind: "presentation" },
	{ period: 3, startTime: "14:20", endTime: "14:30", kind: "break" },
	{ period: 3, startTime: "14:30", endTime: "14:50", kind: "presentation" },
	{ period: 3, startTime: "14:50", endTime: "15:00", kind: "break" },
	{ period: 4, startTime: "15:00", endTime: "15:20", kind: "presentation" },
	{ period: 4, startTime: "15:20", endTime: "15:30", kind: "break" },
	{ period: 4, startTime: "15:30", endTime: "15:50", kind: "presentation" },
	{ period: 4, startTime: "15:50", endTime: "16:00", kind: "break" },
	{ period: 4, startTime: "16:00", endTime: "16:20", kind: "presentation" },
	{ period: 4, startTime: "16:20", endTime: "16:30", kind: "break" },
	{ period: 4, startTime: "16:30", endTime: "16:40", kind: "teacher_share" },
	{ period: 5, startTime: "16:40", endTime: "17:00", kind: "presentation" },
	{ period: 5, startTime: "17:00", endTime: "17:10", kind: "break" },
	{ period: 5, startTime: "17:10", endTime: "17:30", kind: "presentation" },
	{ period: 5, startTime: "17:30", endTime: "17:40", kind: "break" },
	{ period: 5, startTime: "17:40", endTime: "18:00", kind: "presentation" },
	{ period: 5, startTime: "18:00", endTime: "18:10", kind: "break" },
	{ period: 5, startTime: "18:10", endTime: "18:30", kind: "presentation" },
	{ period: 5, startTime: "18:30", endTime: "18:40", kind: "break" },
	{ period: 6, startTime: "18:40", endTime: "19:00", kind: "presentation" },
	{ period: 6, startTime: "19:00", endTime: "19:10", kind: "break" },
	{ period: 6, startTime: "19:10", endTime: "19:30", kind: "presentation" },
	{ period: 6, startTime: "19:30", endTime: "19:40", kind: "break" },
	{ period: 6, startTime: "19:40", endTime: "20:00", kind: "presentation" },
	{ period: 6, startTime: "20:00", endTime: "20:10", kind: "break" },
	{ period: 6, startTime: "20:10", endTime: "20:30", kind: "presentation" },
];
