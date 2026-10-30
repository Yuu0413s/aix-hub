import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ANNOUNCEMENT_BODY_MAX_LENGTH } from "../../shared/announcement";
import { API_ERROR_CODES } from "../../shared/api-errors";
import { addMonths, isMonth, tokyoDate } from "../../shared/date";
import { countCharacters } from "../../shared/profile";
import { announcementErrorMessage } from "../lib/announcement-error";
import { ApiError, api, readErrorCode } from "../lib/api";
import { formatDate } from "../lib/format-date";
import { monthDaysQueryOptions } from "../lib/month-days-query";

// 編集する連絡の、入力欄に入れる値
export type EditingAnnouncement = {
	id: string;
	date: string;
	body: string;
	displayFrom: string | null;
	displayUntil: string | null;
};

// isClosed は、休講か分からない日（候補の範囲外の日）では null にし、印を付けない
type SeminarDayOption = { date: string; isClosed: boolean | null };

// サーバーと同じく、前後の空白を除いてから数える
function bodyLength(value: string) {
	return countCharacters(value.trim());
}

// 送る前に止める理由。無ければ null。サーバーでも確かめるが、送る前に分かるものはここで知らせる
function inputProblem({
	date,
	body,
	displayFrom,
	displayUntil,
	today,
}: {
	date: string;
	body: string;
	displayFrom: string;
	displayUntil: string;
	today: string;
}) {
	if (date === "") {
		return "開催日を選んでください";
	}
	if (body.trim() === "") {
		return "本文を入力してください";
	}
	if (bodyLength(body) > ANNOUNCEMENT_BODY_MAX_LENGTH) {
		return `本文は${ANNOUNCEMENT_BODY_MAX_LENGTH}文字以内で入力してください`;
	}
	// API は両方入っているときしか前後を確かめないため、空を補ったあとの期間でも確かめる。
	// これから表示される日が無い連絡は、表示中にも表示前にも出ず、書いた人も見つけられなくなるため、送らせない。
	// 文言は、直す場所が利用者に分かるよう、止めた理由ごとに分ける
	const end = displayUntil === "" ? date : displayUntil;
	// 開始日が終了日より後（終了日が空なら、開催日より後）。終了日を今日以降にしても直らないため、開始日の直し方を伝える
	if (displayFrom !== "" && displayFrom > end) {
		return "表示開始日は、表示終了日（空なら開催日）と同じ日かそれより前にしてください";
	}
	// ここまで来れば、開始日は空か end 以前。開始日が空なら API は作成日（新しく書くなら今日、編集なら今日以前）から表示するため、
	// これから表示される日があるかは、表示される最後の日（end）が今日より前かだけで決まる
	if (end < today) {
		return "この期間では、これから表示される日がありません。表示終了日（空なら開催日）を今日以降にしてください";
	}
	return null;
}

// 全体連絡を書く・編集する入力欄（トップの連絡欄の中で開く）
export function AnnouncementForm({
	announcement,
	onDone,
	onCancel,
}: {
	// 編集する連絡。新しく書くときは null
	announcement: EditingAnnouncement | null;
	// 保存して一覧を取り直したあとに呼ぶ
	onDone: () => void;
	onCancel: () => void;
}) {
	const today = tokyoDate(new Date());
	const seminarDays = useSeminarDayOptions(today, announcement?.date ?? null);

	// 開催日は、選んだ日が候補にあればその日。無ければ候補の先頭（ふだんは一番近い日。編集中は元の開催日のことがある）を選んだことにする。
	// - 入力中に日をまたいだとき・保存して「開催日が無い」と返され候補を取り直したときは、選んだ日が候補から外れる。
	//   そのとき選択欄は先頭の日を表示するため、選んだ日のまま送ると、見えている日と保存される日が食い違う
	// - 新しく書くときは、候補がそろうまで空にする。片方の月だけ取れた・前回の結果が残っているときに、その先頭を使うと、
	//   選択欄が出ていない（利用者が見ていない）日に連絡が付くため、読み込み中・失敗中は空にして「開催日を選んでください」で止める
	// （編集中の連絡の開催日は、読み込み中でも必ず候補にある。useSeminarDayOptions）
	const [selectedDate, setSelectedDate] = useState<string | null>(
		announcement?.date ?? null,
	);
	const isSelectedDateAvailable = seminarDays.options.some(
		(option) => option.date === selectedDate,
	);
	const date =
		selectedDate !== null && isSelectedDateAvailable
			? selectedDate
			: seminarDays.isPending || seminarDays.isError
				? ""
				: (seminarDays.options[0]?.date ?? "");
	const [body, setBody] = useState(announcement?.body ?? "");
	// 日付の入力欄は空のとき "" を返すため、"" を「指定なし」として持ち、送るときに null にする
	const [displayFrom, setDisplayFrom] = useState(
		announcement?.displayFrom ?? "",
	);
	const [displayUntil, setDisplayUntil] = useState(
		announcement?.displayUntil ?? "",
	);

	const queryClient = useQueryClient();
	const saveMutation = useMutation({
		mutationFn: async () => {
			const json = {
				date,
				body,
				displayFrom: displayFrom === "" ? null : displayFrom,
				displayUntil: displayUntil === "" ? null : displayUntil,
			};
			const res = announcement
				? await api.api.announcements[":id"].$patch({
						param: { id: announcement.id },
						json,
					})
				: await api.api.announcements.$post({ json });
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`送信できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
		},
		// 一覧を取り直し終えてから閉じる。先に閉じると、取り直すまでの間に古い内容が見えるため
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["announcements"] });
			onDone();
		},
		onError: (error) => {
			// 開催日が無くなった・連絡が消されたときは、候補と一覧を新しくして選び直せるようにする
			const code = error instanceof ApiError ? error.code : null;
			if (code === API_ERROR_CODES.SEMINAR_DAY_NOT_FOUND) {
				queryClient.invalidateQueries({ queryKey: ["days"] });
			}
			if (code === API_ERROR_CODES.ANNOUNCEMENT_NOT_FOUND) {
				queryClient.invalidateQueries({ queryKey: ["announcements"] });
			}
		},
	});

	const problem = inputProblem({
		date,
		body,
		displayFrom,
		displayUntil,
		today,
	});
	const isSaving = saveMutation.isPending;
	// 文字数を超えたら、送る前に止める理由と同じく赤で知らせる
	const isBodyTooLong = bodyLength(body) > ANNOUNCEMENT_BODY_MAX_LENGTH;
	// 書き始める前（本文が空）から「本文を入力してください」と赤で出さないよう、本文が空の間は理由を出さない
	const visibleProblem = body.trim() === "" ? null : problem;

	// 入力欄を開いたまま日付が変わったことに、送るときに気づいたら、その日付を持つ（下の submit）
	const [changedToday, setChangedToday] = useState<string | null>(null);

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		// 時間がたつだけでは描き直されないため、problem と開催日の候補は、最後に描いた時点の今日で決まっている。
		// 日付が変わったまま送ると、表示される日が無い連絡を作れてしまう（API は空を補ったあとの期間を確かめない）ため、
		// 押した時点で日付が変わっていたら送らず、描き直して今日の日付で確かめ直してもらう
		const currentToday = tokyoDate(new Date());
		if (currentToday !== today) {
			setChangedToday(currentToday);
			return;
		}
		if (problem) {
			return;
		}
		saveMutation.mutate();
	}

	// label と入力欄を結ぶ id。入力欄は一度に1つしか開かない（announcement-section.tsx）ため、固定でよい
	const idPrefix = "announcement-form";

	return (
		<form
			onSubmit={submit}
			className="space-y-3 rounded border border-gray-300 p-3"
		>
			<div>
				<label htmlFor={`${idPrefix}-date`} className="block text-sm font-bold">
					開催日
				</label>
				{seminarDays.isPending && (
					<p className="mt-1 text-sm text-gray-600">読み込み中…</p>
				)}
				{seminarDays.isError && (
					<div role="alert" className="mt-1 text-sm text-red-700">
						開催日を読み込めませんでした
						<button
							type="button"
							onClick={seminarDays.refetch}
							className="ml-2 underline"
						>
							再読み込み
						</button>
					</div>
				)}
				{!seminarDays.isPending &&
					!seminarDays.isError &&
					(seminarDays.options.length === 0 ? (
						<p className="mt-1 text-sm text-gray-600">
							選べる開催日がありません
						</p>
					) : (
						<select
							id={`${idPrefix}-date`}
							value={date}
							onChange={(event) => setSelectedDate(event.target.value)}
							disabled={isSaving}
							className="mt-1 w-full rounded border border-gray-300 px-3 py-2 disabled:bg-gray-100"
						>
							{seminarDays.options.map((option) => (
								<option key={option.date} value={option.date}>
									{formatDate(option.date)}
									{option.isClosed === true ? "（休講）" : ""}
								</option>
							))}
						</select>
					))}
			</div>

			<div>
				<label htmlFor={`${idPrefix}-body`} className="block text-sm font-bold">
					本文
				</label>
				<textarea
					id={`${idPrefix}-body`}
					value={body}
					onChange={(event) => setBody(event.target.value)}
					required
					disabled={isSaving}
					rows={4}
					// maxLength は UTF-16 単位で数え、絵文字を2文字分にしてしまうため使わず、下の文字数で知らせる（display-name-field.tsx と同じ）
					aria-describedby={`${idPrefix}-body-length`}
					className="mt-1 w-full rounded border border-gray-300 px-3 py-2 disabled:bg-gray-100"
				/>
				<p
					id={`${idPrefix}-body-length`}
					className={`text-right text-xs ${isBodyTooLong ? "text-red-700" : "text-gray-600"}`}
				>
					{bodyLength(body)} / {ANNOUNCEMENT_BODY_MAX_LENGTH}
				</p>
			</div>

			<fieldset>
				<legend className="text-sm font-bold">表示期間（任意）</legend>
				<div className="mt-1 flex items-center gap-2 text-sm">
					<input
						type="date"
						aria-label="表示開始日"
						value={displayFrom}
						onChange={(event) => setDisplayFrom(event.target.value)}
						disabled={isSaving}
						className="rounded border border-gray-300 px-2 py-1 disabled:bg-gray-100"
					/>
					〜
					<input
						type="date"
						aria-label="表示終了日"
						value={displayUntil}
						onChange={(event) => setDisplayUntil(event.target.value)}
						disabled={isSaving}
						className="rounded border border-gray-300 px-2 py-1 disabled:bg-gray-100"
					/>
				</div>
				<p className="mt-1 text-xs text-gray-600">
					開始日が空なら書いた日から、終了日が空なら開催日まで表示します
				</p>
			</fieldset>

			{changedToday !== null && (
				<p role="status" className="text-sm text-gray-700">
					日付が変わったため、開催日の候補と表示期間を確かめ直しました。内容を確かめて、もう一度押してください
				</p>
			)}
			{visibleProblem && (
				<p role="alert" className="text-sm text-red-700">
					{visibleProblem}
				</p>
			)}
			{saveMutation.isError && (
				<p role="alert" className="text-sm text-red-700">
					{announcementErrorMessage(saveMutation.error)}
				</p>
			)}

			<div className="flex justify-end gap-2">
				<button
					type="button"
					onClick={onCancel}
					disabled={isSaving}
					className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
				>
					やめる
				</button>
				<button
					type="submit"
					disabled={isSaving || problem !== null}
					className="rounded bg-blue-700 px-3 py-1 text-sm text-white disabled:opacity-50"
				>
					{isSaving ? "保存中…" : announcement ? "保存する" : "書き込む"}
				</button>
			</div>
		</form>
	);
}

// 連絡を書ける開催日の候補。今日以降の開催日（休講日も含む）を、今月と来月の分から作る。
// 開催日は Cron が4週分ずつ作るため、2か月分で足りる（設計メモ「全体連絡」）。
// 編集中の連絡の開催日は、過去や範囲外でも候補に残す（選び直さずに保存できるように）
function useSeminarDayOptions(today: string, editingDate: string | null) {
	const month = today.slice(0, 7);
	const nextMonth = addMonths(month, 1);
	// 2099年12月の翌月（2100年1月）は API が受け付けない（shared/date.ts の MONTH_PATTERN）ため取らない。
	// 取らない月は、読み込み中・失敗の判定にも入れない（入れると、いつまでも読み込み中になる）
	const isNextMonthAvailable = isMonth(nextMonth);
	const currentMonthQuery = useQuery(monthDaysQueryOptions(month));
	const nextMonthQuery = useQuery({
		...monthDaysQueryOptions(nextMonth),
		enabled: isNextMonthAvailable,
	});
	const queries = isNextMonthAvailable
		? [currentMonthQuery, nextMonthQuery]
		: [currentMonthQuery];
	const isPending = queries.some((query) => query.isPending);
	// 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中は候補を出さない（day.tsx と同じ理由）
	const isError = queries.some((query) => query.isError);

	const options: SeminarDayOption[] = queries
		.flatMap((query) => query.data?.days ?? [])
		.filter((day) => day.date >= today)
		.map((day) => ({ date: day.date, isClosed: day.status === "closed" }));
	if (
		editingDate !== null &&
		!options.some((option) => option.date === editingDate)
	) {
		options.unshift({ date: editingDate, isClosed: null });
	}

	return {
		options,
		isPending,
		isError,
		refetch: () => {
			for (const query of queries) {
				query.refetch();
			}
		},
	};
}
