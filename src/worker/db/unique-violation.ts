// PostgreSQL の UNIQUE 制約の違反を表すエラーコード
const UNIQUE_VIOLATION = "23505";

// error が、名前が constraint の UNIQUE 制約の違反か。
// Drizzle は DB のエラーを DrizzleQueryError で包むことがあるため、cause をたどって Neon のエラー（code と constraint を持つ）を探す。
// 制約の名前まで比べるのは、ほかの UNIQUE 制約の違反を取り違えないようにするため
export function isUniqueViolation(error: unknown, constraint: string): boolean {
	for (
		let current: unknown = error;
		current instanceof Error;
		current = current.cause
	) {
		if (
			"code" in current &&
			current.code === UNIQUE_VIOLATION &&
			"constraint" in current &&
			current.constraint === constraint
		) {
			return true;
		}
	}
	return false;
}
