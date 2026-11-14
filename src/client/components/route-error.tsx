import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { Button } from "./button";

// loader（画面を出す前の自分の情報の取得など）や画面の描画が失敗したとき、
// どのルートにも当てはまらない URL を開いたときの画面（main.tsx のいちばん外のルートに置く）。
// 置かないと React Router 標準の英語のエラー画面になり、何をすればよいか分からないため、
// 読み込みや描画に失敗したときは再読み込みを、当てはまる画面が無いときはトップへの移動を促す。
// エラーの中身は利用者に見せても役に立たないため出さない
export function RouteError() {
	const error = useRouteError();

	// どのルートにも当てはまらない URL
	if (isRouteErrorResponse(error) && error.status === 404) {
		return (
			<main className="mx-auto max-w-md p-4">
				<p role="alert" className="text-sm">
					ページが見つかりません
				</p>
				<Link
					to="/"
					className="mt-4 inline-block text-sm text-accent underline"
				>
					トップに戻る
				</Link>
			</main>
		);
	}

	return (
		<main className="mx-auto max-w-md p-4">
			<p role="alert" className="text-sm text-danger">
				画面を読み込めませんでした。時間をおいて再読み込みしてください
			</p>
			<Button
				type="button"
				variant="secondary"
				// loader の失敗は通信の失敗・5xx がほとんどのため、ページごと読み込み直す
				// （描画の失敗は読み込み直しても直らないことがあるが、利用者にできることはほかに無いため同じボタンにする）
				onClick={() => window.location.reload()}
				className="mt-4"
			>
				再読み込み
			</Button>
		</main>
	);
}
