import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@neondatabase/serverless";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { createId } from "../../../src/worker/db/id";
import {
	conferenceParticipants,
	conferences,
} from "../../../src/worker/db/schema";
import {
	type CreateParticipationResult,
	createParticipation,
	deleteParticipation,
	updateParticipation,
} from "../../../src/worker/services/conference-participant";
import { useTestUsers } from "../../helpers/sign-in";
import { testData } from "../../helpers/test-data";
import { getTestDatabaseUrl } from "../../helpers/test-db";

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

	// pid の接続が持つロックを、ほかの接続が待ち始めるまで待つ。決まった時間だけ寝て待つと、遅いときにだけ落ちるテストになるため、
	// DB に「pid が止めている接続」があるかを問い合わせる
	async function waitUntilBlockedBy(pid: number | undefined) {
		if (pid === undefined) {
			throw new Error("ロックを持つ接続の pid を取れませんでした");
		}
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const [waiting] = await testUsers
				.db()
				.execute<{ count: number }>(
					sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`,
				)
				.then(({ rows }) => rows);
			if (waiting && waiting.count > 0) {
				return;
			}
			await Bun.sleep(100);
		}
		throw new Error("ロックを待つ接続が現れませんでした");
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

		// 学会の削除（services/conference.ts の deleteConference）が学会の行をロックしている間に来た追加は、
		// 削除の確定を待ってから学会が無いことを読み直す。追加が学会の行に共有ロック（FOR SHARE）を掛けないと、
		// 削除の確定前の学会を読んで入れ、外部キーの確認で待ったあとに違反になる（API は 500 を返す）
		test("学会の削除と同時なら、削除の確定を待って CONFERENCE_NOT_FOUND を返し、外部キーの違反にならない", async () => {
			const conferenceId = await newConference();
			const userId = await insertUser("Shibata", "B3");

			// deleteConference は db.batch で一度に送るため、ロックを持ったまま途中で止められない。
			// 同じ順（学会の行をロック → 参加者 → 学会）で、WebSocket の接続のトランザクションを1文ずつ進める
			const client = new Client(getTestDatabaseUrl());
			await client.connect();
			let creating: Promise<CreateParticipationResult> | undefined;
			try {
				const deleting = drizzle(client);
				await deleting.execute(sql`BEGIN`);
				const {
					rows: [backend],
				} = await deleting.execute<{ pid: number }>(
					sql`SELECT pg_backend_pid() AS pid`,
				);
				await deleting
					.select({ id: conferences.id })
					.from(conferences)
					.where(eq(conferences.id, conferenceId))
					.for("update");

				creating = createParticipation(testUsers.db(), {
					conferenceId,
					userId,
					status: "planning",
				});
				// 下で await するまでの間に追加が失敗しても、未処理の失敗にならないよう、先に受け止めておく（結果は下の await で確かめる）
				creating.catch(() => {});
				// 追加が削除のロックを待ち始めてから削除を進める。
				// 待たずに進めると、削除の確定後に追加が始まることがあり、削除済みの学会への追加（上のテスト）と同じになるため
				await waitUntilBlockedBy(backend?.pid);

				await deleting
					.delete(conferenceParticipants)
					.where(eq(conferenceParticipants.conferenceId, conferenceId));
				await deleting
					.delete(conferences)
					.where(eq(conferences.id, conferenceId));
				await deleting.execute(sql`COMMIT`);

				expect(await creating).toEqual({
					ok: false,
					reason: "CONFERENCE_NOT_FOUND",
				});
				expect(await findParticipants(conferenceId)).toEqual([]);
			} finally {
				// 途中で失敗したときは、接続を閉じてトランザクションを取り消し、ロックを外す
				await client.end();
				// ロックが外れて動き出した追加の完了を待ってから終える（片付けの afterEach と同時に動かさないため）。
				// ここでの失敗は無視する（テストの元の失敗を上書きしないため）
				await creating?.catch(() => {});
			}
		}, 30_000);
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
