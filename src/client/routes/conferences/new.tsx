import { Link, useNavigate } from "react-router";
import { ConferenceForm } from "../../components/conference-form";

export function ConferenceNewPage() {
	const navigate = useNavigate();

	return (
		<main className="mx-auto max-w-md p-4">
			<Link to="/conferences" className="text-sm text-blue-700 underline">
				← 学会の一覧
			</Link>
			<h1 className="mt-4 text-xl font-bold">学会を登録</h1>
			<ConferenceForm
				conference={null}
				cancelTo="/conferences"
				// 「戻る」で入力済みのフォームに戻り、同じ学会をもう一度登録しようとしないよう、履歴を置き換える
				onSaved={(conferenceId) =>
					navigate(`/conferences/${conferenceId}`, { replace: true })
				}
			/>
		</main>
	);
}
