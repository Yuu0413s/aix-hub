// 学会の一覧のタブ（受付中 / 締切済み）の一覧。API の検証（shared/schemas.ts）・services・画面で同じ値を使うため、ここに1つだけ書く。
// 値を足したら、次も直す（どれも型チェックでは見つからない）
// - 画面のタブ（client/routes/conferences/index.tsx の CONFERENCE_TABS）
// - worker/services/conference.ts の findConferences（絞り込みの条件）と conferenceListOrder（並び順）にある、
//   「open なら受付中、それ以外は締切済み」の二択
export const CONFERENCE_LIST_STATUSES = ["open", "closed"] as const;

export type ConferenceListStatus = (typeof CONFERENCE_LIST_STATUSES)[number];
