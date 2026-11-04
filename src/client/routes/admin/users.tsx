import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useRevalidator } from "react-router";
import { API_ERROR_CODES } from "../../../shared/api-errors";
import {
	formatDisplayName,
	formatGrade,
	GRADES,
	type Grade,
} from "../../../shared/grade";
import {
	USER_ROLE_LABELS,
	USER_ROLES,
	type UserRole,
} from "../../../shared/user-role";
import { ConfirmDialog } from "../../components/confirm-dialog";
import {
	ApiError,
	api,
	isClientError,
	isRetryable,
	readErrorCode,
} from "../../lib/api";
import { useMe } from "../../lib/auth-client";
import { useAdminNotice } from "./layout";

const FORBIDDEN_MESSAGE = "この画面は管理者だけが見られます";

function userName(user: { displayName: string | null; grade: Grade | null }) {
	return user.displayName === null
		? "（未登録）"
		: formatDisplayName(user.displayName, user.grade);
}

// 確認ダイアログで何をしようとしているか。名前と変更前の役割は押したときの値で持つ
// （ダイアログを開いている間に一覧が取り直されても、確かめた内容と違う文言にしないため）
type PendingChange = {
	userId: string;
	name: string;
	currentRole: UserRole;
	role: UserRole;
	// 学年の無い人を student にするときに選んだ学年。それ以外は null
	grade: Grade | null;
	isSelf: boolean;
};

// 何を変えるか。学年の無い student は、役割を変えずに学年だけを選ぶことがある
function describeChange({ name, currentRole, role, grade }: PendingChange) {
	const changes = [
		...(role !== currentRole ? [`役割を「${USER_ROLE_LABELS[role]}」`] : []),
		...(grade !== null ? [`学年を「${formatGrade(grade)}」`] : []),
	];
	return `${name} の${changes.join("、")}に変更`;
}

function confirmMessage(change: PendingChange) {
	const { currentRole, role, isSelf } = change;
	const notes = [
		// 画面を開いている間に予約が入っていても、注意を見ずに消さないよう、予約の有無にかかわらず書く
		...(role === "teacher"
			? [
					"学年は消えます（学生に戻すときは選び直します）。開始前の予約があれば削除されます。",
				]
			: []),
		...(isSelf && currentRole === "admin" && role !== "admin"
			? ["自分の管理者権限がなくなり、管理画面に入れなくなります。"]
			: []),
	];
	return [`${describeChange(change)}しますか？`, ...notes].join("");
}

// 送信の失敗の文言。4xx は送り直しても結果が変わらないため、ダイアログは「はい」を出さない（action-error.ts と同じ考え方）
function changeErrorMessage(error: unknown) {
	switch (error instanceof ApiError ? error.code : null) {
		case API_ERROR_CODES.UNAUTHORIZED:
			return "ログインの有効期限が切れました。ページを再読み込みして、ログインし直してください";
		case API_ERROR_CODES.FORBIDDEN:
			return "この操作を行う権限がありません";
		case API_ERROR_CODES.USER_NOT_FOUND:
			return "この利用者は見つかりませんでした";
		case API_ERROR_CODES.LAST_ADMIN:
			return "在籍中の管理者がいなくなるため、変更できません。先にほかの人を管理者にしてください";
		case API_ERROR_CODES.GRADE_REQUIRED:
			return "学年が空になっています。一覧で学年を選んでから、もう一度変更してください";
	}
	return isClientError(error)
		? "送信できませんでした。ページを再読み込みしてください"
		: "送信できませんでした。時間をおいてもう一度お試しください";
}

export function AdminUsersPage() {
	const me = useMe();
	const usersQuery = useQuery({
		queryKey: ["admin", "users"],
		queryFn: async () => {
			const res = await api.api.admin.users.$get();
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`利用者を取得できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return res.json();
		},
		retry: isRetryable,
	});
	// 画面を開いた後に役割が変わったとき（loader の自分の情報は古いまま）は、API の 403 で分かる
	const isForbidden =
		usersQuery.error instanceof ApiError &&
		usersQuery.error.code === API_ERROR_CODES.FORBIDDEN;

	// セレクトで選び、まだ送っていない役割と学年（利用者の id ごと）
	const [drafts, setDrafts] = useState(
		new Map<string, { role: UserRole; grade: Grade | null }>(),
	);
	const [pendingChange, setPendingChange] = useState<PendingChange | null>(
		null,
	);
	// 直前の操作の結果を出す。次の操作を始めたら消す
	const setNotice = useAdminNotice();

	const queryClient = useQueryClient();
	const revalidator = useRevalidator();
	const changeMutation = useMutation({
		mutationFn: async ({ userId, role, grade }: PendingChange) => {
			const res = await api.api.admin.users[":id"].$patch({
				param: { id: userId },
				json: grade !== null ? { role, grade } : { role },
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
		// 取り直し終えてから閉じる（days.tsx と同じ理由。取り直すまでの間、古い状態のボタンを押せないように）。
		// 結果は取り直す前に出す。自分の admin を外すと、取り直しの間にこの画面が消えるため
		onSuccess: async (result, change) => {
			setNotice(
				`${describeChange(change)}しました${
					change.role === "teacher"
						? `（削除した予約: ${result.deletedReservationCount}件）`
						: ""
				}`,
			);
			await refetchAfterChange(change.isSelf);
			setDrafts((current) => {
				const next = new Map(current);
				next.delete(change.userId);
				return next;
			});
			setPendingChange(null);
		},
		// 失敗したときも取り直す。ほかの管理者が先に変えていたときに、古い状態を見せ続けないため。
		// 自分の情報を取り直すのは 403（自分の権限が変わった）のときだけにする。通信の失敗のときに取り直すと、
		// それも失敗して画面全体がエラーに変わり、ダイアログからの再送ができなくなるため
		onError: (error) =>
			refetchAfterChange(
				error instanceof ApiError && error.code === API_ERROR_CODES.FORBIDDEN,
			),
	});

	// 役割・学年・予約が変わると、一覧・枠の表・発表回数・マイページなど多くの画面に影響するため、キャッシュをすべて取り直させる。
	// 自分の役割が変わったら、ヘッダーと管理画面のタブが使う自分の情報（loader）も取り直す
	function refetchAfterChange(isMyRoleChanged: boolean) {
		return Promise.all([
			queryClient.invalidateQueries(),
			isMyRoleChanged ? revalidator.revalidate() : undefined,
		]);
	}

	function openDialog(change: PendingChange) {
		// 前のダイアログの失敗の文言を残さない
		changeMutation.reset();
		setNotice(null);
		setPendingChange(change);
	}

	const data = usersQuery.data;

	return (
		<section className="mt-4">
			{usersQuery.isPending && (
				<p className="text-sm text-gray-600">読み込み中…</p>
			)}
			{isForbidden && (
				<p role="alert" className="text-sm text-red-700">
					{FORBIDDEN_MESSAGE}
				</p>
			)}
			{usersQuery.isError && !isForbidden && (
				<div role="alert" className="text-sm text-red-700">
					利用者を読み込めませんでした
					<button
						type="button"
						onClick={() => usersQuery.refetch()}
						className="ml-2 underline"
					>
						再読み込み
					</button>
				</div>
			)}

			{/* 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中は一覧を出さない（古い状態のまま操作させないため） */}
			{data && !usersQuery.isError && (
				<ul className="divide-y divide-gray-200 border-y border-gray-200">
					{data.users.map((user) => {
						const name = userName(user);
						const draft = drafts.get(user.id);
						const selectedRole = draft?.role ?? user.role;
						const selectedGrade = draft?.grade ?? null;
						// 学生は学年を必ず持つため、学年の無い人を student にするときは学年も選ぶ
						const isGradeRequired =
							selectedRole === "student" && user.grade === null;
						const isSubmittable = isGradeRequired
							? selectedGrade !== null
							: selectedRole !== user.role;
						const updateDraft = (role: UserRole, grade: Grade | null) => {
							setDrafts((current) => {
								const next = new Map(current);
								// 今の役割に戻したら選択を消す。残すと、ほかの管理者が変えたあとも選んだ値のまま見えるため
								if (role === user.role && grade === null) {
									next.delete(user.id);
								} else {
									next.set(user.id, { role, grade });
								}
								return next;
							});
						};

						return (
							<li key={user.id} className="py-2 text-sm">
								<p className="break-all font-bold">
									{name}
									{!user.isEnrolled && (
										<span className="ml-2 font-normal text-gray-600">卒業</span>
									)}
								</p>
								<p className="break-all text-xs text-gray-600">{user.email}</p>
								{/* セレクトは送る前の値も出すため、今の役割は別に出す（失敗や取消のあとに、実際の役割と見間違えないように） */}
								<p className="text-xs text-gray-600">
									今の役割：{USER_ROLE_LABELS[user.role]}
								</p>
								<div className="mt-1 flex items-center gap-2">
									<select
										aria-label={`${name} の役割`}
										value={selectedRole}
										onChange={(event) =>
											updateDraft(event.target.value as UserRole, null)
										}
										className="rounded border border-gray-300 px-2 py-1"
									>
										{USER_ROLES.map((role) => (
											<option key={role} value={role}>
												{USER_ROLE_LABELS[role]}
											</option>
										))}
									</select>
									{isGradeRequired && (
										<select
											aria-label={`${name} の学年`}
											value={selectedGrade ?? ""}
											onChange={(event) =>
												updateDraft(
													selectedRole,
													event.target.value === ""
														? null
														: (event.target.value as Grade),
												)
											}
											className="rounded border border-gray-300 px-2 py-1"
										>
											<option value="">学年を選ぶ</option>
											{GRADES.map((grade) => (
												<option key={grade} value={grade}>
													{formatGrade(grade)}
												</option>
											))}
										</select>
									)}
									<button
										type="button"
										disabled={!isSubmittable}
										onClick={() =>
											openDialog({
												userId: user.id,
												name,
												currentRole: user.role,
												role: selectedRole,
												grade: isGradeRequired ? selectedGrade : null,
												isSelf: user.id === me.id,
											})
										}
										className="rounded border border-gray-300 px-2 py-1 disabled:opacity-40"
									>
										変更
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			)}

			<ConfirmDialog
				isOpen={pendingChange !== null}
				message={pendingChange ? confirmMessage(pendingChange) : ""}
				isPending={changeMutation.isPending}
				errorMessage={
					changeMutation.isError
						? changeErrorMessage(changeMutation.error)
						: null
				}
				isResendable={!isClientError(changeMutation.error)}
				onConfirm={() => {
					if (pendingChange) {
						changeMutation.mutate(pendingChange);
					}
				}}
				onClose={() => setPendingChange(null)}
			/>
		</section>
	);
}
