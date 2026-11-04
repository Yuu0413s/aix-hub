import { useState } from "react";
import { NavLink, Outlet, useLocation, useOutletContext } from "react-router";
import { useMe } from "../../lib/auth-client";

// 管理画面のタブ。#14 の画面はここに足す
const ADMIN_TABS = [
	{ to: "/admin/days", label: "開催日の管理" },
	{ to: "/admin/users", label: "利用者の管理" },
];

type AdminOutletContext = {
	setResultMessage: (message: string | null) => void;
};

// 操作の結果の文言を、タブの画面の外（AdminLayout）に出す。自分の admin を外したときは、成功と同時にタブの画面が消えるため、
// 画面の中に持つと結果が見えなくなる
export function useSetAdminResultMessage() {
	return useOutletContext<AdminOutletContext>().setResultMessage;
}

// 管理画面の共通部分（見出し・タブ）。admin 以外にはタブも中の画面も出さない。
// ヘッダーのリンクは admin にだけ出しているが、URL を直接開いたときのため。
// ヘッダーのリンクを出す条件（app-header.tsx の isAdmin）と同じ判定にする
export function AdminLayout() {
	const me = useMe();
	const isAdmin = me.role === "admin";
	const { key: locationKey } = useLocation();
	const [resultMessage, setResultMessage] = useState<string | null>(null);
	// タブの画面を移ってもこの部品は作り直されないため、画面を移ったら結果の文言を消す（別の画面の操作の結果に見せないため）。
	// 描画中に前回の画面と比べて消す理由は app-header.tsx と同じ（useEffect だと古い文言が1回描画される）。
	// 自分の admin を外したときの取り直しでは URL が変わらないため、文言は残る
	const [previousLocationKey, setPreviousLocationKey] = useState(locationKey);
	if (locationKey !== previousLocationKey) {
		setPreviousLocationKey(locationKey);
		setResultMessage(null);
	}

	return (
		<main className="mx-auto max-w-md p-4">
			<h1 className="text-xl font-bold">管理画面</h1>
			{resultMessage && (
				<p role="status" className="mt-2 text-sm text-green-700">
					{resultMessage}
				</p>
			)}
			{isAdmin ? (
				<>
					<nav className="mt-3 flex gap-1 border-b border-gray-200 text-sm">
						{ADMIN_TABS.map((tab) => (
							<NavLink
								key={tab.to}
								to={tab.to}
								className="-mb-px border-b-2 border-transparent px-3 py-2 text-gray-600 aria-[current=page]:border-gray-800 aria-[current=page]:font-bold aria-[current=page]:text-gray-900"
							>
								{tab.label}
							</NavLink>
						))}
					</nav>
					<Outlet context={{ setResultMessage } satisfies AdminOutletContext} />
				</>
			) : (
				<p role="alert" className="mt-4 text-sm text-red-700">
					この画面は管理者だけが見られます
				</p>
			)}
		</main>
	);
}
