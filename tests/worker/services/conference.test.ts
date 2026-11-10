import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createId } from "../../../src/worker/db/id";
import { conferenceSeries, conferences } from "../../../src/worker/db/schema";
import {
	findConference,
	findConferences,
} from "../../../src/worker/services/conference";
import { useTestUsers } from "../../helpers/sign-in";
import { testData } from "../../helpers/test-data";

// 今日の日付は引数で渡す（実際の日付によって結果が変わらないように）。ほかのテストが使っていない年にする
const TODAY = "2046-06-10";
const YESTERDAY = "2046-06-09";
const TOMORROW = "2046-06-11";
const LATER = "2046-07-01";
const EARLIER = "2046-05-01";

describe("学会の一覧・詳細（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const {
		insertUser,
		insertConferenceSeries,
		insertConference,
		insertParticipant,
		deleteInsertedConferences,
	} = testData(testUsers);
	// テストごとに別の文字列を学会名の先頭に付け、同じ締切の学会を学会名で並べるテストで順番を決められるようにする
	let prefix: string;

	beforeEach(() => {
		prefix = `テスト ${createId()}`;
	});

	afterEach(async () => {
		await deleteInsertedConferences();
	});

	// テスト用 DB はほかのテストファイルと共有するため、一覧はこのテストで作った学会だけに絞って確かめる
	async function listIds(status: "open" | "closed", ids: string[]) {
		const rows = await findConferences(testUsers.db(), {
			status,
			today: TODAY,
		});
		return rows.map((row) => row.id).filter((id) => ids.includes(id));
	}

	describe("テーブルの制約", () => {
		test("開始日が終了日より後の学会は DB に入れられない", async () => {
			const seriesId = await insertConferenceSeries();

			await expect(
				insertConference(seriesId, { startDate: TOMORROW, endDate: TODAY }),
			).rejects.toThrow();
		});

		test("開始日と終了日が同じ日、または片方が空欄なら入れられる", async () => {
			const seriesId = await insertConferenceSeries();

			await insertConference(seriesId, { startDate: TODAY, endDate: TODAY });
			await insertConference(seriesId, { startDate: TODAY, endDate: null });
			await insertConference(seriesId, { startDate: null, endDate: TODAY });
		});

		test("同じ学会名の学会は2つ入れられない", async () => {
			const seriesId = await insertConferenceSeries();
			await insertConference(seriesId, { title: `${prefix} DEIM` });

			await expect(
				insertConference(seriesId, { title: `${prefix} DEIM` }),
			).rejects.toThrow();
		});

		test("同じ名前のシリーズは2つ入れられない", async () => {
			await insertConferenceSeries(`${prefix} DEIM`);

			await expect(insertConferenceSeries(`${prefix} DEIM`)).rejects.toThrow();
		});

		test("同じ人は同じ学会に2回参加できない", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId);
			const userId = await insertUser("Shibata", "B3");
			await insertParticipant(conferenceId, userId, "considering");

			await expect(
				insertParticipant(conferenceId, userId, "planning"),
			).rejects.toThrow();
		});

		test("学会のあるシリーズは消せない（RESTRICT）", async () => {
			const seriesId = await insertConferenceSeries();
			await insertConference(seriesId);

			await expect(
				testUsers
					.db()
					.delete(conferenceSeries)
					.where(eq(conferenceSeries.id, seriesId))
					// Drizzle のクエリは await できるが Promise ではないため、rejects に渡せるよう execute() で Promise にする
					.execute(),
			).rejects.toThrow();
		});

		test("参加者のいる学会は消せない（RESTRICT）", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId);
			const userId = await insertUser("Shibata", "B3");
			await insertParticipant(conferenceId, userId, "considering");

			await expect(
				testUsers
					.db()
					.delete(conferences)
					.where(eq(conferences.id, conferenceId))
					// Drizzle のクエリは await できるが Promise ではないため、rejects に渡せるよう execute() で Promise にする
					.execute(),
			).rejects.toThrow();
		});
	});

	describe("受付中・締切済みの判定（findConferences）", () => {
		test("締切が今日・明日の学会と、締切が空欄の学会は、受付中にだけ入る", async () => {
			const seriesId = await insertConferenceSeries();
			const ids = [
				await insertConference(seriesId, { submissionDeadline: TODAY }),
				await insertConference(seriesId, { submissionDeadline: TOMORROW }),
				await insertConference(seriesId, { submissionDeadline: null }),
			];

			expect((await listIds("open", ids)).toSorted()).toEqual(ids.toSorted());
			expect(await listIds("closed", ids)).toEqual([]);
		});

		test("締切が昨日の学会は、締切済みにだけ入る", async () => {
			const seriesId = await insertConferenceSeries();
			const ids = [
				await insertConference(seriesId, { submissionDeadline: YESTERDAY }),
			];

			expect(await listIds("closed", ids)).toEqual(ids);
			expect(await listIds("open", ids)).toEqual([]);
		});

		// どちらのタブにも出ない学会ができないことを確かめる
		test("作った学会は、受付中と締切済みのどちらか一方に必ず入る", async () => {
			const seriesId = await insertConferenceSeries();
			const ids = [
				await insertConference(seriesId, { submissionDeadline: EARLIER }),
				await insertConference(seriesId, { submissionDeadline: YESTERDAY }),
				await insertConference(seriesId, { submissionDeadline: TODAY }),
				await insertConference(seriesId, { submissionDeadline: LATER }),
				await insertConference(seriesId, { submissionDeadline: null }),
			];

			const openIds = await listIds("open", ids);
			const closedIds = await listIds("closed", ids);

			expect([...openIds, ...closedIds].toSorted()).toEqual(ids.toSorted());
			expect(openIds).toHaveLength(3);
			expect(closedIds).toHaveLength(2);
		});
	});

	describe("並び順（findConferences）", () => {
		test("受付中は締切の昇順で、締切が空欄の学会は最後に並ぶ", async () => {
			const seriesId = await insertConferenceSeries();
			const noDeadline = await insertConference(seriesId, {
				submissionDeadline: null,
			});
			const later = await insertConference(seriesId, {
				submissionDeadline: LATER,
			});
			const today = await insertConference(seriesId, {
				submissionDeadline: TODAY,
			});

			expect(await listIds("open", [noDeadline, later, today])).toEqual([
				today,
				later,
				noDeadline,
			]);
		});

		test("締切済みは締切の降順（最近締め切った順）に並ぶ", async () => {
			const seriesId = await insertConferenceSeries();
			const earlier = await insertConference(seriesId, {
				submissionDeadline: EARLIER,
			});
			const yesterday = await insertConference(seriesId, {
				submissionDeadline: YESTERDAY,
			});

			expect(await listIds("closed", [earlier, yesterday])).toEqual([
				yesterday,
				earlier,
			]);
		});

		test("締切が同じ学会は、受付中でも締切済みでも学会名の順に並ぶ", async () => {
			const seriesId = await insertConferenceSeries();
			const openB = await insertConference(seriesId, {
				title: `${prefix} B`,
				submissionDeadline: TODAY,
			});
			const openA = await insertConference(seriesId, {
				title: `${prefix} A`,
				submissionDeadline: TODAY,
			});
			const noDeadlineB = await insertConference(seriesId, {
				title: `${prefix} D`,
				submissionDeadline: null,
			});
			const noDeadlineA = await insertConference(seriesId, {
				title: `${prefix} C`,
				submissionDeadline: null,
			});
			const closedB = await insertConference(seriesId, {
				title: `${prefix} F`,
				submissionDeadline: YESTERDAY,
			});
			const closedA = await insertConference(seriesId, {
				title: `${prefix} E`,
				submissionDeadline: YESTERDAY,
			});

			expect(
				await listIds("open", [openB, openA, noDeadlineB, noDeadlineA]),
			).toEqual([openA, openB, noDeadlineA, noDeadlineB]);
			expect(await listIds("closed", [closedB, closedA])).toEqual([
				closedA,
				closedB,
			]);
		});
	});

	describe("一覧の中身（findConferences）", () => {
		test("各学会に、一覧に出す項目・シリーズ名・参加者（表示名・状態）が付く", async () => {
			const seriesId = await insertConferenceSeries(`${prefix} DEIM`);
			const conferenceId = await insertConference(seriesId, {
				title: `${prefix} DEIM 2046`,
				venue: "福岡",
				url: "https://example.com/deim",
				submissionDeadline: TODAY,
				submissionNote: "アブスト締切は別",
				startDate: LATER,
				endDate: LATER,
				description: "説明",
				note: "メモ",
			});
			const userId = await insertUser("Shibata", "B3");
			await insertParticipant(conferenceId, userId, "planning");

			const rows = await findConferences(testUsers.db(), {
				status: "open",
				today: TODAY,
			});

			expect(rows.find((row) => row.id === conferenceId)).toEqual({
				id: conferenceId,
				title: `${prefix} DEIM 2046`,
				seriesName: `${prefix} DEIM`,
				venue: "福岡",
				submissionDeadline: TODAY,
				startDate: LATER,
				endDate: LATER,
				participants: [{ displayName: "Shibata", status: "planning" }],
			});
		});

		test("参加者のいない学会は、参加者が空の配列になる", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId, {
				submissionDeadline: TODAY,
			});

			const rows = await findConferences(testUsers.db(), {
				status: "open",
				today: TODAY,
			});

			expect(rows.find((row) => row.id === conferenceId)?.participants).toEqual(
				[],
			);
		});

		test("参加者は投稿済み → 投稿予定 → 検討中の順、同じ状態の中では表示名の順に並ぶ", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId, {
				submissionDeadline: TODAY,
			});
			const participants = [
				["Bさん", "considering"],
				["Aさん", "considering"],
				["Dさん", "planning"],
				["Cさん", "submitted"],
				["Eさん", "planning"],
			] as const;
			for (const [displayName, status] of participants) {
				const userId = await insertUser(displayName, "B3");
				await insertParticipant(conferenceId, userId, status);
			}

			const rows = await findConferences(testUsers.db(), {
				status: "open",
				today: TODAY,
			});

			expect(rows.find((row) => row.id === conferenceId)?.participants).toEqual(
				[
					{ displayName: "Cさん", status: "submitted" },
					{ displayName: "Dさん", status: "planning" },
					{ displayName: "Eさん", status: "planning" },
					{ displayName: "Aさん", status: "considering" },
					{ displayName: "Bさん", status: "considering" },
				],
			);
		});

		test("参加者は、参加している学会にだけ付く", async () => {
			const seriesId = await insertConferenceSeries();
			const joined = await insertConference(seriesId, {
				submissionDeadline: TODAY,
			});
			const other = await insertConference(seriesId, {
				submissionDeadline: TODAY,
			});
			const userId = await insertUser("Shibata", "B3");
			await insertParticipant(joined, userId, "submitted");

			const rows = await findConferences(testUsers.db(), {
				status: "open",
				today: TODAY,
			});

			expect(rows.find((row) => row.id === joined)?.participants).toHaveLength(
				1,
			);
			expect(rows.find((row) => row.id === other)?.participants).toEqual([]);
		});
	});

	describe("詳細（findConference）", () => {
		test("学会の全項目・シリーズ名・参加者（id・表示名・学年・状態）を返す", async () => {
			const seriesId = await insertConferenceSeries(`${prefix} DEIM`);
			const updatedAt = new Date("2046-06-01T10:00:00+09:00");
			const conferenceId = await insertConference(seriesId, {
				title: `${prefix} DEIM 2046`,
				venue: "福岡",
				url: "https://example.com/deim",
				submissionDeadline: TODAY,
				submissionNote: "アブスト締切は別",
				startDate: TOMORROW,
				endDate: LATER,
				scheduleNote: "昨年は 2/28〜3/2",
				description: "説明",
				note: "メモ",
				updatedAt,
			});
			const studentId = await insertUser("Shibata", "B3");
			const teacherId = await insertUser("森谷", null, "teacher");
			const studentParticipantId = await insertParticipant(
				conferenceId,
				studentId,
				"considering",
			);
			const teacherParticipantId = await insertParticipant(
				conferenceId,
				teacherId,
				"submitted",
			);

			const conference = await findConference(testUsers.db(), conferenceId);

			expect(conference).toEqual({
				id: conferenceId,
				title: `${prefix} DEIM 2046`,
				seriesName: `${prefix} DEIM`,
				venue: "福岡",
				url: "https://example.com/deim",
				submissionDeadline: TODAY,
				submissionNote: "アブスト締切は別",
				startDate: TOMORROW,
				endDate: LATER,
				scheduleNote: "昨年は 2/28〜3/2",
				description: "説明",
				note: "メモ",
				createdAt: expect.any(Date),
				updatedAt,
				participants: [
					{
						id: teacherParticipantId,
						displayName: "森谷",
						grade: null,
						status: "submitted",
					},
					{
						id: studentParticipantId,
						displayName: "Shibata",
						grade: "B3",
						status: "considering",
					},
				],
			});
		});

		test("空欄の項目は null で返し、参加者がいなければ空の配列を返す", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId);

			const conference = await findConference(testUsers.db(), conferenceId);

			expect(conference).toMatchObject({
				venue: null,
				url: null,
				submissionDeadline: null,
				submissionNote: null,
				startDate: null,
				endDate: null,
				scheduleNote: null,
				description: null,
				note: null,
				participants: [],
			});
		});

		test("参加者は投稿済み → 投稿予定 → 検討中の順、同じ状態の中では表示名の順に並ぶ", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId);
			const participants = [
				["Bさん", "considering"],
				["Aさん", "considering"],
				["Dさん", "planning"],
				["Cさん", "submitted"],
			] as const;
			for (const [displayName, status] of participants) {
				const userId = await insertUser(displayName, "B3");
				await insertParticipant(conferenceId, userId, status);
			}

			const conference = await findConference(testUsers.db(), conferenceId);

			expect(conference?.participants.map((p) => p.displayName)).toEqual([
				"Cさん",
				"Dさん",
				"Aさん",
				"Bさん",
			]);
		});

		test("存在しない id なら null を返す", async () => {
			expect(await findConference(testUsers.db(), createId())).toBeNull();
		});
	});
});
