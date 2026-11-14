import type { ComponentProps } from "react";
import { Link } from "react-router";

// ボタンの種類。主な操作（青で塗る）・通常の操作（グレーの枠線）・危険な操作（赤の枠線と文字）の3つにそろえる（Issue #37）
type ButtonVariant = "primary" | "secondary" | "danger";
// md はふつうのボタン、sm は表の中や一覧の行など、狭い所に置くボタン
type ButtonSize = "md" | "sm";

// 押せないボタンは、ポインターの反応（hover の色の変化）も止める。押しても何も起きないのに、押せそうに見せないため
const BASE_CLASS =
	"rounded border text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
	primary: "border-accent bg-accent text-on-accent hover:bg-accent/90",
	secondary: "border-line bg-surface text-fg hover:bg-surface-muted",
	danger: "border-danger/40 bg-surface text-danger hover:bg-danger/10",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
	md: "px-3 py-2 text-sm",
	sm: "px-2 py-1 text-xs",
};

function buttonClass(
	variant: ButtonVariant,
	size: ButtonSize,
	className: string | undefined,
) {
	return [BASE_CLASS, VARIANT_CLASS[variant], SIZE_CLASS[size], className]
		.filter(Boolean)
		.join(" ");
}

// 見た目のための部品で、処理は変えない。onClick・disabled・aria-* などは、そのまま <button> に渡す。
// className は、置く場所に合わせた余白や幅（mt-4・w-full・shrink-0 など）を足すためだけに使う。色や大きさは variant と size で決める
export function Button({
	variant,
	size = "md",
	type,
	className,
	...props
}: ComponentProps<"button"> & {
	variant: ButtonVariant;
	size?: ButtonSize;
	// HTML では type を省くとフォームの送信ボタンになるため、呼ぶ側で必ず書かせる
	type: "button" | "submit";
}) {
	return (
		<button
			{...props}
			type={type}
			className={buttonClass(variant, size, className)}
		/>
	);
}

// ボタンの見た目をしたリンク。<button> にすると URL を持たなくなり、画面の移り方が変わるため、中身は Link のままにする
export function ButtonLink({
	variant,
	size = "md",
	className,
	...props
}: ComponentProps<typeof Link> & {
	variant: ButtonVariant;
	size?: ButtonSize;
}) {
	return (
		<Link
			{...props}
			className={`inline-block ${buttonClass(variant, size, className)}`}
		/>
	);
}
