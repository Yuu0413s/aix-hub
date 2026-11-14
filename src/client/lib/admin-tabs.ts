// 管理画面のタブの一覧と、タブのリンクの見た目。管理画面（routes/admin/layout.tsx）と、admin のマイページ（routes/me.tsx）で共有する

// 管理画面のタブ。admin のマイページの「管理画面」タブも、このリンクを並べる（タブを足したときに、マイページの直し忘れが起きないように）
export const ADMIN_TABS = [
	{ to: "/admin/days", label: "開催日の管理" },
	{ to: "/admin/users", label: "利用者の管理" },
	{ to: "/admin/grade-promotion", label: "学年更新" },
];

// タブのリンクの見た目。選んでいるタブ（aria-current="page"）を太字と下線で示す。
// 管理画面の NavLink と、マイページの Link の両方に渡すため、関数ではなく文字列にする
export const TAB_LINK_CLASS =
	"-mb-px border-b-2 border-transparent px-3 py-2 text-gray-600 aria-[current=page]:border-gray-800 aria-[current=page]:font-bold aria-[current=page]:text-gray-900";
