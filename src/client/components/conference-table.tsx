import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { PARTICIPATION_STATUS_LABELS } from "../../shared/participation-status";
import type { api } from "../lib/api";
import { formatDateRange, formatDateWithYear } from "../lib/format-date";

// 一覧の1件分の形は、GET /api/conferences の成功時のレスポンスの型から作る（手で書くと、API を変えたときに食い違うため）
export type ConferenceListItem = InferResponseType<
	typeof api.api.conferences.$get,
	200
>["conferences"][number];

// 締切と開催日は、空欄なら「未定」と出す（補足の文は一覧には出さず、詳細で出す）
export function formatDeadline(conference: ConferenceListItem) {
	return conference.submissionDeadline === null
		? "未定"
		: formatDateWithYear(conference.submissionDeadline);
}

export function formatSchedule(conference: ConferenceListItem) {
	return formatDateRange(conference.startDate, conference.endDate) ?? "未定";
}

// 参加者は「Shibata（投稿予定）」の形で並べる。表示名が無い人（手で insert した行など）は名前の代わりに出す
export function formatParticipants(conference: ConferenceListItem) {
	if (conference.participants.length === 0) {
		return "なし";
	}
	return conference.participants
		.map(
			(participant) =>
				`${participant.displayName ?? "（名前未登録）"}（${PARTICIPATION_STATUS_LABELS[participant.status]}）`,
		)
		.join("、");
}

const HEAD_CELL = "border border-gray-300 px-2 py-1 text-left";
const CELL = "break-all border border-gray-300 px-2 py-1 align-top";

// PC 用の表。スマホではカード（conference-card.tsx）を出す（切り替えは routes/conferences/index.tsx）
export function ConferenceTable({
	conferences,
}: {
	conferences: ConferenceListItem[];
}) {
	return (
		<table className="w-full border-collapse text-sm">
			<thead>
				<tr>
					<th scope="col" className={HEAD_CELL}>
						学会名
					</th>
					<th scope="col" className={HEAD_CELL}>
						シリーズ
					</th>
					<th scope="col" className={HEAD_CELL}>
						締切
					</th>
					<th scope="col" className={HEAD_CELL}>
						開催日
					</th>
					<th scope="col" className={HEAD_CELL}>
						開催地
					</th>
					<th scope="col" className={HEAD_CELL}>
						参加者
					</th>
				</tr>
			</thead>
			<tbody>
				{conferences.map((conference) => (
					<tr key={conference.id}>
						<td className={CELL}>
							<Link
								to={`/conferences/${conference.id}`}
								className="text-blue-700 underline"
							>
								{conference.title}
							</Link>
						</td>
						<td className={CELL}>{conference.seriesName}</td>
						<td className={CELL}>{formatDeadline(conference)}</td>
						<td className={CELL}>{formatSchedule(conference)}</td>
						<td className={CELL}>{conference.venue ?? "未定"}</td>
						<td className={CELL}>{formatParticipants(conference)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
