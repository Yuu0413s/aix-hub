import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useRevalidator } from "react-router";
import { API_ERROR_CODES } from "../../../shared/api-errors";
import {
	formatDisplayName,
	formatGrade,
	type Grade,
	type GradePromotionPath,
} from "../../../shared/grade";
import { ConfirmDialog } from "../../components/confirm-dialog";
import {
	ApiError,
	api,
	isClientError,
	isRetryable,
	readErrorCode,
} from "../../lib/api";
import { useSetAdminResultMessage } from "./layout";

const FORBIDDEN_MESSAGE = "この画面は管理者だけが見られます";

const executedAtFormat = new Intl.DateTimeFormat("ja-JP", {
	timeZone: "Asia/Tokyo",
	dateStyle: "long",
	timeStyle: "short",
});

function targetName(target: { displayName: string | null; grade: Grade }) {
	return target.displayName === null
		? `（未登録）(${formatGrade(target.grade)})`
		: formatDisplayName(target.displayName, target.grade);
}

// M2 の continue は学年が変わらないため「のまま」と書く
function continueLabel(grade: Grade, continueGrade: Grade) {
	return continueGrade === grade
		? `${formatGrade(grade)} のまま`
		: formatGrade(continueGrade);
}

// 確認ダイアログで何を実行しようとしているか。押したときの値で持つ
// （ダイアログを開いている間に一覧が取り直されても、確かめた内容と違うものを送らないため）
type PendingPromotion = {
	academicYear: number;
	paths: { userId: string; path: GradePromotionPath }[];
	targetCount: number;
	graduateCount: number;
};

function confirmMessage(promotion: PendingPromotion) {
	const { academicYear, targetCount, graduateCount } = promotion;
	return [
		`${academicYear}年度の学年更新を実行しますか？`,
		`対象は${targetCount}人で、うち卒業は${graduateCount}人です。`,
		"実行すると画面から元に戻せません。",
		// 画面を開いている間に予約が入っていても、注意を見ずに消さないよう、予約の有無にかかわらず書く
		...(graduateCount > 0 ? ["卒業する人の開始前の予約は削除されます。"] : []),
	].join("");
}

// 送信の失敗の文言。4xx は送り直しても結果が変わらないため、ダイアログは「はい」を出さない（action-error.ts と同じ考え方）
function promotionErrorMessage(error: unknown) {
	switch (error instanceof ApiError ? error.code : null) {
		case API_ERROR_CODES.UNAUTHORIZED:
			return "ログインの有効期限が切れました。ページを再読み込みして、ログインし直してください";
		case API_ERROR_CODES.FORBIDDEN:
			return "この操作を行う権限がありません";
		case API_ERROR_CODES.GRADE_PROMOTION_NOT_OPEN:
			return "学年更新は4月の間だけ実行できます";
		case API_ERROR_CODES.GRADE_PROMOTION_ALREADY_EXECUTED:
			return "この年度の学年更新は実行済みです";
		case API_ERROR_CODES.GRADE_PROMOTION_PATH_REQUIRED:
			return "進路を選んでいない人が増えました。一覧で進路を選んでから、もう一度実行してください";
		case API_ERROR_CODES.LAST_ADMIN:
			return "在籍中の管理者がいなくなるため、実行できません。先にほかの人を管理者にしてください";
	}
	return isClientError(error)
		? "送信できませんでした。ページを再読み込みしてください"
		: "送信できませんでした。時間をおいてもう一度お試しください";
}

export function AdminGradePromotionPage() {
	const statusQuery = useQuery({
		queryKey: ["admin", "grade-promotions"],
		queryFn: async () => {
			const res = await api.api.admin["grade-promotions"].$get();
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`学年更新の状況を取得できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return res.json();
		},
		retry: isRetryable,
	});
	// 画面を開いた後に役割が変わったとき（loader の自分の情報は古いまま）は、API の 403 で分かる
	const isForbidden =
		statusQuery.error instanceof ApiError &&
		statusQuery.error.code === API_ERROR_CODES.FORBIDDEN;

	// セレクトで選び、まだ送っていない進路（利用者の id ごと）
	const [drafts, setDrafts] = useState(new Map<string, GradePromotionPath>());
	const [pendingPromotion, setPendingPromotion] =
		useState<PendingPromotion | null>(null);
	const setResultMessage = useSetAdminResultMessage();

	const queryClient = useQueryClient();
	const revalidator = useRevalidator();
	const promotionMutation = useMutation({
		mutationFn: async ({ paths }: PendingPromotion) => {
			const res = await api.api.admin["grade-promotions"].$post({
				json: { paths },
			});
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`送信できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return res.json();
		},
		// 取り直し終えてから閉じる（users.tsx と同じ理由。取り直すまでの間、古い状態のボタンを押せないように）
		onSuccess: async (result) => {
			setResultMessage(
				`${result.academicYear}年度の学年更新を実行しました（対象: ${result.updatedCount}人、うち卒業: ${result.graduatedCount}人、削除した予約: ${result.deletedReservationCount}件）`,
			);
			// 学年・在籍・予約が変わると多くの画面に影響するため、キャッシュをすべて取り直させる。
			// 自分の学年も変わることがあるため、自分の情報（loader）も取り直す
			await Promise.all([
				queryClient.invalidateQueries(),
				revalidator.revalidate(),
			]);
			setDrafts(new Map());
			setPendingPromotion(null);
		},
		// 失敗したときも取り直す。進路を選ぶ人が増えたときや、ほかの管理者が先に実行したときに、古い状態を見せ続けないため。
		// 自分の情報を取り直すのは 403（自分の権限が変わった）のときだけにする（users.tsx と同じ理由）
		onError: (error) =>
			Promise.all([
				queryClient.invalidateQueries({
					queryKey: ["admin", "grade-promotions"],
				}),
				error instanceof ApiError && error.code === API_ERROR_CODES.FORBIDDEN
					? revalidator.revalidate()
					: undefined,
			]),
	});

	const data = statusQuery.data;
	const targets = data?.targets ?? [];
	const choiceTargets = targets.flatMap((target) =>
		target.promotion.kind === "choice"
			? [{ ...target, continueGrade: target.promotion.continueGrade }]
			: [],
	);
	const automaticTargets = targets.flatMap((target) =>
		target.promotion.kind === "automatic"
			? [{ ...target, next: target.promotion.next }]
			: [],
	);
	const paths = choiceTargets.flatMap(({ id }) => {
		const path = drafts.get(id);
		return path === undefined ? [] : [{ userId: id, path }];
	});
	// 対象者が0人のまま実行すると、その年度の記録だけが残り、もう実行できなくなるため押せないようにする
	const isExecutable =
		targets.length > 0 && paths.length === choiceTargets.length;

	return (
		<section className="mt-4">
			{statusQuery.isPending && (
				<p className="text-sm text-gray-600">読み込み中…</p>
			)}
			{isForbidden && (
				<p role="alert" className="text-sm text-red-700">
					{FORBIDDEN_MESSAGE}
				</p>
			)}
			{statusQuery.isError && !isForbidden && (
				<div role="alert" className="text-sm text-red-700">
					学年更新の状況を読み込めませんでした
					<button
						type="button"
						onClick={() => statusQuery.refetch()}
						className="ml-2 underline"
					>
						再読み込み
					</button>
				</div>
			)}

			{/* 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中は出さない（古い状態のまま実行させないため） */}
			{data &&
				!statusQuery.isError &&
				(data.executed ? (
					<p className="text-sm">
						{data.academicYear}年度の学年更新は実行済みです（
						{executedAtFormat.format(new Date(data.executed.executedAt))}、
						{data.executed.executedByDisplayName ?? "（未登録）"}）
					</p>
				) : !data.isOpen ? (
					<p className="text-sm">学年更新は毎年4月の間だけ実行できます</p>
				) : targets.length === 0 ? (
					<p className="text-sm">対象者がいません</p>
				) : (
					<>
						<p className="text-sm">
							{data.academicYear}年度の学年更新です。対象は{targets.length}
							人です。
						</p>

						{choiceTargets.length > 0 && (
							<>
								<h2 className="mt-4 text-sm font-bold">進路を選ぶ人</h2>
								<ul className="mt-1 divide-y divide-gray-200 border-y border-gray-200">
									{choiceTargets.map((target) => {
										const name = targetName(target);
										return (
											<li key={target.id} className="py-2 text-sm">
												<p className="break-all font-bold">{name}</p>
												<p className="break-all text-xs text-gray-600">
													{target.email}
												</p>
												<select
													aria-label={`${name} の進路`}
													value={drafts.get(target.id) ?? ""}
													onChange={(event) => {
														const value = event.target.value;
														setDrafts((current) => {
															const next = new Map(current);
															if (value === "") {
																next.delete(target.id);
															} else {
																next.set(
																	target.id,
																	value as GradePromotionPath,
																);
															}
															return next;
														});
													}}
													className="mt-1 rounded border border-gray-300 px-2 py-1"
												>
													{/* 初期値を空にし、選び忘れと、初期値のままの誤った進路を防ぐ */}
													<option value="">進路を選ぶ</option>
													<option value="graduate">卒業</option>
													<option value="continue">
														{continueLabel(target.grade, target.continueGrade)}
													</option>
												</select>
											</li>
										);
									})}
								</ul>
							</>
						)}

						{automaticTargets.length > 0 && (
							<>
								<h2 className="mt-4 text-sm font-bold">自動で上がる人</h2>
								<ul className="mt-1 divide-y divide-gray-200 border-y border-gray-200">
									{automaticTargets.map((target) => (
										<li key={target.id} className="py-2 text-sm">
											<p className="break-all font-bold">
												{targetName(target)}
											</p>
											<p className="break-all text-xs text-gray-600">
												{target.email}
											</p>
											<p className="text-xs text-gray-600">
												{formatGrade(target.grade)} → {formatGrade(target.next)}
											</p>
										</li>
									))}
								</ul>
							</>
						)}

						<button
							type="button"
							disabled={!isExecutable}
							onClick={() => {
								// 前のダイアログの失敗の文言を残さない
								promotionMutation.reset();
								setResultMessage(null);
								setPendingPromotion({
									academicYear: data.academicYear,
									paths,
									targetCount: targets.length,
									graduateCount: paths.filter(({ path }) => path === "graduate")
										.length,
								});
							}}
							className="mt-4 rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-40"
						>
							学年更新を実行
						</button>
					</>
				))}

			<ConfirmDialog
				isOpen={pendingPromotion !== null}
				message={pendingPromotion ? confirmMessage(pendingPromotion) : ""}
				isPending={promotionMutation.isPending}
				errorMessage={
					promotionMutation.isError
						? promotionErrorMessage(promotionMutation.error)
						: null
				}
				isResendable={!isClientError(promotionMutation.error)}
				onConfirm={() => {
					if (pendingPromotion) {
						promotionMutation.mutate(pendingPromotion);
					}
				}}
				onClose={() => setPendingPromotion(null)}
			/>
		</section>
	);
}
