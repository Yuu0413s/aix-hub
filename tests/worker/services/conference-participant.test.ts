import { afterEach, describe, expect, test } from "bun:test";
import { createId } from "../../../src/worker/db/id";
import {
	createParticipation,
	deleteParticipation,
	updateParticipation,
} from "../../../src/worker/services/conference-participant";
import { useTestUsers } from "../../helpers/sign-in";
import { testData } from "../../helpers/test-data";

describe("学会への参加のサービス（テスト用 DB）", () => {
	const testUsers = useTestUsers();
	const {
		insertUser,
		insertConferenceSeries,
		insertConference,
		insertParticipant,
		findParticipants,
		deleteInsertedConferences,
	} = testData(testUsers);

	afterEach(async () => {
		await deleteInsertedConferences();
	});

	async function newConference() {
		const seriesId = await insertConferenceSeries();
		return insertConference(seriesId);
	}

	describe("追加（createParticipation）", () => {
		test("選んだ状態で、本人の行が1つ入り、その id を返す", async () => {
			const conferenceId = await newConference();
			const userId = await insertUser("Shibata", "B3");

			const result = await createParticipation(testUsers.db(), {
				conferenceId,
				userId,
				status: "planning",
			});

			expect(result).toEqual({ ok: true, id: expect.any(String) });
			expect(await findParticipants(conferenceId)).toEqual([
				{
					id: result.ok ? result.id : "",
					userId,
					status: "planning",
				},
			]);
		});

		test("ほかの人が参加している学会にも追加できる", async () => {
			const conferenceId = await newConference();
			const otherId = await insertUser("ほかの人", "B3");
			await insertParticipant(conferenceId, otherId, "submitted");
			const userId = await insertUser("Shibata", "B3");

			const result = await createParticipation(testUsers.db(), {
				conferenceId,
				userId,
				status: "considering",
			});

			expect(result.ok).toBe(true);
			expect(await findParticipants(conferenceId)).toHaveLength(2);
		});

		test("同じ人の2回目は CONFERENCE_ALREADY_PARTICIPATING を返し、行は1つのまま、状態も変わらない", async () => {
			const conferenceId = await newConference();
			const userId = await insertUser("Shibata", "B3");
			const participantId = await insertParticipant(
				conferenceId,
				userId,
				"considering",
			);

			const result = await createParticipation(testUsers.db(), {
				conferenceId,
				userId,
				status: "submitted",
			});

			expect(result).toEqual({
				ok: false,
				reason: "CONFERENCE_ALREADY_PARTICIPATING",
			});
			expect(await findParticipants(conferenceId)).toEqual([
				{ id: participantId, userId, status: "considering" },
			]);
		});

		test("存在しない学会なら CONFERENCE_NOT_FOUND を返す", async () => {
			const userId = await insertUser("Shibata", "B3");

			const result = await createParticipation(testUsers.db(), {
				conferenceId: createId(),
				userId,
				status: "planning",
			});

			expect(result).toEqual({ ok: false, reason: "CONFERENCE_NOT_FOUND" });
		});
	});

	describe("状態の変更（updateParticipation）", () => {
		test("本人の行なら、状態が変わる", async () => {
			const conferenceId = await newConference();
			const userId = await insertUser("Shibata", "B3");
			const participantId = await insertParticipant(
				conferenceId,
				userId,
				"considering",
			);

			const result = await updateParticipation(testUsers.db(), {
				conferenceId,
				participantId,
				userId,
				status: "submitted",
			});

			expect(result).toEqual({ ok: true });
			expect(await findParticipants(conferenceId)).toEqual([
				{ id: participantId, userId, status: "submitted" },
			]);
		});

		test("他人の行なら FORBIDDEN を返し、状態は変わらない", async () => {
			const conferenceId = await newConference();
			const ownerId = await insertUser("持ち主", "B3");
			const participantId = await insertParticipant(
				conferenceId,
				ownerId,
				"considering",
			);
			const userId = await insertUser("Shibata", "B3");

			const result = await updateParticipation(testUsers.db(), {
				conferenceId,
				participantId,
				userId,
				status: "submitted",
			});

			expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
			expect(await findParticipants(conferenceId)).toEqual([
				{ id: participantId, userId: ownerId, status: "considering" },
			]);
		});

		test("存在しない participantId なら CONFERENCE_PARTICIPANT_NOT_FOUND を返す", async () => {
			const conferenceId = await newConference();
			const userId = await insertUser("Shibata", "B3");

			const result = await updateParticipation(testUsers.db(), {
				conferenceId,
				participantId: createId(),
				userId,
				status: "submitted",
			});

			expect(result).toEqual({
				ok: false,
				reason: "CONFERENCE_PARTICIPANT_NOT_FOUND",
			});
		});

		test("別の学会の participantId なら、本人の行でも CONFERENCE_PARTICIPANT_NOT_FOUND を返し、状態は変わらない", async () => {
			const conferenceId = await newConference();
			const otherConferenceId = await newConference();
			const userId = await insertUser("Shibata", "B3");
			const participantId = await insertParticipant(
				otherConferenceId,
				userId,
				"considering",
			);

			const result = await updateParticipation(testUsers.db(), {
				conferenceId,
				participantId,
				userId,
				status: "submitted",
			});

			expect(result).toEqual({
				ok: false,
				reason: "CONFERENCE_PARTICIPANT_NOT_FOUND",
			});
			expect(await findParticipants(otherConferenceId)).toEqual([
				{ id: participantId, userId, status: "considering" },
			]);
		});
	});

	describe("取消（deleteParticipation）", () => {
		test("本人の行なら、行が消える", async () => {
			const conferenceId = await newConference();
			const userId = await insertUser("Shibata", "B3");
			const participantId = await insertParticipant(
				conferenceId,
				userId,
				"planning",
			);

			const result = await deleteParticipation(testUsers.db(), {
				conferenceId,
				participantId,
				userId,
			});

			expect(result).toEqual({ ok: true });
			expect(await findParticipants(conferenceId)).toEqual([]);
		});

		test("他人の行なら FORBIDDEN を返し、行は残る", async () => {
			const conferenceId = await newConference();
			const ownerId = await insertUser("持ち主", "B3");
			const participantId = await insertParticipant(
				conferenceId,
				ownerId,
				"planning",
			);
			const userId = await insertUser("Shibata", "B3");

			const result = await deleteParticipation(testUsers.db(), {
				conferenceId,
				participantId,
				userId,
			});

			expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
			expect(await findParticipants(conferenceId)).toEqual([
				{ id: participantId, userId: ownerId, status: "planning" },
			]);
		});

		test("存在しない participantId なら CONFERENCE_PARTICIPANT_NOT_FOUND を返す", async () => {
			const conferenceId = await newConference();
			const userId = await insertUser("Shibata", "B3");

			const result = await deleteParticipation(testUsers.db(), {
				conferenceId,
				participantId: createId(),
				userId,
			});

			expect(result).toEqual({
				ok: false,
				reason: "CONFERENCE_PARTICIPANT_NOT_FOUND",
			});
		});

		test("別の学会の participantId なら、本人の行でも CONFERENCE_PARTICIPANT_NOT_FOUND を返し、行は残る", async () => {
			const conferenceId = await newConference();
			const otherConferenceId = await newConference();
			const userId = await insertUser("Shibata", "B3");
			const participantId = await insertParticipant(
				otherConferenceId,
				userId,
				"planning",
			);

			const result = await deleteParticipation(testUsers.db(), {
				conferenceId,
				participantId,
				userId,
			});

			expect(result).toEqual({
				ok: false,
				reason: "CONFERENCE_PARTICIPANT_NOT_FOUND",
			});
			expect(await findParticipants(otherConferenceId)).toEqual([
				{ id: participantId, userId, status: "planning" },
			]);
		});
	});
});
