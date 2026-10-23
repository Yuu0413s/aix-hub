import { eq } from "drizzle-orm";
import type { Grade } from "../../src/shared/grade";
import type {
	ScheduleTemplateSlot,
	SlotKind,
} from "../../src/shared/schedule-template";
import { createId } from "../../src/worker/db/id";
import {
	reservations,
	seminarDays,
	slots,
	users,
} from "../../src/worker/db/schema";
import type { UserRole } from "../../src/worker/middleware/auth";
import { signInAsNewUser, type useTestUsers } from "./sign-in";

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

// テストのデータを DB に直接入れる。ユーザーは testUsers のアドレスで作り、テストごとに片付けられるようにする。
// 開催日・枠・予約は、呼ぶ側が deleteSeminarDaysBetween で片付ける
export function testData(testUsers: ReturnType<typeof useTestUsers>) {
	// 開催日と、時刻を指定した枠を作る。枠の id を slotRows の順で返す（insertDay もこれを使う）
	async function insertDayWithSlots(
		date: string,
		slotRows: ScheduleTemplateSlot[],
		{ status = "open", closedReason = null }: DayOptions = {},
	): Promise<string[]> {
		const seminarDayId = createId();
		await testUsers
			.db()
			.insert(seminarDays)
			.values({ id: seminarDayId, date, status, closedReason });
		const rows = slotRows.map((slot) => ({
			id: createId(),
			seminarDayId,
			...slot,
		}));
		// 空の配列で insert すると Drizzle が例外を投げるため、枠の無い開催日では入れない
		if (rows.length > 0) {
			await testUsers.db().insert(slots).values(rows);
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

		// プロフィール登録済みのユーザーとしてログインし、API に付けて送るクッキーと、ユーザーの id を返す
		async signInWithProfile(role: UserRole = "student") {
			const email = testUsers.uniqueEmail();
			const cookie = await signInAsNewUser(email);
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
	};
}
