import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useRevalidator } from "react-router";
import { API_ERROR_CODES } from "../../shared/api-errors";
import { formatGrade } from "../../shared/grade";
import { DISPLAY_NAME_MAX_LENGTH } from "../../shared/profile";
import { ConfirmDialog } from "../components/confirm-dialog";
import {
	DisplayNameField,
	isDisplayNameTooLong,
} from "../components/display-name-field";
import { actionErrorMessage } from "../lib/action-error";
import {
	ApiError,
	api,
	isClientError,
	isRetryable,
	readErrorCode,
} from "../lib/api";
import { useMe } from "../lib/auth-client";
import { formatDate } from "../lib/format-date";

// 形は、GET /api/me/reservations の成功時のレスポンスの型から作る（手で書くと、API を変えたときに食い違うため）
type MyReservations = InferResponseType<
	typeof api.api.me.reservations.$get,
	200
>;
type MyReservation = MyReservations["reservations"][number];

const DEFAULT_PROFILE_ERROR_MESSAGE = "表示名を変更できませんでした";
const VALIDATION_ERROR_MESSAGE = `表示名は改行や見えない文字を含めず1〜${DISPLAY_NAME_MAX_LENGTH}文字で入力してください`;

function formatReservationTime(reservation: MyReservation) {
	return `${formatDate(reservation.date)} ${reservation.startTime}〜${reservation.endTime}`;
}

export function MePage() {
	const me = useMe();

	return (
		<main className="mx-auto max-w-md p-4">
			<h1 className="text-xl font-bold">マイページ</h1>
			<ProfileSection />
			{/* teacher は予約できないため、予約一覧と発表回数は出さない（取得もしない） */}
			{me.role !== "teacher" && <ReservationsSection />}
		</main>
	);
}

function ProfileSection() {
	const me = useMe();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const queryClient = useQueryClient();
	const [displayName, setDisplayName] = useState(me.displayName ?? "");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [isUpdated, setIsUpdated] = useState(false);

	function changeDisplayName(value: string) {
		setDisplayName(value);
		// 前の変更の「変更しました」を、書き換え中の名前に対して出し続けないため
		setIsUpdated(false);
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setIsUpdated(false);
		if (isDisplayNameTooLong(displayName)) {
			setSubmitError(VALIDATION_ERROR_MESSAGE);
			return;
		}
		setIsSubmitting(true);
		setSubmitError(null);
		try {
			const res = await api.api.me.profile.$patch({ json: { displayName } });
			if (res.ok) {
				const updated = await res.json();
				// サーバーが前後の空白を取り除いた名前を、入力欄にも反映する
				setDisplayName(updated.displayName ?? "");
				setIsUpdated(true);
				// 自分の情報（親ルートの loader）と、予約者名を出す日別の表を取り直す
				revalidator.revalidate();
				queryClient.invalidateQueries({ queryKey: ["day"] });
			} else {
				// 表示はステータスではなく code で分ける（api.md）
				switch (await readErrorCode(res)) {
					// 入力中にセッションが切れた・別のタブでログアウトしたときは、押し直しても通らないためログインし直してもらう
					case API_ERROR_CODES.UNAUTHORIZED:
						navigate("/login", { replace: true });
						return;
					case API_ERROR_CODES.VALIDATION_ERROR:
						setSubmitError(VALIDATION_ERROR_MESSAGE);
						break;
					default:
						setSubmitError(DEFAULT_PROFILE_ERROR_MESSAGE);
				}
			}
		} catch {
			// 通信そのものが失敗したとき
			setSubmitError(DEFAULT_PROFILE_ERROR_MESSAGE);
		}
		setIsSubmitting(false);
	}

	return (
		<section className="mt-6">
			<h2 className="font-bold">プロフィール</h2>
			<dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
				<dt className="text-gray-600">メール</dt>
				<dd className="break-all">{me.email}</dd>
				<dt className="text-gray-600">学年</dt>
				<dd>
					{me.grade === null ? "教員（学年なし）" : formatGrade(me.grade)}
					<span className="ml-2 text-xs text-gray-600">
						（自分では変更できません）
					</span>
				</dd>
			</dl>
			<form onSubmit={submit} className="mt-4 space-y-2">
				<DisplayNameField
					value={displayName}
					onChange={changeDisplayName}
					isDisabled={isSubmitting}
				/>
				{submitError && (
					<p role="alert" className="text-sm text-red-700">
						{submitError}
					</p>
				)}
				{isUpdated && (
					<p role="status" className="text-sm text-green-700">
						表示名を変更しました
					</p>
				)}
				<button
					type="submit"
					disabled={isSubmitting}
					className="rounded bg-blue-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
				>
					{isSubmitting ? "変更中…" : "表示名を変更する"}
				</button>
			</form>
		</section>
	);
}

function ReservationsSection() {
	const reservationsQuery = useQuery({
		queryKey: ["me", "reservations"],
		queryFn: async () => {
			const res = await api.api.me.reservations.$get();
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`予約を取得できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
			return res.json();
		},
		retry: isRetryable,
	});
	const data = reservationsQuery.data;

	const queryClient = useQueryClient();
	// 取消のダイアログで確かめている予約。押したときの予約を持つ
	// （ダイアログを開いている間に一覧が取り直されても、確かめた予約とは別の予約を消さないため）
	const [pendingCancel, setPendingCancel] = useState<MyReservation | null>(
		null,
	);
	const cancelMutation = useMutation({
		mutationFn: async (reservation: MyReservation) => {
			const res = await api.api.reservations[":id"].$delete({
				param: { id: reservation.id },
			});
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`送信できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
		},
		// 日別の表（day.tsx）と同じく、一覧を取り直し終えてからダイアログを閉じる。
		// 先に閉じると、取り直すまでの間、取り消した予約の「取消」が押せてしまうため
		onSuccess: async () => {
			await refetchReservations();
			setPendingCancel(null);
		},
		// 失敗したときも取り直す（別の画面で取り消し済みだったときに、古い一覧を見せ続けないため）
		onError: () => refetchReservations(),
	});

	// 取消で空いた枠が日別の表・カレンダーの空き枠の数にも出るよう、それらも取り直させる
	function refetchReservations() {
		return Promise.all([
			queryClient.invalidateQueries({ queryKey: ["me", "reservations"] }),
			queryClient.invalidateQueries({ queryKey: ["day"] }),
			queryClient.invalidateQueries({ queryKey: ["days"] }),
		]);
	}

	function openDialog(reservation: MyReservation) {
		// 前のダイアログの失敗の文言を残さない
		cancelMutation.reset();
		setPendingCancel(reservation);
	}

	return (
		<section className="mt-8">
			<h2 className="font-bold">予約</h2>

			{reservationsQuery.isPending && (
				<p className="mt-2 text-sm text-gray-600">読み込み中…</p>
			)}
			{reservationsQuery.isError && (
				<div role="alert" className="mt-2 text-sm text-red-700">
					予約を読み込めませんでした
					<button
						type="button"
						onClick={() => reservationsQuery.refetch()}
						className="ml-2 underline"
					>
						再読み込み
					</button>
				</div>
			)}

			{/* 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中は一覧を出さない（day.tsx と同じ理由） */}
			{data && !reservationsQuery.isError && (
				<ReservationSummary data={data} onCancel={openDialog} />
			)}

			<ConfirmDialog
				isOpen={pendingCancel !== null}
				message={pendingCancel ? cancelMessage(pendingCancel) : ""}
				isPending={cancelMutation.isPending}
				errorMessage={
					cancelMutation.isError
						? actionErrorMessage(cancelMutation.error)
						: null
				}
				isResendable={!isClientError(cancelMutation.error)}
				onConfirm={() => {
					if (pendingCancel) {
						cancelMutation.mutate(pendingCancel);
					}
				}}
				onClose={() => setPendingCancel(null)}
			/>
		</section>
	);
}

function cancelMessage(reservation: MyReservation) {
	const message = `${formatReservationTime(reservation)} の予約を取り消しますか？`;
	// admin は実施済みの予約も取り消せる。発表回数が減ることを、押す前に分かるようにする
	return reservation.status === "done"
		? `${message}（実施済みの予約です。発表回数から外れます）`
		: message;
}

// done は開始時刻を過ぎているはずだが、状態と時刻のどちらか一方でも「過ぎた」なら実施済みとして扱う
function isPastReservation(reservation: MyReservation) {
	return reservation.status === "done" || reservation.isStarted;
}

// 発表回数と、予約中・実施済みの一覧
function ReservationSummary({
	data,
	onCancel,
}: {
	data: MyReservations;
	onCancel: (reservation: MyReservation) => void;
}) {
	// 開始時刻を過ぎた予約は、「済」（done）になる前の当日でも実施済みに入れる（「済」にするのは毎晩の Cron のため）。
	// API は古い順に返す。予約中は次の予約がすぐ見つかるよう古い（近い）順、実施済みは新しい順に並べる
	const reservedList = data.reservations.filter(
		(reservation) => !isPastReservation(reservation),
	);
	const doneList = data.reservations.filter(isPastReservation).reverse();

	return (
		<>
			<p className="mt-2 text-sm">
				発表回数：<span className="font-bold">{data.presentationCount}</span>回
			</p>
			<h3 className="mt-4 text-sm font-bold">予約中</h3>
			<ReservationList
				reservations={reservedList}
				emptyMessage="予約はありません"
				onCancel={onCancel}
			/>
			<h3 className="mt-4 text-sm font-bold">実施済み</h3>
			<ReservationList
				reservations={doneList}
				emptyMessage="まだありません"
				onCancel={onCancel}
			/>
		</>
	);
}

function ReservationList({
	reservations,
	emptyMessage,
	onCancel,
}: {
	reservations: MyReservation[];
	emptyMessage: string;
	onCancel: (reservation: MyReservation) => void;
}) {
	if (reservations.length === 0) {
		return <p className="mt-1 text-sm text-gray-600">{emptyMessage}</p>;
	}
	return (
		<ul className="mt-1 divide-y divide-gray-200 border-y border-gray-200">
			{reservations.map((reservation) => (
				<li
					key={reservation.id}
					className="flex items-center justify-between gap-2 py-2 text-sm"
				>
					<span>
						<Link
							to={`/days/${reservation.date}`}
							className="text-blue-700 underline underline-offset-2"
						>
							{formatReservationTime(reservation)}
						</Link>
						{/* 実施済みに並んでいても、発表回数はまだ数えていないことを伝える */}
						{reservation.status === "reserved" && reservation.isStarted && (
							<span className="ml-2 text-xs text-gray-600">
								（発表回数には翌日に反映）
							</span>
						)}
					</span>
					{reservation.isCancelable && (
						<button
							type="button"
							onClick={() => onCancel(reservation)}
							className="shrink-0 rounded border border-gray-300 px-2 py-1 text-xs"
						>
							取消
						</button>
					)}
				</li>
			))}
		</ul>
	);
}
