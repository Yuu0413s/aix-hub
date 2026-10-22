import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { ALLOWED_EMAIL_DOMAINS, AUTH_ERROR_CODES } from "../../shared/auth";
import { authClient } from "../lib/auth-client";

// better-auth はログインを拒否すると /login?error=<コード> に戻す。
// EMAIL_NOT_VERIFIED は大学のアカウントではまず起きないため、専用の文言を用意せず既定の文言にしている
const ERROR_MESSAGES: Record<string, string> = {
	[AUTH_ERROR_CODES.DOMAIN_NOT_ALLOWED]: `大学の Google アカウント（${ALLOWED_EMAIL_DOMAINS.map((domain) => `@${domain}`).join(" / ")}）でログインしてください`,
};
const DEFAULT_ERROR_MESSAGE = "ログインに失敗しました";

export function LoginPage() {
	const [searchParams] = useSearchParams();
	const errorCode = searchParams.get("error");
	const [isRedirecting, setIsRedirecting] = useState(false);
	const [signInError, setSignInError] = useState<string | null>(null);

	// Google の画面からブラウザの「戻る」で戻ると、移動前のページがそのまま復元され、
	// ボタンが「移動中…」のまま押せなくなるため、復元されたときに戻す
	useEffect(() => {
		function handlePageShow(event: PageTransitionEvent) {
			if (event.persisted) {
				setIsRedirecting(false);
			}
		}
		window.addEventListener("pageshow", handlePageShow);
		return () => window.removeEventListener("pageshow", handlePageShow);
	}, []);

	async function signIn() {
		setIsRedirecting(true);
		setSignInError(null);
		// better-auth のクライアントは、サーバーがエラーを返したときは { error } を返し、
		// 通信そのものが失敗したときは例外を投げるため、両方を受ける
		try {
			const { error } = await authClient.signIn.social({
				provider: "google",
				callbackURL: "/",
				errorCallbackURL: "/login",
			});
			// 成功すると Google の画面に移動するため、ここで止まるのは移動できなかったときだけ
			if (!error) {
				return;
			}
		} catch {
			// 下でまとめて表示する
		}
		setSignInError(DEFAULT_ERROR_MESSAGE);
		setIsRedirecting(false);
	}

	const errorMessage =
		signInError ??
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
