import { useEffect, useRef } from "react";
import { Button } from "./button";

// 「はい／いいえ」で確かめるダイアログ。ブラウザ標準の <dialog> を使う（設計メモ「画面」）。
// showModal() で開くと、背景の操作を止め、Esc で閉じられ、フォーカスもダイアログの中に移る
export function ConfirmDialog({
	isOpen,
	message,
	isPending,
	errorMessage,
	isResendable,
	onConfirm,
	onClose,
	confirmVariant = "primary",
}: {
	isOpen: boolean;
	message: string;
	isPending: boolean;
	// 送信に失敗したときの文言。null なら出さない
	errorMessage: string | null;
	// 失敗したあとに「はい」でもう一度送れるか。送り直しても結果が変わらない失敗（枠が埋まったなど）では false にする
	isResendable: boolean;
	onConfirm: () => void;
	onClose: () => void;
	// 「はい」の見た目。取り消しや削除のように元に戻せない操作では "danger" にし、押す前に危険な操作だと気づけるようにする
	confirmVariant?: "primary" | "danger";
}) {
	const dialogRef = useRef<HTMLDialogElement>(null);

	// <dialog> の open 属性を React で切り替えると、モーダルにならない（背景を操作できてしまう）ため、
	// showModal() / close() を呼んで開け閉めする
	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) {
			return;
		}
		if (isOpen && !dialog.open) {
			dialog.showModal();
		}
		if (!isOpen && dialog.open) {
			dialog.close();
		}
	}, [isOpen]);

	const isConfirmable = errorMessage === null || isResendable;

	return (
		<dialog
			ref={dialogRef}
			// Esc で閉じたときも、親の状態（どの枠のダイアログか）を消す
			onClose={onClose}
			// 送信中に Esc で閉じると、結果が出る前にダイアログが消えて、成功したのか分からなくなるため止める。
			// cancel を止めるだけだと、Chrome では操作を挟まずに続けて押した2回目の Esc は止められない
			// （ページがいつまでも閉じさせないことを防ぐ、ブラウザ側の仕組み）。そのため、キーを押した時点でも止める（不確か: ブラウザの実装による）。
			// onCancel も残すのは、Esc キー以外の閉じる操作（Android の戻るなど）も止めるため
			onKeyDown={(event) => {
				if (isPending && event.key === "Escape") {
					event.preventDefault();
				}
			}}
			onCancel={(event) => {
				if (isPending) {
					event.preventDefault();
				}
			}}
			// <dialog> にはブラウザが白い背景と黒い文字を付けるため、ダークモードでも読めるよう色をはっきり指定する
			className="m-auto w-[min(90vw,24rem)] rounded border border-line bg-surface p-4 text-fg shadow-lg backdrop:bg-black/40"
		>
			<p className="text-sm">{message}</p>
			{errorMessage && (
				<p role="alert" className="mt-3 text-sm text-danger">
					{errorMessage}
				</p>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<Button
					type="button"
					variant="secondary"
					onClick={onClose}
					disabled={isPending}
				>
					{isConfirmable ? "いいえ" : "閉じる"}
				</Button>
				{isConfirmable && (
					<Button
						type="button"
						variant={confirmVariant}
						onClick={onConfirm}
						disabled={isPending}
					>
						{isPending ? "送信中…" : "はい"}
					</Button>
				)}
			</div>
		</dialog>
	);
}
