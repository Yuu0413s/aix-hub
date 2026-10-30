import type { UserRole } from "../middleware/auth";

// 操作する人（役割と id）。予約の取消・全体連絡の編集など、誰が操作できるかの SQL の条件で使う
export type Actor = { id: string; role: UserRole };
