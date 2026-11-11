import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ConferenceListStatus } from "../../../src/shared/conference-list-status";
import { createId } from "../../../src/worker/db/id";
import {
	conferenceParticipants,
	conferenceSeries,
	conferences,
} from "../../../src/worker/db/schema";
import {
	type ConferenceInput,
	createConference,
	createConferenceSeries,
	deleteConference,
	findConference,
	findConferenceSeries,
	findConferences,
	updateConference,
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
		trackConferenceSeries,
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
	async function listIds(status: ConferenceListStatus, ids: string[]) {
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
		test("学会の全項目・シリーズの id と名前・参加者（id・表示名・学年・状態）を返す", async () => {
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
				seriesId,
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
	// 登録・編集で渡す値（API の検証を通ったあとの形。空欄は null）。title は UNIQUE のため、テストごとに別の名前にする
	function conferenceInput(
		seriesId: string,
		overrides: Partial<ConferenceInput> = {},
	): ConferenceInput {
		return {
			seriesId,
			title: `${prefix} 学会`,
			venue: null,
			url: null,
			submissionDeadline: null,
			submissionNote: null,
			startDate: null,
			endDate: null,
			scheduleNote: null,
			description: null,
			note: null,
			...overrides,
		};
	}

	async function findConferenceRow(conferenceId: string) {
		const [row] = await testUsers
			.db()
			.select()
			.from(conferences)
			.where(eq(conferences.id, conferenceId));
		return row ?? null;
	}

	async function findParticipantIds(conferenceId: string) {
		const rows = await testUsers
			.db()
			.select({ id: conferenceParticipants.id })
			.from(conferenceParticipants)
			.where(eq(conferenceParticipants.conferenceId, conferenceId));
		return rows.map((row) => row.id);
	}

	describe("登録（createConference）", () => {
		test("渡した値で学会を作り、id を返す", async () => {
			const seriesId = await insertConferenceSeries();
			const input = conferenceInput(seriesId, {
				venue: "福岡",
				url: "https://example.com/deim",
				submissionDeadline: TODAY,
				submissionNote: "アブスト締切は別",
				startDate: TOMORROW,
				endDate: LATER,
				scheduleNote: "昨年は 2/28〜3/2",
				description: "説明",
				note: "メモ",
			});

			const result = await createConference(testUsers.db(), input);

			if (!result.ok) {
				throw new Error(`作れませんでした: ${result.reason}`);
			}
			expect(await findConferenceRow(result.id)).toMatchObject({
				id: result.id,
				...input,
			});
		});

		test("シリーズが無ければ CONFERENCE_SERIES_NOT_FOUND を返し、学会は作られない", async () => {
			const input = conferenceInput(createId());

			const result = await createConference(testUsers.db(), input);

			expect(result).toEqual({
				ok: false,
				reason: "CONFERENCE_SERIES_NOT_FOUND",
			});
			const rows = await testUsers
				.db()
				.select({ id: conferences.id })
				.from(conferences)
				.where(eq(conferences.title, input.title));
			expect(rows).toEqual([]);
		});

		test("同じ学会名の学会があれば CONFERENCE_TITLE_TAKEN を返す", async () => {
			const seriesId = await insertConferenceSeries();
			await insertConference(seriesId, { title: `${prefix} 学会` });

			const result = await createConference(
				testUsers.db(),
				conferenceInput(seriesId, { title: `${prefix} 学会` }),
			);

			expect(result).toEqual({ ok: false, reason: "CONFERENCE_TITLE_TAKEN" });
		});
	});

	describe("編集（updateConference）", () => {
		// 更新日時が新しくなったことを確かめるため、元の更新日時は実際の今より前にしておく
		// （更新後の更新日時は実際の今になる。テストの年 2046 にすると、更新後のほうが古くなる）
		const updatedAt = new Date("2020-01-01T10:00:00+09:00");

		test("すべての項目を書き換える。作成日時は変わらず、更新日時は新しくなる", async () => {
			const seriesId = await insertConferenceSeries();
			const otherSeriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId, {
				title: `${prefix} 元の名前`,
				venue: "福岡",
				url: "https://example.com/old",
				submissionDeadline: TODAY,
				submissionNote: "元の補足",
				startDate: TOMORROW,
				endDate: LATER,
				scheduleNote: "元の補足",
				description: "元の説明",
				note: "元のメモ",
				updatedAt,
			});
			const before = await findConferenceRow(conferenceId);
			// 値のある項目を空にする書き換えも確かめるため、開催地などは null にする
			const input = conferenceInput(otherSeriesId, {
				title: `${prefix} 新しい名前`,
				url: "https://example.com/new",
				submissionDeadline: LATER,
				startDate: EARLIER,
				endDate: EARLIER,
				description: "新しい説明",
			});

			const result = await updateConference(testUsers.db(), {
				conferenceId,
				input,
			});

			expect(result).toEqual({ ok: true });
			const row = await findConferenceRow(conferenceId);
			expect(row).toMatchObject({ ...input, createdAt: before?.createdAt });
			expect(row?.updatedAt.getTime()).toBeGreaterThan(updatedAt.getTime());
		});

		test("学会名を今のままにして、ほかの項目だけを書き換えられる", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId, {
				title: `${prefix} 学会`,
			});

			const result = await updateConference(testUsers.db(), {
				conferenceId,
				input: conferenceInput(seriesId, { venue: "東京" }),
			});

			expect(result).toEqual({ ok: true });
			expect(await findConferenceRow(conferenceId)).toMatchObject({
				title: `${prefix} 学会`,
				venue: "東京",
			});
		});

		test("学会が無ければ CONFERENCE_NOT_FOUND を返す", async () => {
			const seriesId = await insertConferenceSeries();

			const result = await updateConference(testUsers.db(), {
				conferenceId: createId(),
				input: conferenceInput(seriesId),
			});

			expect(result).toEqual({ ok: false, reason: "CONFERENCE_NOT_FOUND" });
		});

		test("学会もシリーズも無ければ、CONFERENCE_NOT_FOUND を返す（学会が無いことを先に伝える）", async () => {
			const result = await updateConference(testUsers.db(), {
				conferenceId: createId(),
				input: conferenceInput(createId()),
			});

			expect(result).toEqual({ ok: false, reason: "CONFERENCE_NOT_FOUND" });
		});

		test("シリーズが無ければ CONFERENCE_SERIES_NOT_FOUND を返し、学会は変わらない", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId, {
				title: `${prefix} 元の名前`,
				updatedAt,
			});

			const result = await updateConference(testUsers.db(), {
				conferenceId,
				input: conferenceInput(createId(), { title: `${prefix} 新しい名前` }),
			});

			expect(result).toEqual({
				ok: false,
				reason: "CONFERENCE_SERIES_NOT_FOUND",
			});
			expect(await findConferenceRow(conferenceId)).toMatchObject({
				seriesId,
				title: `${prefix} 元の名前`,
				updatedAt,
			});
		});

		test("ほかの学会と同じ学会名なら CONFERENCE_TITLE_TAKEN を返し、学会は変わらない", async () => {
			const seriesId = await insertConferenceSeries();
			await insertConference(seriesId, { title: `${prefix} ほかの学会` });
			const conferenceId = await insertConference(seriesId, {
				title: `${prefix} 元の名前`,
			});

			const result = await updateConference(testUsers.db(), {
				conferenceId,
				input: conferenceInput(seriesId, { title: `${prefix} ほかの学会` }),
			});

			expect(result).toEqual({ ok: false, reason: "CONFERENCE_TITLE_TAKEN" });
			expect(await findConferenceRow(conferenceId)).toMatchObject({
				title: `${prefix} 元の名前`,
			});
		});
	});

	describe("削除（deleteConference）", () => {
		test("学会と、その参加者の行を消す。ほかの学会の参加者は残る", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId);
			const otherConferenceId = await insertConference(seriesId);
			const userId = await insertUser("Shibata", "B3");
			const otherUserId = await insertUser("森谷", null, "teacher");
			await insertParticipant(conferenceId, userId, "planning");
			await insertParticipant(conferenceId, otherUserId, "submitted");
			const otherParticipantId = await insertParticipant(
				otherConferenceId,
				userId,
				"considering",
			);

			const result = await deleteConference(testUsers.db(), conferenceId);

			expect(result).toEqual({ ok: true });
			expect(await findConferenceRow(conferenceId)).toBeNull();
			expect(await findParticipantIds(conferenceId)).toEqual([]);
			expect(await findConferenceRow(otherConferenceId)).not.toBeNull();
			expect(await findParticipantIds(otherConferenceId)).toEqual([
				otherParticipantId,
			]);
		});

		test("参加者のいない学会も消せる", async () => {
			const seriesId = await insertConferenceSeries();
			const conferenceId = await insertConference(seriesId);

			const result = await deleteConference(testUsers.db(), conferenceId);

			expect(result).toEqual({ ok: true });
			expect(await findConferenceRow(conferenceId)).toBeNull();
		});

		test("学会が無ければ CONFERENCE_NOT_FOUND を返す", async () => {
			const result = await deleteConference(testUsers.db(), createId());

			expect(result).toEqual({ ok: false, reason: "CONFERENCE_NOT_FOUND" });
		});
	});

	describe("シリーズの一覧（findConferenceSeries）", () => {
		test("id と名前を、名前の順に返す", async () => {
			const b = await insertConferenceSeries(`${prefix} B`);
			const a = await insertConferenceSeries(`${prefix} A`);
			const c = await insertConferenceSeries(`${prefix} C`);

			const rows = await findConferenceSeries(testUsers.db());

			// テスト用 DB はほかのテストファイルと共有するため、このテストで作ったシリーズだけに絞って確かめる
			expect(rows.filter((row) => [a, b, c].includes(row.id))).toEqual([
				{ id: a, name: `${prefix} A` },
				{ id: b, name: `${prefix} B` },
				{ id: c, name: `${prefix} C` },
			]);
		});
	});

	describe("シリーズの作成（createConferenceSeries）", () => {
		test("シリーズを作り、id と名前を返す", async () => {
			const result = await createConferenceSeries(
				testUsers.db(),
				`${prefix} DEIM`,
			);

			if (!result.ok) {
				throw new Error(`作れませんでした: ${result.reason}`);
			}
			trackConferenceSeries(result.series.id);
			expect(result.series).toEqual({
				id: expect.any(String),
				name: `${prefix} DEIM`,
			});
			const rows = await testUsers
				.db()
				.select()
				.from(conferenceSeries)
				.where(eq(conferenceSeries.id, result.series.id));
			expect(rows).toEqual([result.series]);
		});

		test("同じ名前のシリーズがあれば CONFERENCE_SERIES_NAME_TAKEN を返す", async () => {
			await insertConferenceSeries(`${prefix} DEIM`);

			const result = await createConferenceSeries(
				testUsers.db(),
				`${prefix} DEIM`,
			);

			expect(result).toEqual({
				ok: false,
				reason: "CONFERENCE_SERIES_NAME_TAKEN",
			});
		});
	});
});
