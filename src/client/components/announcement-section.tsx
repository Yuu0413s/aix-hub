import {
	type UseQueryResult,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { useState } from "react";
import { announcementErrorMessage } from "../lib/announcement-error";
import {
	ApiError,
	api,
	isClientError,
	isRetryable,
	readErrorCode,
} from "../lib/api";
import { useMe } from "../lib/auth-client";
import { formatDate } from "../lib/format-date";
import { AnnouncementForm } from "./announcement-form";
import { ConfirmDialog } from "./confirm-dialog";

// 形は、一覧の API の成功時のレスポンスの型から作る（手で書くと、API を変えたときに食い違うため）。
// 表示中（?current）と表示前（/upcoming）は同じ形で返る
type Announcement = InferResponseType<
	typeof api.api.announcements.$get,
	200
>["announcements"][number];

// 開いている入力欄。新しく書く欄か、どの連絡の編集か（一度に1つだけ開く）。
// 編集は、押したときの連絡の写しを持つ。入力欄を一覧から作ると、一覧を取り直したときに
// （ほかの人に消された・取り直しに失敗した）入力欄ごと消え、入力中の本文や失敗の文言が失われるため
type Editing =
	| { kind: "new" }
	| { kind: "edit"; announcement: Announcement }
	| null;

async function toFetchError(res: Response) {
	return new ApiError(
		res.status,
		`全体連絡を取得できませんでした: ${res.status}`,
		await readErrorCode(res),
	);
}

// トップの「今週の全体連絡」。teacher / admin はここから書き、自分の分（admin は全員分）を編集・削除できる
export function AnnouncementSection() {
	const me = useMe();
	const isWriter = me.role === "teacher" || me.role === "admin";

	const currentQuery = useQuery({
		queryKey: ["announcements", "current"],
		queryFn: async () => {
			const res = await api.api.announcements.$get({ query: { current: "" } });
			if (!res.ok) {
				throw await toFetchError(res);
			}
			return res.json();
		},
		retry: isRetryable,
	});
	// 表示前の連絡はトップに出ないため、書く人にだけ別に出す（書いた直後に確認・修正できるように）
	const upcomingQuery = useQuery({
		queryKey: ["announcements", "upcoming"],
		queryFn: async () => {
			const res = await api.api.announcements.upcoming.$get();
			if (!res.ok) {
				throw await toFetchError(res);
			}
			return res.json();
		},
		retry: isRetryable,
		enabled: isWriter,
	});

	const [editing, setEditing] = useState<Editing>(null);

	const queryClient = useQueryClient();
	// 削除のダイアログで確かめている連絡。押したときの連絡を持つ
	// （ダイアログを開いている間に一覧が取り直されても、確かめた連絡とは別の連絡を消さないため。me.tsx の取消と同じ）
	const [pendingDelete, setPendingDelete] = useState<Announcement | null>(null);
	const deleteMutation = useMutation({
		mutationFn: async (announcement: Announcement) => {
			const res = await api.api.announcements[":id"].$delete({
				param: { id: announcement.id },
			});
			if (!res.ok) {
				throw new ApiError(
					res.status,
					`送信できませんでした: ${res.status}`,
					await readErrorCode(res),
				);
			}
		},
		// 一覧を取り直し終えてからダイアログを閉じる。先に閉じると、取り直すまでの間、消した連絡の「削除」が押せてしまうため
		onSuccess: async (_, deleted) => {
			await refetchAnnouncements();
			// 閉じるのは、消した連絡のダイアログと入力欄だけにする。
			// 送信中のダイアログをブラウザが閉じた（Android の戻るなど）あとに、別の連絡のダイアログや入力欄が開いていることがあり、
			// それを前の削除の完了で閉じないため（useMutation の onSuccess は、ダイアログを閉じたあとでも呼ばれる）。
			// 入力欄が開いている間は一覧の「削除」を押せないため、入力欄のほうはふだんの操作では通らない念のための守り
			setPendingDelete((current) =>
				current?.id === deleted.id ? null : current,
			);
			setEditing((current) =>
				current?.kind === "edit" && current.announcement.id === deleted.id
					? null
					: current,
			);
		},
		// 失敗したときも取り直す（別の画面で削除済みだったときに、古い一覧を見せ続けないため）
		onError: () => refetchAnnouncements(),
	});

	function refetchAnnouncements() {
		return queryClient.invalidateQueries({ queryKey: ["announcements"] });
	}

	function openDeleteDialog(announcement: Announcement) {
		// 前のダイアログの失敗の文言を残さない
		deleteMutation.reset();
		setPendingDelete(announcement);
	}

	const itemProps = {
		editingId: editing?.kind === "edit" ? editing.announcement.id : null,
		isFormOpen: editing !== null,
		onEdit: (announcement: Announcement) =>
			setEditing({ kind: "edit", announcement }),
		onDelete: openDeleteDialog,
	};

	return (
		<section>
			<div className="flex items-center justify-between">
				<h2 className="font-bold">今週の全体連絡</h2>
				{isWriter && editing === null && (
					<button
						type="button"
						onClick={() => setEditing({ kind: "new" })}
						className="rounded border border-gray-300 px-2 py-1 text-sm"
					>
						連絡を書く
					</button>
				)}
			</div>

			{editing && (
				<div className="mt-2">
					<AnnouncementForm
						// 入力欄が開いている間は一覧の「編集」を押せないため、ふだんは開いたまま別の連絡に切り替わらない。
						// 念のため、連絡が変わったら入力欄の中身を作り直す（前の連絡の本文が残らないように）
						key={editing.kind === "edit" ? editing.announcement.id : "new"}
						announcement={editing.kind === "edit" ? editing.announcement : null}
						onDone={() => setEditing(null)}
						onCancel={() => setEditing(null)}
					/>
				</div>
			)}

			<AnnouncementQueryList
				query={currentQuery}
				emptyMessage="連絡はありません"
				{...itemProps}
			/>

			{isWriter && (
				<>
					<h3 className="mt-4 text-sm font-bold">表示前の連絡</h3>
					<AnnouncementQueryList
						query={upcomingQuery}
						emptyMessage="ありません"
						{...itemProps}
					/>
				</>
			)}

			<ConfirmDialog
				isOpen={pendingDelete !== null}
				message={
					pendingDelete
						? `${formatDate(pendingDelete.date)}の回の連絡を削除しますか？`
						: ""
				}
				isPending={deleteMutation.isPending}
				errorMessage={
					deleteMutation.isError
						? announcementErrorMessage(deleteMutation.error)
						: null
				}
				isResendable={!isClientError(deleteMutation.error)}
				onConfirm={() => {
					if (pendingDelete) {
						deleteMutation.mutate(pendingDelete);
					}
				}}
				onClose={() => setPendingDelete(null)}
			/>
		</section>
	);
}

type ItemHandlers = {
	onEdit: (announcement: Announcement) => void;
	onDelete: (announcement: Announcement) => void;
};

function AnnouncementQueryList({
	query,
	emptyMessage,
	editingId,
	isFormOpen,
	...handlers
}: {
	query: UseQueryResult<{ announcements: Announcement[] }, unknown>;
	emptyMessage: string;
	// 入力欄で編集中の連絡
	editingId: string | null;
	isFormOpen: boolean;
} & ItemHandlers) {
	if (query.isPending) {
		return <p className="mt-2 text-sm text-gray-600">読み込み中…</p>;
	}
	// 再取得に失敗しても TanStack Query は前回の data を残すため、エラー中は一覧を出さない（day.tsx と同じ理由）
	if (query.isError) {
		return (
			<div role="alert" className="mt-2 text-sm text-red-700">
				全体連絡を読み込めませんでした
				<button
					type="button"
					onClick={() => query.refetch()}
					className="ml-2 underline"
				>
					再読み込み
				</button>
			</div>
		);
	}
	if (query.data.announcements.length === 0) {
		return <p className="mt-2 text-sm text-gray-600">{emptyMessage}</p>;
	}
	return (
		<ul className="mt-2 space-y-2">
			{query.data.announcements.map((announcement) => (
				<li key={announcement.id}>
					<AnnouncementItem
						announcement={announcement}
						isEditing={editingId === announcement.id}
						isActionDisabled={isFormOpen}
						{...handlers}
					/>
				</li>
			))}
		</ul>
	);
}

function formatDisplayPeriod(announcement: Announcement) {
	const from = announcement.displayFrom
		? formatDate(announcement.displayFrom)
		: "書いた日";
	const until = announcement.displayUntil
		? formatDate(announcement.displayUntil)
		: "開催日";
	return `${from}〜${until}`;
}

function AnnouncementItem({
	announcement,
	isEditing,
	isActionDisabled,
	onEdit,
	onDelete,
}: {
	announcement: Announcement;
	isEditing: boolean;
	// 入力欄（新規・編集）が開いている間は、ほかの連絡の「編集」「削除」を押させない。
	// 押せると、書きかけの本文が確認なしに入れ替わって消えるほか、保存中に押すと、前の入力欄の保存が終わった時点で
	// 新しく開いた入力欄まで閉じる（useMutation の onSuccess は、入力欄が画面から消えたあとでも呼ばれるため）
	isActionDisabled: boolean;
} & ItemHandlers) {
	return (
		<article className="rounded border border-gray-200 p-3">
			{/* 改行をそのまま見せる。本文は React が文字として出すため、HTML として解釈されない */}
			<p className="whitespace-pre-wrap break-words text-sm">
				{announcement.body}
			</p>
			<p className="mt-2 text-xs text-gray-600">
				{formatDate(announcement.date)}の回・{announcement.authorDisplayName}
			</p>
			{announcement.isEditable && (
				<div className="mt-2 flex items-center justify-between gap-2">
					<p className="text-xs text-gray-600">
						表示：{formatDisplayPeriod(announcement)}
					</p>
					{/* 入力欄は一覧の上に開くため、どの連絡を編集中かをここで示す
					    （入力欄が開いている間、編集・削除を押せなくしているのは isActionDisabled） */}
					{isEditing ? (
						<p className="shrink-0 text-xs font-bold">編集中</p>
					) : (
						<div className="flex shrink-0 gap-2">
							<button
								type="button"
								onClick={() => onEdit(announcement)}
								disabled={isActionDisabled}
								className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-40"
							>
								編集
							</button>
							<button
								type="button"
								onClick={() => onDelete(announcement)}
								disabled={isActionDisabled}
								className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-40"
							>
								削除
							</button>
						</div>
					)}
				</div>
			)}
		</article>
	);
}
