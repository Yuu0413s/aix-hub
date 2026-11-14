import { eq } from "drizzle-orm";
import type { Grade } from "../../src/shared/grade";
import type { ParticipationStatus } from "../../src/shared/participation-status";
import type {
	ScheduleTemplateSlot,
	SlotKind,
} from "../../src/shared/schedule-template";
import type { UserRole } from "../../src/shared/user-role";
import { createId } from "../../src/worker/db/id";
import {
	announcements,
	conferenceParticipants,
	conferenceSeries,
	conferences,
	reservations,
	seminarDays,
	slots,
	users,
} from "../../src/worker/db/schema";
import { signInAsNewUser, type useTestUsers } from "./sign-in";
import { deleteConferenceSeries } from "./test-db";

// 配列の要素は型の上では undefined がありうる（noUncheckedIndexedAccess）ため、
// 取り出すところで一度だけ確かめ、以降は string として使えるようにする
export function idAt(ids: string[], index: number): string {
	const id = ids[index];
	if (id === undefined) {
		throw new Error(`${index} 番目の id がありません`);
	}
	return id;
}

// 開催日の状態。省略したときの値は insertDayWithSlots にだけ書く（insertDay はそのまま渡す）
type DayOptions = { status?: "open" | "closed"; closedReason?: string | null };

export type ReservationStatus = "reserved" | "done";

// 学会の列のうち、テストで値を変えるもの。省略した列は NULL（title は insertConference が作る）。
// updatedAt は「最終更新」の表示を確かめるテストで渡す（省略すれば DB の既定で今の時刻になる）
export type ConferenceValues = Partial<
	Omit<typeof conferences.$inferInsert, "id" | "seriesId" | "createdAt">
>;

// テストのデータを DB に直接入れる。ユーザーは testUsers のアドレスで作り、テストごとに片付けられるようにする。
// 開催日・枠・予約・連絡は、呼ぶ側が deleteSeminarDaysBetween で片付ける。
// 学会シリーズ・学会・参加者は、呼ぶ側が afterEach で deleteInsertedConferences を呼んで片付ける
export function testData(testUsers: ReturnType<typeof useTestUsers>) {
	// 作った学会シリーズ。片付け（deleteInsertedConferences）で、その学会と参加者ごと消す
	let insertedSeriesIds: string[] = [];

	// 開催日と、時刻を指定した枠を作る。枠の id を slotRows の順で返す（insertDay もこれを使う）。
	// テストの時間はほぼ Neon との往復待ちのため、開催日と枠は batch で1回の往復で入れる（batch は並べた順に実行する）
	async function insertDayWithSlots(
		date: string,
		slotRows: ScheduleTemplateSlot[],
		{ status = "open", closedReason = null }: DayOptions = {},
	): Promise<string[]> {
		const db = testUsers.db();
		const seminarDayId = createId();
		const insertSeminarDay = db
			.insert(seminarDays)
			.values({ id: seminarDayId, date, status, closedReason });
		const rows = slotRows.map((slot) => ({
			id: createId(),
			seminarDayId,
			...slot,
		}));
		// 空の配列で insert すると Drizzle が例外を投げるため、枠の無い開催日では開催日だけを入れる
		if (rows.length > 0) {
			await db.batch([insertSeminarDay, db.insert(slots).values(rows)]);
		} else {
			await insertSeminarDay;
		}
		return rows.map((row) => row.id);
	}

	// 予約を作り、id を返す
	async function insertReservation(
		slotId: string,
		userId: string,
		status: ReservationStatus = "reserved",
	) {
		const id = createId();
		await testUsers
			.db()
			.insert(reservations)
			.values({ id, slotId, userId, status });
		return id;
	}

	return {
		insertDayWithSlots,

		// 開催日と、kinds の順に枠を作り、枠の id を kinds の順で返す。開始時刻は同じ日の中で重ならないよう 13:00 から 10 分ずつずらす。
		// 時刻は「13 時台」の文字列で作るため、kinds は5個まで（6個目は終了が 13:60 になり、DB のエラーになる）
		async insertDay(
			date: string,
			{ kinds = [], ...dayOptions }: DayOptions & { kinds?: SlotKind[] } = {},
		) {
			return insertDayWithSlots(
				date,
				kinds.map((kind, index) => ({
					period: 3,
					startTime: `13:${String(index * 10).padStart(2, "0")}`,
					endTime: `13:${String(index * 10 + 10).padStart(2, "0")}`,
					kind,
				})),
				dayOptions,
			);
		},

		// プロフィール登録済みのユーザーを作り、id を返す
		async insertUser(
			displayName: string,
			grade: Grade | null,
			role: UserRole = "student",
		) {
			const id = createId();
			await testUsers.db().insert(users).values({
				id,
				name: "テスト",
				email: testUsers.uniqueEmail(),
				displayName,
				grade,
				role,
			});
			return id;
		},

		insertReservation,

		// date の開催日に presentation の枠を1つ作り、userId の予約を入れる。予約の id を返す
		async insertReservationOnNewSlot(
			date: string,
			userId: string,
			status: ReservationStatus = "reserved",
		) {
			const slotIds = await insertDayWithSlots(date, [
				{
					period: 3,
					startTime: "13:00",
					endTime: "13:10",
					kind: "presentation",
				},
			]);
			return insertReservation(idAt(slotIds, 0), userId, status);
		},

		// 枠に入っている予約（予約者と状態）
		findReservationsBySlot(slotId: string) {
			return testUsers
				.db()
				.select({ userId: reservations.userId, status: reservations.status })
				.from(reservations)
				.where(eq(reservations.slotId, slotId));
		},

		async isReservationExisting(reservationId: string) {
			const rows = await testUsers
				.db()
				.select({ id: reservations.id })
				.from(reservations)
				.where(eq(reservations.id, reservationId));
			return rows.length > 0;
		},

		// date の開催日に連絡を作り、id を返す。開始日が空の連絡は作成日から表示するため、作成日時は省略させない
		async insertAnnouncement({
			date,
			authorId,
			createdAt,
			body = "連絡",
			displayFrom = null,
			displayUntil = null,
		}: {
			date: string;
			authorId: string;
			createdAt: Date;
			body?: string;
			displayFrom?: string | null;
			displayUntil?: string | null;
		}) {
			const [day] = await testUsers
				.db()
				.select({ id: seminarDays.id })
				.from(seminarDays)
				.where(eq(seminarDays.date, date));
			if (!day) {
				throw new Error(`${date} の開催日がありません`);
			}
			const id = createId();
			await testUsers.db().insert(announcements).values({
				id,
				seminarDayId: day.id,
				authorId,
				body,
				displayFrom,
				displayUntil,
				createdAt,
				updatedAt: createdAt,
			});
			return id;
		},

		async findAnnouncement(announcementId: string) {
			const [announcement] = await testUsers
				.db()
				.select()
				.from(announcements)
				.where(eq(announcements.id, announcementId));
			return announcement;
		},

		findAnnouncementsByAuthor(authorId: string) {
			return testUsers
				.db()
				.select({ id: announcements.id })
				.from(announcements)
				.where(eq(announcements.authorId, authorId));
		},

		// プロフィール登録済みのユーザーとしてログインし、API に付けて送るクッキーと、ユーザーの id を返す
		async signInWithProfile(role: UserRole = "student") {
			const email = testUsers.uniqueEmail();
			const cookie = await signInAsNewUser(email, testUsers.env());
			const [user] = await testUsers
				.db()
				.update(users)
				.set({
					displayName: "テスト",
					grade: role === "teacher" ? null : "B3",
					role,
				})
				.where(eq(users.email, email))
				.returning({ id: users.id });
			if (!user) {
				throw new Error("ログインしたユーザーが見つかりません");
			}
			return { cookie, userId: user.id };
		},

		// 学会シリーズを作り、id を返す。name は UNIQUE で、テスト用 DB はほかのテストファイルと共有するため、毎回別の名前にする
		async insertConferenceSeries(name = `テストシリーズ ${createId()}`) {
			const id = createId();
			await testUsers.db().insert(conferenceSeries).values({ id, name });
			insertedSeriesIds.push(id);
			return id;
		},

		// テストの中で API やサービスが作ったシリーズを、片付け（deleteInsertedConferences）の対象に加える。
		// そのシリーズに API で作った学会と参加者も、片付けで一緒に消える
		trackConferenceSeries(seriesId: string) {
			insertedSeriesIds.push(seriesId);
		},

		// seriesId のシリーズに学会を作り、id を返す。title は UNIQUE のため、省略したときは毎回別の名前にする
		async insertConference(seriesId: string, values: ConferenceValues = {}) {
			const id = createId();
			await testUsers
				.db()
				.insert(conferences)
				.values({ title: `テスト学会 ${createId()}`, ...values, id, seriesId });
			return id;
		},

		// 学会に参加者を入れ、id を返す
		async insertParticipant(
			conferenceId: string,
			userId: string,
			status: ParticipationStatus,
		) {
			const id = createId();
			await testUsers
				.db()
				.insert(conferenceParticipants)
				.values({ id, conferenceId, userId, status });
			return id;
		},

		// 学会の参加者の行（id・userId・状態）を、DB から直接読む。参加の追加・変更・取消で、DB に何が残ったかを確かめるため
		findParticipants(conferenceId: string) {
			return testUsers
				.db()
				.select({
					id: conferenceParticipants.id,
					userId: conferenceParticipants.userId,
					status: conferenceParticipants.status,
				})
				.from(conferenceParticipants)
				.where(eq(conferenceParticipants.conferenceId, conferenceId));
		},

		// このテストで作った学会シリーズを、学会と参加者ごと消す。呼ぶ側の afterEach で呼ぶ
		async deleteInsertedConferences() {
			await deleteConferenceSeries(testUsers.db(), insertedSeriesIds);
			insertedSeriesIds = [];
		},
	};
}
