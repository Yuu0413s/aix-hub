// 学会への参加の状態の一覧。DB の enum（worker/db/schema.ts）もここから作る（shared/grade.ts の GRADES と同じ理由）。
// 参加者一覧は enum の宣言の順を使って並べる（services/conference.ts）ため、
// 「検討中 → 投稿予定 → 投稿済み」の順を変えない
export const PARTICIPATION_STATUSES = [
	"considering",
	"planning",
	"submitted",
] as const;

export type ParticipationStatus = (typeof PARTICIPATION_STATUSES)[number];

export const PARTICIPATION_STATUS_LABELS: Record<ParticipationStatus, string> =
	{
		considering: "検討中",
		planning: "投稿予定",
		submitted: "投稿済み",
	};
