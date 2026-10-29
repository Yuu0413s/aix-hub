import { countCharacters, DISPLAY_NAME_MAX_LENGTH } from "../../shared/profile";

// サーバーと同じく、前後の空白を除いてから数える
function displayNameLength(value: string) {
	return countCharacters(value.trim());
}

// 送る前に止めるかの判定。入力欄の文字数の表示と同じ数え方にする
export function isDisplayNameTooLong(value: string) {
	return displayNameLength(value) > DISPLAY_NAME_MAX_LENGTH;
}

// 表示名の入力欄と文字数。登録画面とマイページで、数え方や見た目がずれないように共通にする
export function DisplayNameField({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div>
			<label htmlFor="displayName" className="block text-sm font-bold">
				表示名
			</label>
			<input
				id="displayName"
				type="text"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				required
				// maxLength は UTF-16 単位で数え、絵文字を2文字分にしてしまうため使わず、下の文字数で知らせる
				aria-describedby="displayNameLength"
				placeholder="例: Shibata"
				className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
			/>
			<p
				id="displayNameLength"
				className={`mt-1 text-right text-xs ${isDisplayNameTooLong(value) ? "text-red-700" : "text-gray-600"}`}
			>
				{displayNameLength(value)} / {DISPLAY_NAME_MAX_LENGTH}
			</p>
		</div>
	);
}
