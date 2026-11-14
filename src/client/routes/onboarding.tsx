import { type FormEvent, useState } from "react";
import { useLoaderData, useNavigate } from "react-router";
import { API_ERROR_CODES } from "../../shared/api-errors";
import { formatGrade, GRADES, type Grade } from "../../shared/grade";
import {
	DISPLAY_NAME_MAX_LENGTH,
	isGradeRequiredOnRegistration,
} from "../../shared/profile";
import { Button } from "../components/button";
import { ERROR_BOX_CLASS } from "../components/class-names";
import {
	DisplayNameField,
	isDisplayNameTooLong,
} from "../components/display-name-field";
import { api, readErrorCode } from "../lib/api";
import type { redirectIfProfileRegisteredLoader } from "../lib/auth-client";

const DEFAULT_ERROR_MESSAGE = "登録に失敗しました";
const DISPLAY_NAME_RULE = `表示名は改行や見えない文字を含めず1〜${DISPLAY_NAME_MAX_LENGTH}文字で入力`;

export function OnboardingPage() {
	const navigate = useNavigate();
	const me = useLoaderData<typeof redirectIfProfileRegisteredLoader>();
	// 学年の欄は、学年が要る人（学生と、学生の admin）にだけ出す。先生は表示名だけを登録する。
	// API と同じ関数で決める（画面と API で判定がずれると、送っても必ず 400 になるため）
	const isGradeRequired = isGradeRequiredOnRegistration(me);
	const validationErrorMessage = isGradeRequired
		? `${DISPLAY_NAME_RULE}し、学年を選んでください`
		: `${DISPLAY_NAME_RULE}してください`;
	const [displayName, setDisplayName] = useState("");
	const [gradeValue, setGradeValue] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (isDisplayNameTooLong(displayName)) {
			setSubmitError(validationErrorMessage);
			return;
		}
		setIsSubmitting(true);
		setSubmitError(null);
		try {
			const res = await api.api.me.profile.$post({
				// 学年の欄は required なので、学年が要る人の gradeValue は GRADES のどれか
				json: {
					displayName,
					grade: isGradeRequired ? (gradeValue as Grade) : null,
				},
			});
			if (res.ok) {
				navigate("/", { replace: true });
				return;
			}
			// 表示はステータスではなく code で分ける（api.md）
			switch (await readErrorCode(res)) {
				// 別のタブなどで登録済みということなので、登録できたときと同じくトップに戻す
				case API_ERROR_CODES.PROFILE_ALREADY_REGISTERED:
					navigate("/", { replace: true });
					return;
				// 入力中にセッションが切れた・別のタブでログアウトしたときは、押し直しても通らないためログインし直してもらう
				case API_ERROR_CODES.UNAUTHORIZED:
					navigate("/login", { replace: true });
					return;
				case API_ERROR_CODES.VALIDATION_ERROR:
					setSubmitError(validationErrorMessage);
					break;
				default:
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
			{isGradeRequired && (
				<p className="mt-2 text-sm text-fg-muted">
					学年はあとから自分では変えられません。
				</p>
			)}
			{submitError && (
				<p role="alert" className={`mt-4 ${ERROR_BOX_CLASS}`}>
					{submitError}
				</p>
			)}
			<form onSubmit={submit} className="mt-6 space-y-4">
				<DisplayNameField
					value={displayName}
					onChange={setDisplayName}
					isDisabled={isSubmitting}
				/>
				{isGradeRequired && (
					<div>
						<label htmlFor="grade" className="block text-sm font-bold">
							学年
						</label>
						<select
							id="grade"
							value={gradeValue}
							onChange={(event) => setGradeValue(event.target.value)}
							required
							// 表示名の欄と同じく、送信中は止める（送った内容と画面の内容を食い違わせないため）
							disabled={isSubmitting}
							className="mt-1 w-full rounded border border-line bg-surface px-3 py-2 disabled:bg-surface-muted"
						>
							<option value="" disabled>
								選んでください
							</option>
							{GRADES.map((grade) => (
								<option key={grade} value={grade}>
									{formatGrade(grade)}
								</option>
							))}
						</select>
					</div>
				)}
				<Button
					type="submit"
					variant="primary"
					disabled={isSubmitting}
					className="w-full"
				>
					{isSubmitting ? "登録中…" : "登録する"}
				</Button>
			</form>
		</main>
	);
}
