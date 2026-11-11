import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { ConferenceForm } from "../../components/conference-form";
import {
	conferenceQueryErrorMessage,
	conferenceQueryOptions,
} from "../../lib/conference-query";

export function ConferenceEditPage() {
	// ルートの定義（/conferences/:id/edit）で必ず入るが、型の上では undefined がありうるため空文字にする（API が 400 を返す）
	const { id = "" } = useParams();
	const navigate = useNavigate();

	const conferenceQuery = useQuery({
		...conferenceQueryOptions(id),
		// 開いたときは、キャッシュが新しくても必ず取り直す。下の isFetchedHere はこの取り直しが終わるのを待つため、
		// 取り直しが走らないと「読み込み中…」のまま止まる（キャッシュの有効期間 staleTime を延ばしたときなど。
		// ただし staleTime を "static" にすると、"always" でも取り直さなくなる）
		refetchOnMount: "always",
		// 入力中に画面へ戻ってきたときに取り直さない。取り直しに失敗すると下の条件でフォームが消え、入力した内容が失われるため。
		// フォームは、この画面を開いてから最初に取れた値（isFetchedHere）で始め、そのあとの取り直しの結果では書き換えない（ConferenceForm の useState）
		// 通信が戻ったときの取り直しも同じ理由で止める。保存が 404 になったあとに取り直すと、404 でフォームが消えるためでもある
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const conference = conferenceQuery.data?.conference;
	// この画面を開いてからの取得が終わったか。詳細画面から来るとキャッシュがあり、すぐに表示できるが、裏で取り直している。
	// キャッシュの値でフォームを始めると、取り直しが失敗したときに入力ごとフォームが消え、
	// 新しい値が届いてもフォームは古い値のままで、その間のほかの人の変更を保存で上書きしてしまう。
	// そのため、取り直しが終わるまではフォームを出さない
	const isFetchedHere = conferenceQuery.isFetchedAfterMount;

	return (
		<main className="mx-auto max-w-md p-4">
			<Link
				to={`/conferences/${id}`}
				className="text-sm text-blue-700 underline"
			>
				← 学会の詳細
			</Link>
			<h1 className="mt-4 text-xl font-bold">学会を編集</h1>

			{/* isPending も見るのは、最初の取得が失敗したあとの「再読み込み」の間は、isFetchedHere が true のままのため */}
			{(conferenceQuery.isPending ||
				(!isFetchedHere && !conferenceQuery.isError)) && (
				<p className="mt-4 text-sm text-gray-600">読み込み中…</p>
			)}
			{conferenceQuery.isError && (
				<div role="alert" className="mt-4 text-sm text-red-700">
					{conferenceQueryErrorMessage(conferenceQuery.error) ?? (
						<>
							学会を読み込めませんでした
							<button
								type="button"
								onClick={() => conferenceQuery.refetch()}
								className="ml-2 underline"
							>
								再読み込み
							</button>
						</>
					)}
				</div>
			)}

			{/* 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中はフォームを出さない（detail.tsx と同じ理由）。
			    key に id を付け、別の学会の編集画面へ移ったときに、前の学会の入力が残らないようにする */}
			{conference && isFetchedHere && !conferenceQuery.isError && (
				<ConferenceForm
					key={conference.id}
					conference={conference}
					cancelTo={`/conferences/${id}`}
					// 「戻る」で保存済みのフォームに戻らないよう、履歴を置き換える
					onSaved={(conferenceId) =>
						navigate(`/conferences/${conferenceId}`, { replace: true })
					}
				/>
			)}
		</main>
	);
}
