// Worker の環境変数・binding の型。クライアントが AppType 経由でこのファイルを参照するため、
// wrangler types が生成するグローバルな Env には依存させない
export type Bindings = {
	DATABASE_URL: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL: string;
};
