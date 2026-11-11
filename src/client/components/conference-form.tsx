import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link } from "react-router";
import { API_ERROR_CODES } from "../../shared/api-errors";
import {
	CONFERENCE_TEXT_MAX_LENGTH,
	CONFERENCE_TITLE_MAX_LENGTH,
	CONFERENCE_URL_MAX_LENGTH,
	CONFERENCE_VENUE_MAX_LENGTH,
} from "../../shared/conference";
import { countCharacters } from "../../shared/profile";
import { ApiError, api, readErrorCode } from "../lib/api";
import { conferenceErrorMessage } from "../lib/conference-error";
import { SeriesSelect } from "./series-select";

// 編集する学会の、入力欄に入れる値（詳細の API が返す形の一部）
export type EditingConference = {
	id: string;
	seriesId: string;
	title: string;
	venue: string | null;
	url: string | null;
	submissionDeadline: string | null;
	submissionNote: string | null;
	startDate: string | null;
	endDate: string | null;
	scheduleNote: string | null;
	description: string | null;
	note: string | null;
};

// 入力欄の値。空欄は "" のまま持ち、そのまま送る（"" を null にするのは API。2026-11-11, Issue #18 で決定）
type FormValues = {
	[Key in keyof Omit<EditingConference, "id">]: string;
};

function initialValues(conference: EditingConference | null): FormValues {
	return {
		seriesId: conference?.seriesId ?? "",
		title: conference?.title ?? "",
		venue: conference?.venue ?? "",
		url: conference?.url ?? "",
		submissionDeadline: conference?.submissionDeadline ?? "",
		submissionNote: conference?.submissionNote ?? "",
		startDate: conference?.startDate ?? "",
		endDate: conference?.endDate ?? "",
		scheduleNote: conference?.scheduleNote ?? "",
		description: conference?.description ?? "",
		note: conference?.note ?? "",
	};
}

// サーバーと同じく、前後の空白を除いてから数える
function length(value: string) {
	return countCharacters(value.trim());
}

// API と同じ条件（shared/schemas.ts の isHttpUrl）。送る前に分かるものはここで知らせる
function isHttpUrl(value: string) {
	if (!/^https?:\/\//i.test(value)) {
		return false;
	}
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

// 送る前に止める理由。無ければ null。サーバーでも確かめるが、送る前に分かるものはここで知らせる
function inputProblem(values: FormValues) {
	if (values.seriesId === "") {
		return "シリーズを選んでください";
	}
	if (values.title.trim() === "") {
		return "学会名を入力してください";
	}
	if (length(values.title) > CONFERENCE_TITLE_MAX_LENGTH) {
		return `学会名は${CONFERENCE_TITLE_MAX_LENGTH}文字以内で入力してください`;
	}
	if (length(values.venue) > CONFERENCE_VENUE_MAX_LENGTH) {
		return `開催地は${CONFERENCE_VENUE_MAX_LENGTH}文字以内で入力してください`;
	}
	const url = values.url.trim();
	if (length(url) > CONFERENCE_URL_MAX_LENGTH) {
		return `URL は${CONFERENCE_URL_MAX_LENGTH}文字以内で入力してください`;
	}
	if (url !== "" && !isHttpUrl(url)) {
		return "URL は http:// か https:// で始まるものを入力してください";
	}
	if (
		values.startDate !== "" &&
		values.endDate !== "" &&
		values.endDate < values.startDate
	) {
		return "開催の終了日は、開始日と同じ日かそれより後にしてください";
	}
	const longTextLabels = [
		["submissionNote", "締切の補足"],
		["scheduleNote", "開催日の補足"],
		["description", "説明"],
		["note", "メモ"],
	] as const;
	for (const [key, label] of longTextLabels) {
		if (length(values[key]) > CONFERENCE_TEXT_MAX_LENGTH) {
			return `${label}は${CONFERENCE_TEXT_MAX_LENGTH}文字以内で入力してください`;
		}
	}
	return null;
}

// 学会の登録・編集で共通のフォーム（設計メモ「画面構成」）
export function ConferenceForm({
	conference,
	cancelTo,
	onSaved,
}: {
	// 編集する学会。新しく登録するときは null
	conference: EditingConference | null;
	// 「やめる」で戻る先
	cancelTo: string;
	// 保存したあとに、保存した学会の id で呼ぶ
	onSaved: (conferenceId: string) => void;
}) {
	const [values, setValues] = useState(() => initialValues(conference));
	// 書き始める前から「学会名を入力してください」などを赤で出さないよう、一度送ろうとしてから理由を出す
	const [isSubmitAttempted, setIsSubmitAttempted] = useState(false);

	function setValue(key: keyof FormValues, value: string) {
		setValues((current) => ({ ...current, [key]: value }));
	}

	const queryClient = useQueryClient();
	const saveMutation = useMutation({
		mutationFn: async () => {
			const res = conference
				? await api.api.conferences[":id"].$patch({
						param: { id: conference.id },
						json: values,
					})
				: await api.api.conferences.$post({ json: values });
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`送信できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return (await res.json()).id;
		},
		onSuccess: async (conferenceId) => {
			// 一覧は今は画面に無いため、古い印を付けるだけにし、開いたときに取り直させる
			queryClient.invalidateQueries({ queryKey: ["conferences"] });
			// 編集では詳細を取り直し終えてから移る。先に移ると、取り直すまでの間に詳細画面で編集前の内容が見えるため
			await queryClient.invalidateQueries({
				queryKey: ["conference", conferenceId],
			});
			onSaved(conferenceId);
		},
		onError: (error) => {
			// シリーズが無くなったときは、プルダウンを新しくして選び直せるようにする
			if (
				error instanceof ApiError &&
				error.code === API_ERROR_CODES.CONFERENCE_SERIES_NOT_FOUND
			) {
				queryClient.invalidateQueries({ queryKey: ["conference-series"] });
			}
		},
	});

	const problem = inputProblem(values);
	const isSaving = saveMutation.isPending;

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setIsSubmitAttempted(true);
		if (problem) {
			return;
		}
		saveMutation.mutate();
	}

	// label と入力欄を結ぶ id。フォームは1画面に1つしか出さないため、固定でよい
	const idPrefix = "conference-form";
	const inputClassName =
		"mt-1 w-full rounded border border-gray-300 px-3 py-2 disabled:bg-gray-100";

	return (
		<form onSubmit={submit} className="mt-4 space-y-4">
			<Field label="シリーズ" htmlFor={`${idPrefix}-series`} isRequired>
				<SeriesSelect
					id={`${idPrefix}-series`}
					value={values.seriesId}
					onChange={(seriesId) => setValue("seriesId", seriesId)}
					disabled={isSaving}
				/>
			</Field>

			<Field label="学会名" htmlFor={`${idPrefix}-title`} isRequired>
				<input
					id={`${idPrefix}-title`}
					type="text"
					value={values.title}
					onChange={(event) => setValue("title", event.target.value)}
					disabled={isSaving}
					placeholder="例: DEIM 2027"
					className={inputClassName}
				/>
			</Field>

			<Field label="開催地" htmlFor={`${idPrefix}-venue`}>
				<input
					id={`${idPrefix}-venue`}
					type="text"
					value={values.venue}
					onChange={(event) => setValue("venue", event.target.value)}
					disabled={isSaving}
					className={inputClassName}
				/>
			</Field>

			<Field label="URL" htmlFor={`${idPrefix}-url`}>
				{/* type="url" にすると、ブラウザが独自の文言で送信を止め、http(s) 以外も通すため、確かめるのは inputProblem に任せる */}
				<input
					id={`${idPrefix}-url`}
					type="text"
					inputMode="url"
					value={values.url}
					onChange={(event) => setValue("url", event.target.value)}
					disabled={isSaving}
					placeholder="https://"
					className={inputClassName}
				/>
			</Field>

			<Field label="締切" htmlFor={`${idPrefix}-deadline`}>
				<input
					id={`${idPrefix}-deadline`}
					type="date"
					value={values.submissionDeadline}
					onChange={(event) =>
						setValue("submissionDeadline", event.target.value)
					}
					disabled={isSaving}
					className={inputClassName}
				/>
				<textarea
					aria-label="締切の補足"
					value={values.submissionNote}
					onChange={(event) => setValue("submissionNote", event.target.value)}
					disabled={isSaving}
					rows={2}
					placeholder="補足（複数の締切、「7月上旬」のような決まっていない日付など）"
					className={inputClassName}
				/>
			</Field>

			<fieldset>
				<legend className="text-sm font-bold">開催日</legend>
				<div className="mt-1 flex items-center gap-2 text-sm">
					<input
						type="date"
						aria-label="開催の開始日"
						value={values.startDate}
						onChange={(event) => setValue("startDate", event.target.value)}
						disabled={isSaving}
						className="rounded border border-gray-300 px-2 py-1 disabled:bg-gray-100"
					/>
					〜
					<input
						type="date"
						aria-label="開催の終了日"
						value={values.endDate}
						onChange={(event) => setValue("endDate", event.target.value)}
						disabled={isSaving}
						className="rounded border border-gray-300 px-2 py-1 disabled:bg-gray-100"
					/>
				</div>
				<textarea
					aria-label="開催日の補足"
					value={values.scheduleNote}
					onChange={(event) => setValue("scheduleNote", event.target.value)}
					disabled={isSaving}
					rows={2}
					placeholder="補足（「昨年は 2/28〜3/2」など）"
					className={inputClassName}
				/>
			</fieldset>

			<Field label="説明" htmlFor={`${idPrefix}-description`}>
				<textarea
					id={`${idPrefix}-description`}
					value={values.description}
					onChange={(event) => setValue("description", event.target.value)}
					disabled={isSaving}
					rows={4}
					className={inputClassName}
				/>
			</Field>

			<Field label="メモ" htmlFor={`${idPrefix}-note`}>
				<textarea
					id={`${idPrefix}-note`}
					value={values.note}
					onChange={(event) => setValue("note", event.target.value)}
					disabled={isSaving}
					rows={3}
					className={inputClassName}
				/>
			</Field>

			{isSubmitAttempted && problem && (
				<p role="alert" className="text-sm text-red-700">
					{problem}
				</p>
			)}
			{saveMutation.isError && (
				<p role="alert" className="text-sm text-red-700">
					{conferenceErrorMessage(saveMutation.error)}
				</p>
			)}

			<div className="flex justify-end gap-2">
				<Link
					to={cancelTo}
					// 送信中に移ると、保存できたのか分からなくなるため止める
					aria-disabled={isSaving}
					onClick={(event) => {
						if (isSaving) {
							event.preventDefault();
						}
					}}
					className="rounded border border-gray-300 px-3 py-1 text-sm aria-disabled:opacity-50"
				>
					やめる
				</Link>
				<button
					type="submit"
					disabled={isSaving}
					className="rounded bg-blue-700 px-3 py-1 text-sm text-white disabled:opacity-50"
				>
					{isSaving ? "保存中…" : conference ? "保存する" : "登録する"}
				</button>
			</div>
		</form>
	);
}

function Field({
	label,
	htmlFor,
	isRequired = false,
	children,
}: {
	label: string;
	htmlFor: string;
	isRequired?: boolean;
	children: ReactNode;
}) {
	return (
		<div>
			<label htmlFor={htmlFor} className="block text-sm font-bold">
				{label}
				{isRequired && <span className="ml-1 text-xs text-red-700">必須</span>}
			</label>
			{children}
		</div>
	);
}
