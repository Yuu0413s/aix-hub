// 管理画面のタブの一覧。管理画面（routes/admin/layout.tsx）と、admin のマイページ（routes/me.tsx）で共有する

// 管理画面のタブ。admin のマイページの「管理画面」タブも、このリンクを並べる（タブを足したときに、マイページの直し忘れが起きないように）
export const ADMIN_TABS = [
	{ to: "/admin/days", label: "開催日の管理" },
	{ to: "/admin/users", label: "利用者の管理" },
	{ to: "/admin/grade-promotion", label: "学年更新" },
];
