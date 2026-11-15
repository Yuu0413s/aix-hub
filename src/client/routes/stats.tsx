import { useQuery } from "@tanstack/react-query";
import { API_ERROR_CODES } from "../../shared/api-errors";
import { formatDisplayName } from "../../shared/grade";
import { TEXT_LINK_CLASS } from "../components/class-names";
import { ApiError, api, isRetryable, readErrorCode } from "../lib/api";
import { useMe } from "../lib/auth-client";

const FORBIDDEN_MESSAGE = "この画面は先生と管理者だけが見られます";

export function StatsPage() {
	const me = useMe();
	// student にはヘッダーのリンクを出していないが、URL を直接開いたときのため。API も 403 を返すため、取得もしない。
	// ヘッダーのリンクを出す条件（app-header.tsx の isStatsViewer）と同じ判定にする
	const isStatsViewer = me.role === "teacher" || me.role === "admin";

	// 表の画面なので、PC ではほかの画面より広げる（Issue #37）
	return (
		<main className="mx-auto max-w-3xl p-4">
			<h1 className="text-xl font-bold">発表回数一覧</h1>
			{isStatsViewer ? (
				<PresentationStats />
			) : (
				<p role="alert" className="mt-4 text-sm text-danger">
					{FORBIDDEN_MESSAGE}
				</p>
			)}
		</main>
	);
}

function PresentationStats() {
	const statsQuery = useQuery({
		queryKey: ["stats", "presentations"],
		queryFn: async () => {
			const res = await api.api.stats.presentations.$get();
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`発表回数を取得できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return res.json();
		},
		retry: isRetryable,
	});
	const data = statsQuery.data;
	// 画面を開いた後に役割が変わったとき（loader の自分の情報は古いまま）は、API の 403 で分かる
	const isForbidden =
		statsQuery.error instanceof ApiError &&
		statsQuery.error.code === API_ERROR_CODES.FORBIDDEN;

	return (
		<section className="mt-4">
			<p className="text-xs text-fg-muted">
				回数は実施済み（済）の予約の数です。当日の発表は翌日に反映されます
			</p>

			{statsQuery.isPending && (
				<p className="mt-2 text-sm text-fg-muted">読み込み中…</p>
			)}
			{isForbidden && (
				<p role="alert" className="mt-2 text-sm text-danger">
					{FORBIDDEN_MESSAGE}
				</p>
			)}
			{statsQuery.isError && !isForbidden && (
				<div role="alert" className="mt-2 text-sm text-danger">
					発表回数を読み込めませんでした
					<button
						type="button"
						onClick={() => statsQuery.refetch()}
						className={`ml-2 ${TEXT_LINK_CLASS}`}
					>
						再読み込み
					</button>
				</div>
			)}

			{/* 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中は一覧を出さない（day.tsx と同じ理由） */}
			{data &&
				!statsQuery.isError &&
				(data.users.length === 0 ? (
					<p className="mt-2 text-sm text-fg-muted">
						一覧に載せる人がいません（在籍中の学生・管理者のみ載せます）
					</p>
				) : (
					<table className="mt-2 w-full border-collapse text-sm">
						<thead>
							{/* 見出しの行は、日別の表と同じく薄い背景で本文の行と分ける */}
							<tr className="bg-surface-muted text-xs text-fg-muted">
								<th
									scope="col"
									className="border border-line px-2 py-1 text-left"
								>
									名前
								</th>
								<th
									scope="col"
									className="w-24 border border-line px-2 py-1 text-right"
								>
									発表回数
								</th>
							</tr>
						</thead>
						<tbody>
							{data.users.map((user) => (
								<tr key={user.id}>
									<td className="break-all border border-line px-2 py-1">
										{formatDisplayName(user.displayName, user.grade)}
									</td>
									<td className="border border-line px-2 py-1 text-right">
										{user.presentationCount}回
									</td>
								</tr>
							))}
						</tbody>
					</table>
				))}
		</section>
	);
}
