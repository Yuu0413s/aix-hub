import { setUpTestDb } from "./test-db";

// CI ではテストファイルを並列に動かすため、その前にマイグレーションを1回だけ適用する（.github/workflows/ci.yml）。
// 並列のまま各ファイルの setUpTestDb に任せると、新しいマイグレーションを同時に二重に適用して失敗する
await setUpTestDb();
