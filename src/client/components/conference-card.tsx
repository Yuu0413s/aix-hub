import { Link } from "react-router";
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
			className="block rounded border border-gray-300 p-3"
		>
			<p className="text-xs text-gray-600">{conference.seriesName}</p>
			<p className="break-all font-bold text-blue-700 underline">
				{conference.title}
			</p>
			<dl className="mt-2 grid grid-cols-[4rem_1fr] gap-x-2 gap-y-1 text-sm">
				<dt className="text-gray-600">締切</dt>
				<dd>{formatDeadline(conference)}</dd>
				<dt className="text-gray-600">開催日</dt>
				<dd>{formatSchedule(conference)}</dd>
				<dt className="text-gray-600">開催地</dt>
				<dd className="break-all">{conference.venue ?? "未定"}</dd>
				<dt className="text-gray-600">参加者</dt>
				<dd className="break-all">{formatParticipants(conference)}</dd>
			</dl>
		</Link>
	);
}
