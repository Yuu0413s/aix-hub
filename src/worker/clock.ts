// API がリクエストを受けた時刻。現在時刻を読むのはここだけにし、ルートが1回読んで services に now として渡す
// （testing.md「現在時刻」）。ルートのテストでは spyOn で固定の時刻に差し替え、実際の日付によって結果が変わらないようにする
export function currentTime(): Date {
	return new Date();
}
