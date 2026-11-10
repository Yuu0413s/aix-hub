// 学会の一覧のタブ（受付中 / 締切済み）の一覧。API の検証（shared/schemas.ts）・services・画面で同じ値を使うため、ここに1つだけ書く
export const CONFERENCE_LIST_STATUSES = ["open", "closed"] as const;

export type ConferenceListStatus = (typeof CONFERENCE_LIST_STATUSES)[number];
