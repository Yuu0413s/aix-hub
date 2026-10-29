import { useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { authClient } from "../lib/auth-client";

// ログインとプロフィール登録が要る画面に共通のヘッダー（main.tsx の親ルートで1回だけ置く）。
// ログアウトもここに置き、どの画面からでもログアウトできるようにする
export function AppHeader() {
	const navigate = useNavigate();
	const { pathname } = useLocation();
	// ログアウトに失敗した画面。ヘッダーは画面を移っても作り直されないため、失敗の文言は失敗した画面でだけ出す
	// （別の画面に移ったあとも、過去の失敗を今の失敗のように見せ続けないため）
	const [signOutFailedPathname, setSignOutFailedPathname] = useState<
		string | null
	>(null);
	const isSignOutFailed = signOutFailedPathname === pathname;

	async function signOut() {
		setSignOutFailedPathname(null);
		// better-auth のクライアントは、サーバーがエラーを返したときは { error } を返し、
		// 通信そのものが失敗したときは例外を投げるため、両方を受ける
		try {
			const { error } = await authClient.signOut();
			if (!error) {
				navigate("/login");
				return;
			}
		} catch {
			// 下でまとめて表示する
		}
		setSignOutFailedPathname(pathname);
	}

	return (
		<header className="border-b border-gray-200">
			<div className="mx-auto flex max-w-md items-center justify-between p-4">
				<Link to="/" className="font-bold">
					1on2 予約
				</Link>
				<nav className="flex items-center gap-3 text-sm">
					{/* 開いている画面のリンクには NavLink が aria-current="page" を付けるため、それで太字にする */}
					<NavLink
						to="/me"
						className="text-blue-700 underline aria-[current=page]:font-bold"
					>
						マイページ
					</NavLink>
					<button
						type="button"
						onClick={signOut}
						className="rounded border border-gray-300 px-2 py-1"
					>
						ログアウト
					</button>
				</nav>
			</div>
			{isSignOutFailed && (
				<p
					role="alert"
					className="mx-auto max-w-md px-4 pb-2 text-sm text-red-700"
				>
					ログアウトに失敗しました
				</p>
			)}
		</header>
	);
}
