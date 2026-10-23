import { Link, useParams } from "react-router";
import { isMonth } from "../../shared/date";

// 日別の枠の表は #6 で作る。それまでは、カレンダーから移動できることだけを確かめられるようにしておく
export function DayPage() {
	const { date } = useParams();
	// 見ていた月のカレンダーに戻す。URL の日付が不正なら、今月（トップの既定）に戻す
	const month = date?.slice(0, 7) ?? null;

	return (
		<main className="mx-auto max-w-md p-4">
			<h1 className="text-xl font-bold">{date}</h1>
			<p className="mt-2 text-sm text-gray-600">この日の枠の表は準備中です</p>
			<Link
				to={isMonth(month) ? `/?month=${month}` : "/"}
				className="mt-4 inline-block text-sm text-blue-700 underline"
			>
				カレンダーに戻る
			</Link>
		</main>
	);
}
