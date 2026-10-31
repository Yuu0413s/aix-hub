import { NavLink, Outlet } from "react-router";
import { useMe } from "../../lib/auth-client";

// 管理画面のタブ。#12〜#14 の画面はここに足す
const ADMIN_TABS = [{ to: "/admin/days", label: "開催日の管理" }];

// 管理画面の共通部分（見出し・タブ）。admin 以外にはタブも中の画面も出さない。
// ヘッダーのリンクは admin にだけ出しているが、URL を直接開いたときのため。
// ヘッダーのリンクを出す条件（app-header.tsx の isAdmin）と同じ判定にする
export function AdminLayout() {
	const me = useMe();
	const isAdmin = me.role === "admin";

	return (
		<main className="mx-auto max-w-md p-4">
			<h1 className="text-xl font-bold">管理画面</h1>
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
					<Outlet />
				</>
			) : (
				<p role="alert" className="mt-4 text-sm text-red-700">
					この画面は管理者だけが見られます
				</p>
			)}
		</main>
	);
}
