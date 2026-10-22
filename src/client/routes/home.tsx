import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useLoaderData, useNavigate } from "react-router";
import { api } from "../lib/api";
import { authClient, type requireSessionLoader } from "../lib/auth-client";

export function HomePage() {
	const session = useLoaderData<typeof requireSessionLoader>();
	const navigate = useNavigate();
	const [signOutError, setSignOutError] = useState<string | null>(null);

	const health = useQuery({
		queryKey: ["health"],
		queryFn: async () => {
			const res = await api.api.health.$get();
			if (!res.ok) {
				throw new Error(`health check failed: ${res.status}`);
			}
			return res.json();
		},
	});

	async function signOut() {
		setSignOutError(null);
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
		setSignOutError("ログアウトに失敗しました");
	}

	return (
		<main className="mx-auto max-w-md p-4">
			<h1 className="text-xl font-bold">1on2 予約</h1>
			<p className="mt-2 text-sm text-gray-600">
				API:{" "}
				{health.isPending
					? "確認中…"
					: health.isError
						? "エラー"
						: health.data.status}
			</p>
			<p className="mt-2 text-sm text-gray-600">{session.user.email}</p>
			{signOutError && (
				<p role="alert" className="mt-2 text-sm text-red-700">
					{signOutError}
				</p>
			)}
			<button
				type="button"
				onClick={signOut}
				className="mt-4 rounded border border-gray-300 px-4 py-2 text-sm"
			>
				ログアウト
			</button>
		</main>
	);
}
