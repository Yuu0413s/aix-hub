// 学会の一覧のタブ（受付中 / 締切済み）の一覧。API の検証（shared/schemas.ts）・services・画面で同じ値を使うため、ここに1つだけ書く。
// 値を足したら、画面のタブ（routes/conferences/index.tsx の CONFERENCE_TABS）と、
// services/conference.ts の「open なら受付中、それ以外は締切済み」の分け方も直す（どちらも型チェックでは見つからない）
export const CONFERENCE_LIST_STATUSES = ["open", "closed"] as const;

export type ConferenceListStatus = (typeof CONFERENCE_LIST_STATUSES)[number];
