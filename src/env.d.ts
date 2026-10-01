// Secretos del Worker (wrangler secret put). No aparecen en wrangler.jsonc, así que se declaran aquí.
interface __Secrets {
	GOOGLE_ADS_DEVELOPER_TOKEN: string;
	GOOGLE_ADS_CLIENT_ID: string;
	GOOGLE_ADS_CLIENT_SECRET: string;
	GOOGLE_ADS_REFRESH_TOKEN: string;
	GOOGLE_OAUTH_CLIENT_ID: string;
	GOOGLE_OAUTH_CLIENT_SECRET: string;
	COOKIE_ENCRYPTION_KEY: string;
}
interface Env extends __Secrets {}
declare namespace Cloudflare {
	interface Env extends __Secrets {}
}
