import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { formatGrade, GRADES, type Grade } from "../../shared/grade";
import { DISPLAY_NAME_MAX_LENGTH } from "../../shared/profile";
import { api } from "../lib/api";

// select の値は文字列しか持てないため、「教員（学年なし）」は専用の値で表し、送るときに null にする
const TEACHER_VALUE = "TEACHER";
const DEFAULT_ERROR_MESSAGE = "登録に失敗しました";

function toGrade(value: string): Grade | null {
	return value === TEACHER_VALUE ? null : (value as Grade);
}

export function OnboardingPage() {
	const navigate = useNavigate();
	const [displayName, setDisplayName] = useState("");
	const [gradeValue, setGradeValue] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setIsSubmitting(true);
		setSubmitError(null);
		try {
			const res = await api.api.me.profile.$post({
				json: { displayName, grade: toGrade(gradeValue) },
			});
			// 409 は別のタブなどで登録済みということなので、登録できたときと同じくトップに戻す
			if (res.ok || res.status === 409) {
				navigate("/", { replace: true });
				return;
			}
			if (res.status === 400) {
				setSubmitError(
					`表示名は1〜${DISPLAY_NAME_MAX_LENGTH}文字で入力し、学年を選んでください`,
				);
			} else {
				setSubmitError(DEFAULT_ERROR_MESSAGE);
			}
		} catch {
			// 通信そのものが失敗したとき
			setSubmitError(DEFAULT_ERROR_MESSAGE);
		}
		setIsSubmitting(false);
	}

	return (
		<main className="mx-auto max-w-md p-4">
			<h1 className="text-xl font-bold">プロフィール登録</h1>
			<p className="mt-2 text-sm text-gray-600">
				学年はあとから自分では変えられません。
			</p>
			{submitError && (
				<p
					role="alert"
					className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
				>
					{submitError}
				</p>
			)}
			<form onSubmit={submit} className="mt-6 space-y-4">
				<div>
					<label htmlFor="displayName" className="block text-sm font-bold">
						表示名
					</label>
					<input
						id="displayName"
						type="text"
						value={displayName}
						onChange={(event) => setDisplayName(event.target.value)}
						required
						maxLength={DISPLAY_NAME_MAX_LENGTH}
						placeholder="例: Shibata"
						className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
					/>
				</div>
				<div>
					<label htmlFor="grade" className="block text-sm font-bold">
						学年
					</label>
					<select
						id="grade"
						value={gradeValue}
						onChange={(event) => setGradeValue(event.target.value)}
						required
						className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
					>
						<option value="" disabled>
							選んでください
						</option>
						{GRADES.map((grade) => (
							<option key={grade} value={grade}>
								{formatGrade(grade)}
							</option>
						))}
						<option value={TEACHER_VALUE}>教員（学年なし）</option>
					</select>
				</div>
				<button
					type="submit"
					disabled={isSubmitting}
					className="w-full rounded bg-blue-600 px-4 py-2 font-bold text-white disabled:opacity-50"
				>
					{isSubmitting ? "登録中…" : "登録する"}
				</button>
			</form>
		</main>
	);
}
