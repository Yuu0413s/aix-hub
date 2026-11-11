import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useState } from "react";
import { CONFERENCE_SERIES_NAME_MAX_LENGTH } from "../../shared/conference";
import { countCharacters } from "../../shared/profile";
import { ApiError, api, isRetryable, readErrorCode } from "../lib/api";
import { conferenceErrorMessage } from "../lib/conference-error";

type Series = { id: string; name: string };

const SERIES_QUERY_KEY = ["conference-series"];

// シリーズのプルダウンと「＋ 新しいシリーズ」。新しいシリーズは「作成」を押した時点で作り、選んだ状態にする。
// 学会の登録をやめると、学会が1つも無いシリーズが残るが許容する（設計メモ「API 設計」）
export function SeriesSelect({
	id,
	value,
	onChange,
	disabled,
}: {
	// label と結ぶ、プルダウンの id
	id: string;
	// 選んでいるシリーズの id。選んでいなければ ""
	value: string;
	onChange: (seriesId: string) => void;
	disabled: boolean;
}) {
	const seriesQuery = useQuery({
		queryKey: SERIES_QUERY_KEY,
		queryFn: async () => {
			const res = await api.api["conference-series"].$get();
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`シリーズを取得できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return res.json();
		},
		retry: isRetryable,
	});

	const [isCreating, setIsCreating] = useState(false);
	const [name, setName] = useState("");

	const queryClient = useQueryClient();
	const createMutation = useMutation({
		mutationFn: async () => {
			const res = await api.api["conference-series"].$post({ json: { name } });
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`シリーズを作成できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return (await res.json()).series;
		},
		onSuccess: (series) => {
			// 取り直しを待たずにプルダウンへ加えてから選ぶ。取り直しが失敗しても、選んだシリーズがプルダウンに無い
			// （見えている選択と送る id が食い違う）状態にならないようにするため。並び順は取り直しで API の順に戻る
			queryClient.setQueryData<{ series: Series[] }>(
				SERIES_QUERY_KEY,
				(current) => current && { series: [...current.series, series] },
			);
			queryClient.invalidateQueries({ queryKey: SERIES_QUERY_KEY });
			onChange(series.id);
			setIsCreating(false);
			setName("");
		},
	});

	const trimmedName = name.trim();
	const isNameTooLong =
		countCharacters(trimmedName) > CONFERENCE_SERIES_NAME_MAX_LENGTH;
	const isCreatable =
		trimmedName !== "" && !isNameTooLong && !createMutation.isPending;

	function create() {
		if (isCreatable) {
			createMutation.mutate();
		}
	}

	// この入力欄は学会のフォームの中にあるため、Enter で学会の登録が送られないよう止め、シリーズの作成にする
	function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "Enter" && !event.nativeEvent.isComposing) {
			event.preventDefault();
			create();
		}
	}

	const seriesList = seriesQuery.data?.series ?? [];

	return (
		<div>
			{seriesQuery.isPending && (
				<p className="mt-1 text-sm text-gray-600">読み込み中…</p>
			)}
			{seriesQuery.isError && (
				<div role="alert" className="mt-1 text-sm text-red-700">
					シリーズを読み込めませんでした
					<button
						type="button"
						onClick={() => seriesQuery.refetch()}
						className="ml-2 underline"
					>
						再読み込み
					</button>
				</div>
			)}
			{/* 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中はプルダウンを出さない（day.tsx と同じ理由） */}
			{seriesQuery.data && !seriesQuery.isError && (
				<select
					id={id}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					disabled={disabled}
					className="mt-1 w-full rounded border border-gray-300 px-3 py-2 disabled:bg-gray-100"
				>
					<option value="">選んでください</option>
					{seriesList.map((series) => (
						<option key={series.id} value={series.id}>
							{series.name}
						</option>
					))}
				</select>
			)}

			{isCreating ? (
				<div className="mt-2 rounded border border-gray-200 p-2">
					<label
						htmlFor={`${id}-new-name`}
						className="block text-xs text-gray-700"
					>
						新しいシリーズの名前（例: DEIM、IEEE iCast）
					</label>
					<div className="mt-1 flex gap-2">
						<input
							id={`${id}-new-name`}
							type="text"
							value={name}
							onChange={(event) => setName(event.target.value)}
							onKeyDown={handleKeyDown}
							disabled={disabled || createMutation.isPending}
							className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-100"
						/>
						<button
							type="button"
							onClick={create}
							disabled={disabled || !isCreatable}
							className="shrink-0 rounded bg-blue-700 px-3 py-1 text-sm text-white disabled:opacity-50"
						>
							{createMutation.isPending ? "作成中…" : "作成"}
						</button>
						<button
							type="button"
							onClick={() => {
								setIsCreating(false);
								setName("");
								createMutation.reset();
							}}
							disabled={createMutation.isPending}
							className="shrink-0 rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
						>
							やめる
						</button>
					</div>
					{isNameTooLong && (
						<p role="alert" className="mt-1 text-sm text-red-700">
							シリーズ名は{CONFERENCE_SERIES_NAME_MAX_LENGTH}
							文字以内で入力してください
						</p>
					)}
					{createMutation.isError && (
						<p role="alert" className="mt-1 text-sm text-red-700">
							{conferenceErrorMessage(createMutation.error)}
						</p>
					)}
				</div>
			) : (
				<button
					type="button"
					onClick={() => setIsCreating(true)}
					disabled={disabled}
					className="mt-2 text-sm text-blue-700 underline disabled:opacity-50"
				>
					＋ 新しいシリーズ
				</button>
			)}
		</div>
	);
}
