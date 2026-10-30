import { useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { authClient, useMe } from "../lib/auth-client";

// ログインとプロフィール登録が要る画面に共通のヘッダー（main.tsx の親ルートで1回だけ置く）。
// ログアウトもここに置き、どの画面からでもログアウトできるようにする
export function AppHeader() {
	const me = useMe();
	// 発表回数は先生と管理者だけが全員分を見られる（API も student には 403 を返す）
	const isStatsViewer = me.role === "teacher" || me.role === "admin";
	const navigate = useNavigate();
	const { key: locationKey } = useLocation();
	const [isSignOutFailed, setIsSignOutFailed] = useState(false);
	// ヘッダーは画面を移っても作り直されないため、画面を移ったら失敗の文言を消す
	// （別の画面に移ったあとも、過去の失敗を今の失敗のように見せ続けないため）。
	// 「失敗した画面」を覚えて比べる方法だと、同じ画面に戻ったときにまた出てしまうため、移った時点で消す。
	// useEffect で消すと、移った直後の1回だけ古い文言が描画されるため、描画中に前回の画面と比べて消す。
	// React 公式ドキュメント「You Might Not Need an Effect」の「Adjusting some state when a prop changes」の書き方で、
	// 分かりにくいため多用は勧められていないが、useEffect で消すよりは良いとされている
	const [previousLocationKey, setPreviousLocationKey] = useState(locationKey);
	if (locationKey !== previousLocationKey) {
		setPreviousLocationKey(locationKey);
		setIsSignOutFailed(false);
	}

	async function signOut() {
		setIsSignOutFailed(false);
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
		setIsSignOutFailed(true);
	}

	return (
		<header className="border-b border-gray-200">
			<div className="mx-auto flex max-w-md items-center justify-between p-4">
				<Link to="/" className="font-bold">
					1on2 予約
				</Link>
				<nav className="flex items-center gap-3 text-sm">
					{/* 開いている画面のリンクには NavLink が aria-current="page" を付けるため、それで太字にする */}
					{isStatsViewer && (
						<NavLink
							to="/stats"
							className="text-blue-700 underline aria-[current=page]:font-bold"
						>
							発表回数一覧
						</NavLink>
					)}
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
