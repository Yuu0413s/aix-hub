import { Link } from "react-router";
import { TEXT_LINK_CLASS } from "./class-names";
import {
	type ConferenceListItem,
	formatDeadline,
	formatParticipants,
	formatSchedule,
} from "./conference-table";

// スマホ用のカード。表（conference-table.tsx）と同じ項目を、横に長くならないよう縦に並べる
export function ConferenceCard({
	conference,
}: {
	conference: ConferenceListItem;
}) {
	return (
		<Link
			to={`/conferences/${conference.id}`}
			className="block rounded border border-line p-3 hover:bg-surface-muted"
		>
			<p className="text-xs text-fg-muted">{conference.seriesName}</p>
			<p className={`break-all font-bold ${TEXT_LINK_CLASS}`}>
				{conference.title}
			</p>
			<dl className="mt-2 grid grid-cols-[4rem_1fr] gap-x-2 gap-y-1 text-sm">
				<dt className="text-fg-muted">締切</dt>
				<dd>{formatDeadline(conference)}</dd>
				<dt className="text-fg-muted">開催日</dt>
				<dd>{formatSchedule(conference)}</dd>
				<dt className="text-fg-muted">開催地</dt>
				<dd className="break-all">{conference.venue ?? "未定"}</dd>
				<dt className="text-fg-muted">参加者</dt>
				<dd className="break-all">{formatParticipants(conference)}</dd>
			</dl>
		</Link>
	);
}
