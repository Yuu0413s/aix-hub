import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import type { ConferenceListStatus } from "../../../shared/conference-list-status";
import { ConferenceCard } from "../../components/conference-card";
import { ConferenceTable } from "../../components/conference-table";
import { ApiError, api, isRetryable, readErrorCode } from "../../lib/api";

// タブの名前と並び順の説明は、画面の中ではここにだけ書く（タブ名を変えたときに、空のときの文言などが古いまま残らないように）。
// 並び順そのものは services/conference.ts の conferenceListOrder で決めるため、並び順を変えたら orderNote も直す
// as const で長さを固定し、先頭のタブ（URL に無いときに出す受付中）が必ずあることを型に伝える
const CONFERENCE_TABS = [
	{
		status: "open",
		label: "受付中",
		orderNote: "締切が近い順です。締切が未定の学会は最後に並びます",
	},
	{ status: "closed", label: "締切済み", orderNote: "最近締め切った順です" },
] as const satisfies readonly {
	status: ConferenceListStatus;
	label: string;
	orderNote: string;
}[];

export function ConferencesPage() {
	// 選んでいるタブは URL に持つ（再読み込みや「戻る」でも、選んでいたタブのまま開くように）。
	// 無いときやタブに無い値のときは、最初のタブ（受付中）を表示する
	const [searchParams] = useSearchParams();
	const currentTab =
		CONFERENCE_TABS.find((tab) => tab.status === searchParams.get("status")) ??
		CONFERENCE_TABS[0];
	const status = currentTab.status;

	// タブごとに別のキーで取る。前のタブの結果を表示し続ける設定（placeholderData）は使わない
	// （読み込み中・失敗時に、前のタブの学会が今のタブの学会に見えないようにするため。home.tsx と同じ理由）
	const conferencesQuery = useQuery({
		queryKey: ["conferences", status],
		queryFn: async () => {
			const res = await api.api.conferences.$get({ query: { status } });
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`学会の一覧を取得できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return res.json();
		},
		retry: isRetryable,
	});
	const data = conferencesQuery.data;

	return (
		<main className="mx-auto max-w-md p-4">
			<h1 className="text-xl font-bold">学会</h1>

			<nav className="mt-3 flex gap-1 border-b border-gray-200 text-sm">
				{CONFERENCE_TABS.map((tab) => (
					<Link
						key={tab.status}
						to={`?status=${tab.status}`}
						aria-current={tab.status === status ? "page" : undefined}
						className="-mb-px border-b-2 border-transparent px-3 py-2 text-gray-600 aria-[current=page]:border-gray-800 aria-[current=page]:font-bold aria-[current=page]:text-gray-900"
					>
						{tab.label}
					</Link>
				))}
			</nav>

			<section className="mt-4">
				<p className="text-xs text-gray-600">{currentTab.orderNote}</p>

				{conferencesQuery.isPending && (
					<p className="mt-2 text-sm text-gray-600">読み込み中…</p>
				)}
				{conferencesQuery.isError && (
					<div role="alert" className="mt-2 text-sm text-red-700">
						学会の一覧を読み込めませんでした
						<button
							type="button"
							onClick={() => conferencesQuery.refetch()}
							className="ml-2 underline"
						>
							再読み込み
						</button>
					</div>
				)}

				{/* 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中は一覧を出さない（day.tsx と同じ理由） */}
				{data &&
					!conferencesQuery.isError &&
					(data.conferences.length === 0 ? (
						<p className="mt-2 text-sm text-gray-600">
							{currentTab.label}の学会はありません
						</p>
					) : (
						<>
							{/* PC（幅 768px 以上）は表、スマホはカード。画面の幅は #37 で整える */}
							<div className="mt-2 hidden md:block">
								<ConferenceTable conferences={data.conferences} />
							</div>
							<ul className="mt-2 flex flex-col gap-2 md:hidden">
								{data.conferences.map((conference) => (
									<li key={conference.id}>
										<ConferenceCard conference={conference} />
									</li>
								))}
							</ul>
						</>
					))}
			</section>
		</main>
	);
}
