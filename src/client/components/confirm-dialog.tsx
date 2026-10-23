import { useEffect, useRef } from "react";

// 「はい／いいえ」で確かめるダイアログ。ブラウザ標準の <dialog> を使う（設計メモ「画面」）。
// showModal() で開くと、背景の操作を止め、Esc で閉じられ、フォーカスもダイアログの中に移る
export function ConfirmDialog({
	isOpen,
	message,
	isPending,
	errorMessage,
	isRetryable,
	onConfirm,
	onClose,
}: {
	isOpen: boolean;
	message: string;
	isPending: boolean;
	// 送信に失敗したときの文言。null なら出さない
	errorMessage: string | null;
	// 失敗したあとに「はい」でもう一度送れるか。送り直しても結果が変わらない失敗（枠が埋まったなど）では false にする
	isRetryable: boolean;
	onConfirm: () => void;
	onClose: () => void;
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

	const isConfirmable = errorMessage === null || isRetryable;

	return (
		<dialog
			ref={dialogRef}
			// Esc で閉じたときも、親の状態（どの枠のダイアログか）を消す
			onClose={onClose}
			// 送信中に Esc で閉じると、結果が出る前にダイアログが消えて、成功したのか分からなくなるため止める。
			// cancel を止めるだけだと、Chrome では間に操作を挟まずに続けて押した2回目の Esc を止められない
			// （ページが閉じさせないようにし続けるのを防ぐ仕組み）ため、キーを押した時点でも止める（不確か: ブラウザの実装による）
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
			className="m-auto w-[min(90vw,24rem)] rounded p-4 shadow-lg backdrop:bg-black/40"
		>
			<p className="text-sm">{message}</p>
			{errorMessage && (
				<p role="alert" className="mt-3 text-sm text-red-700">
					{errorMessage}
				</p>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					onClick={onClose}
					disabled={isPending}
					className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
				>
					{isConfirmable ? "いいえ" : "閉じる"}
				</button>
				{isConfirmable && (
					<button
						type="button"
						onClick={onConfirm}
						disabled={isPending}
						className="rounded bg-blue-700 px-3 py-1 text-sm text-white disabled:opacity-50"
					>
						{isPending ? "送信中…" : "はい"}
					</button>
				)}
			</div>
		</dialog>
	);
}
