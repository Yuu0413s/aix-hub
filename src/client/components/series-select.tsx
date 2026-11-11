import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useState } from "react";
import { API_ERROR_CODES } from "../../shared/api-errors";
import { CONFERENCE_SERIES_NAME_MAX_LENGTH } from "../../shared/conference";
import { countCharacters } from "../../shared/profile";
import { PRINTABLE_SINGLE_LINE } from "../../shared/text";
import { ApiError, api, readErrorCode } from "../lib/api";
import { conferenceErrorMessage } from "../lib/conference-error";
import { conferenceSeriesQueryOptions } from "../lib/conference-series-query";

// シリーズのプルダウンと「＋ 新しいシリーズ」。新しいシリーズは「作成」を押した時点で作り、選んだ状態にする。
// 学会の登録をやめると、学会が1つも無いシリーズが残るが許容する（設計メモ「API 設計」）
export function SeriesSelect({
	id,
	value,
	onChange,
	isDisabled,
	onCreatePendingChange,
}: {
	// label と結ぶ、プルダウンの id
	id: string;
	// 選んでいるシリーズの id。選んでいなければ ""
	value: string;
	onChange: (seriesId: string) => void;
	isDisabled: boolean;
	// シリーズの作成を送ってから、結果が返るまでの間か（送信の前後で呼ぶ）。その間に学会を送ると、作ったシリーズではなく
	// 前に選んでいたシリーズで保存されてしまうため、フォームはこれで送信を止める。入力欄を開いているだけでは止めない
	onCreatePendingChange: (isPending: boolean) => void;
}) {
	const seriesQuery = useQuery(conferenceSeriesQueryOptions());

	// 「＋ 新しいシリーズ」の入力欄を開いているか
	const [isNewSeriesOpen, setIsNewSeriesOpen] = useState(false);
	const [newSeriesName, setNewSeriesName] = useState("");

	const queryClient = useQueryClient();
	const createMutation = useMutation({
		mutationFn: async () => {
			const res = await api.api["conference-series"].$post({
				json: { name: newSeriesName },
			});
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`シリーズを作成できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return (await res.json()).series;
		},
		onMutate: () => onCreatePendingChange(true),
		onSettled: () => onCreatePendingChange(false),
		onSuccess: (series) => {
			// 取り直しを待たずにプルダウンへ加えてから選ぶ。取り直しが終わるまでの間に、選んだシリーズがプルダウンに無い
			// （見えている選択と送る id が食い違う）状態にならないようにするため（取り直しが失敗したときは、プルダウンごと隠れる）。
			// 並び順は取り直しで API の順に戻る
			// 一覧の初回の取得が終わる前（current が無い）でも、作ったシリーズだけの一覧を入れる。データが無いままだと、次の
			// invalidateQueries は進行中の初回の取得を待つだけで取り直さず、作る前に読んだ一覧で確定してしまうため。
			// データがあれば、進行中の取得を止めて取り直す（TanStack Query の cancelRefetch）
			// ここだけキーを直書きせず queryOptions から取る。キーからキャッシュのデータの型が決まり、API の返す形が変わったときに型チェックで気づけるため
			queryClient.setQueryData(
				conferenceSeriesQueryOptions().queryKey,
				(current) => ({ series: [...(current?.series ?? []), series] }),
			);
			queryClient.invalidateQueries({ queryKey: ["conference-series"] });
			onChange(series.id);
			setIsNewSeriesOpen(false);
			setNewSeriesName("");
		},
		onError: (error) => {
			// 同じ名前のシリーズは、このフォームを開いたあとにほかの人が作ったものかもしれない。
			// 文言どおりプルダウンから選べるよう、一覧を取り直す
			if (
				error instanceof ApiError &&
				error.code === API_ERROR_CODES.CONFERENCE_SERIES_NAME_TAKEN
			) {
				queryClient.invalidateQueries({ queryKey: ["conference-series"] });
			}
		},
	});

	const trimmedName = newSeriesName.trim();
	// API と同じく、使えない文字は前後の空白を除く前の名前で確かめる。
	// スプレッドシートのセルをコピーすると、末尾にタブが付くことがあり、目に見えないため送る前に知らせる
	const isNameUnprintable = !PRINTABLE_SINGLE_LINE.test(newSeriesName);
	const isNameTooLong =
		countCharacters(trimmedName) > CONFERENCE_SERIES_NAME_MAX_LENGTH;
	const isCreatable =
		trimmedName !== "" &&
		!isNameUnprintable &&
		!isNameTooLong &&
		!createMutation.isPending;

	function changeNewSeriesName(value: string) {
		setNewSeriesName(value);
		// 前の名前で失敗した文言（同じ名前のシリーズがある、など）を、今の名前について言っているように見せない
		if (createMutation.isError) {
			createMutation.reset();
		}
	}

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
					// 作成中に選び直しても、作成が終わると作ったシリーズで上書きされるため止める
					disabled={isDisabled || createMutation.isPending}
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

			{isNewSeriesOpen ? (
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
							value={newSeriesName}
							onChange={(event) => changeNewSeriesName(event.target.value)}
							onKeyDown={handleKeyDown}
							disabled={isDisabled || createMutation.isPending}
							className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-100"
						/>
						<button
							type="button"
							onClick={create}
							disabled={isDisabled || !isCreatable}
							className="shrink-0 rounded bg-blue-700 px-3 py-1 text-sm text-white disabled:opacity-50"
						>
							{createMutation.isPending ? "作成中…" : "作成"}
						</button>
						<button
							type="button"
							onClick={() => {
								setIsNewSeriesOpen(false);
								setNewSeriesName("");
								createMutation.reset();
							}}
							disabled={createMutation.isPending}
							className="shrink-0 rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
						>
							やめる
						</button>
					</div>
					{isNameUnprintable && (
						<p role="alert" className="mt-1 text-sm text-red-700">
							シリーズ名に、改行・タブや見えない文字は使えません
						</p>
					)}
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
					onClick={() => setIsNewSeriesOpen(true)}
					disabled={isDisabled}
					className="mt-2 text-sm text-blue-700 underline disabled:opacity-50"
				>
					＋ 新しいシリーズ
				</button>
			)}
		</div>
	);
}
