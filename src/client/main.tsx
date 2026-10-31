import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Outlet, redirect } from "react-router";
import { RouterProvider } from "react-router/dom";
import { AppHeader } from "./components/app-header";
import { RouteError } from "./components/route-error";
import "./index.css";
import {
	PROFILE_REQUIRED_ROUTE_ID,
	redirectIfProfileRegisteredLoader,
	redirectIfSignedInLoader,
	requireProfileLoader,
} from "./lib/auth-client";
import { AdminDaysPage } from "./routes/admin/days";
import { AdminLayout } from "./routes/admin/layout";
import { DayPage } from "./routes/day";
import { HomePage } from "./routes/home";
import { LoginPage } from "./routes/login";
import { MePage } from "./routes/me";
import { OnboardingPage } from "./routes/onboarding";
import { StatsPage } from "./routes/stats";

const queryClient = new QueryClient();

const router = createBrowserRouter([
	// すべての画面を包み、loader や描画の失敗と、どのルートにも当てはまらない URL をここで受ける（子のルートで失敗しても、どの画面でも同じ表示にするため）
	{
		errorElement: <RouteError />,
		children: [
			// ログインとプロフィール登録が要る画面。確認とヘッダーを親に1回だけ置き、画面を足したときの付け忘れを防ぐ
			{
				id: PROFILE_REQUIRED_ROUTE_ID,
				loader: requireProfileLoader,
				element: (
					<>
						<AppHeader />
						<Outlet />
					</>
				),
				children: [
					{ path: "/", element: <HomePage /> },
					{ path: "/days/:date", element: <DayPage /> },
					{ path: "/me", element: <MePage /> },
					{ path: "/stats", element: <StatsPage /> },
					// 管理画面。admin かどうかはタブと一緒に親（AdminLayout）で1回だけ確かめ、タブを足したときの付け忘れを防ぐ
					{
						path: "/admin",
						element: <AdminLayout />,
						children: [
							// 管理画面の入口は、いまは開催日の管理だけのため、そこへ移す
							{ index: true, loader: () => redirect("/admin/days") },
							{ path: "days", element: <AdminDaysPage /> },
						],
					},
				],
			},
			{
				path: "/login",
				element: <LoginPage />,
				loader: redirectIfSignedInLoader,
			},
			{
				path: "/onboarding",
				element: <OnboardingPage />,
				loader: redirectIfProfileRegisteredLoader,
			},
		],
	},
]);

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("#root が見つかりません");
}

createRoot(rootElement).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
);
