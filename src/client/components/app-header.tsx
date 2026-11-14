import { useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { authClient, useMe } from "../lib/auth-client";
import { Button } from "./button";

// ヘッダーのリンク。リンクが並ぶ所なので下線は付けず、開いている画面（NavLink が付ける aria-current="page"）を太字と本文の色で示す
const NAV_LINK_CLASS =
	"text-fg-muted hover:text-fg aria-[current=page]:font-bold aria-[current=page]:text-fg";

// ログインとプロフィール登録が要る画面に共通のヘッダー（main.tsx の親ルートで1回だけ置く）。
// ログアウトもここに置き、どの画面からでもログアウトできるようにする
export function AppHeader() {
	const me = useMe();
	// 発表回数は先生と管理者だけが全員分を見られる（API も student には 403 を返す）。
	// 画面（routes/stats.tsx の isStatsViewer）でも同じ判定で、student には一覧を出さない
	const isStatsViewer = me.role === "teacher" || me.role === "admin";
	// 管理画面は admin だけが使える（API も admin 以外には 403 を返す）。画面（routes/admin/layout.tsx）でも同じ判定にする
	const isAdmin = me.role === "admin";
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
		<header className="border-b border-line">
			{/* 表の画面（max-w-3xl）と幅をそろえる。ヘッダーはどの画面にも同じものが1つ出るため、広いほうに合わせる
			    （フォームの画面では、ヘッダーの左端が本文より左に出るが、画面ごとにヘッダーの幅が変わるよりよいため） */}
			<div className="mx-auto flex max-w-3xl items-center justify-between gap-4 p-4">
				{/* リンクが多くて幅が足りないときは、名前を折り返さず、右のリンクのほうを折り返す */}
				<Link to="/" className="shrink-0 font-bold whitespace-nowrap">
					1on2 予約
				</Link>
				{/* admin はリンクが多く、幅の狭いスマホでは1行に収まらないため、折り返せるようにする */}
				<nav className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-sm">
					{/* 開いている画面のリンクには NavLink が aria-current="page" を付けるため、それで太字にする */}
					{/* 学会は全員が見られる（API もログインだけを確かめる） */}
					<NavLink to="/conferences" className={NAV_LINK_CLASS}>
						学会
					</NavLink>
					{isStatsViewer && (
						<NavLink to="/stats" className={NAV_LINK_CLASS}>
							発表回数一覧
						</NavLink>
					)}
					{/* /admin/days などを開いている間も、NavLink は /admin のリンクを開いている画面として扱う */}
					{isAdmin && (
						<NavLink to="/admin" className={NAV_LINK_CLASS}>
							管理画面
						</NavLink>
					)}
					<NavLink to="/me" className={NAV_LINK_CLASS}>
						マイページ
					</NavLink>
					<Button type="button" variant="secondary" size="sm" onClick={signOut}>
						ログアウト
					</Button>
				</nav>
			</div>
			{isSignOutFailed && (
				<p
					role="alert"
					className="mx-auto max-w-3xl px-4 pb-2 text-sm text-danger"
				>
					ログアウトに失敗しました
				</p>
			)}
		</header>
	);
}
