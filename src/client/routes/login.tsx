import { useState } from "react";
import { useSearchParams } from "react-router";
import { authClient } from "../lib/auth-client";

// better-auth はログインを拒否すると /login?error=<コード> に戻す。コードは worker/auth.ts の validateUserInfo で決めている
const ERROR_MESSAGES: Record<string, string> = {
	DOMAIN_NOT_ALLOWED:
		"大学の Google アカウント（@stu / @ds / @musashino-u.ac.jp）でログインしてください",
};
const DEFAULT_ERROR_MESSAGE = "ログインに失敗しました";

export function LoginPage() {
	const [searchParams] = useSearchParams();
	const errorCode = searchParams.get("error");
	const [isRedirecting, setIsRedirecting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);

	async function signIn() {
		setIsRedirecting(true);
		setStartError(null);
		// 成功すると Google の画面に移動するため、ここに戻ってくるのは移動できなかったときだけ
		const { error } = await authClient.signIn.social({
			provider: "google",
			callbackURL: "/",
			errorCallbackURL: "/login",
		});
		if (error) {
			setStartError(DEFAULT_ERROR_MESSAGE);
			setIsRedirecting(false);
		}
	}

	const errorMessage =
		startError ??
		(errorCode ? (ERROR_MESSAGES[errorCode] ?? DEFAULT_ERROR_MESSAGE) : null);

	return (
		<main className="mx-auto max-w-md p-4">
			<h1 className="text-xl font-bold">1on2 予約</h1>
			{errorMessage && (
				<p
					role="alert"
					className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
				>
					{errorMessage}
				</p>
			)}
			<button
				type="button"
				onClick={signIn}
				disabled={isRedirecting}
				className="mt-6 w-full rounded bg-blue-600 px-4 py-2 font-bold text-white disabled:opacity-50"
			>
				{isRedirecting ? "移動中…" : "Google でログイン"}
			</button>
		</main>
	);
}
