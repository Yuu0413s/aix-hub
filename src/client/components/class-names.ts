// 部品にするほどではないが、全画面で同じ見た目にそろえたいクラスの文字列（Issue #37）。
// 色は index.css の役割の名前で書き、ダークモードの切り替えはそちらに任せる

// 文字のリンクと、文字のリンクの見た目をしたボタン（「再読み込み」、日別の表の予約者のセルなど）。
// 下線を文字から少し離し、日本語の文字に重ならないようにする
export const TEXT_LINK_CLASS = "text-accent underline underline-offset-2";

// 画面の上にまとめて出す失敗の知らせ（ログイン・登録の画面）。ほかの表示が少ない画面で見落とさないよう、枠と背景で囲む。
// ボタンのすぐ近くに出す失敗は、近さで何の失敗か分かるため、囲まずに文字だけ（text-sm text-danger）にする
export const ERROR_BOX_CLASS =
	"rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger";
