import { Link, useParams } from "react-router";

// 日別の枠の表は #6 で作る。それまでは、カレンダーから移動できることだけを確かめられるようにしておく
export function DayPage() {
	const { date } = useParams();

	return (
		<main className="mx-auto max-w-md p-4">
			<h1 className="text-xl font-bold">{date}</h1>
			<p className="mt-2 text-sm text-gray-600">この日の枠の表は準備中です</p>
			<Link
				to="/"
				className="mt-4 inline-block text-sm text-blue-700 underline"
			>
				カレンダーに戻る
			</Link>
		</main>
	);
}
