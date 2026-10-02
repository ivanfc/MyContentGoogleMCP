import { type AdsEnv, GOOGLE_ADS_BASE_URL, HARD_MAX_ROWS, normalizeCustomerId } from "../config";

export type Json = Record<string, any>;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AdsErrorDetail {
	errorCode: string;
	message: string;
	field?: string;
	trigger?: string;
	operationIndex?: number;
}

/** Error de la Google Ads API con toda la información útil (código, campo, mensaje, request-id). */
export class GoogleAdsApiError extends Error {
	constructor(
		public httpStatus: number,
		public status: string,
		public topMessage: string,
		public requestId: string | undefined,
		public details: AdsErrorDetail[],
	) {
		super(GoogleAdsApiError.format(httpStatus, status, topMessage, requestId, details));
		this.name = "GoogleAdsApiError";
	}

	static format(httpStatus: number, status: string, msg: string, requestId: string | undefined, details: AdsErrorDetail[]): string {
		const lines = [`Google Ads API error HTTP ${httpStatus} ${status}: ${msg}`, `request-id: ${requestId ?? "(no disponible)"}`];
		for (const d of details) {
			const parts = [`- [${d.errorCode}] ${d.message}`];
			if (d.field) parts.push(`campo: ${d.field}`);
			if (d.operationIndex !== undefined) parts.push(`operación #${d.operationIndex}`);
			if (d.trigger) parts.push(`valor: ${d.trigger}`);
			lines.push(parts.join(" | "));
		}
		return lines.join("\n");
	}

	toJSON() {
		return {
			httpStatus: this.httpStatus,
			status: this.status,
			message: this.topMessage,
			requestId: this.requestId,
			errors: this.details,
		};
	}
}

export async function parseAdsError(res: Response): Promise<GoogleAdsApiError> {
	const headerRequestId = res.headers.get("request-id") ?? undefined;
	const text = await res.text();
	let body: Json | undefined;
	try {
		body = JSON.parse(text);
	} catch {
		return new GoogleAdsApiError(res.status, "UNPARSEABLE", text.slice(0, 2000), headerRequestId, []);
	}
	const err = (Array.isArray(body) ? body[0]?.error : body?.error) ?? {};
	const details: AdsErrorDetail[] = [];
	let requestId = headerRequestId;
	for (const det of err.details ?? []) {
		if (det.requestId) requestId = det.requestId;
		for (const e of det.errors ?? []) {
			const codeObj = e.errorCode ?? {};
			const code = Object.entries(codeObj)
				.map(([k, v]) => `${k}.${v}`)
				.join(",");
			const path: Json[] = e.location?.fieldPathElements ?? [];
			let operationIndex: number | undefined;
			const fieldParts: string[] = [];
			for (const p of path) {
				if (p.fieldName === "mutate_operations" || p.fieldName === "operations") {
					operationIndex = p.index;
					continue;
				}
				fieldParts.push(p.index !== undefined ? `${p.fieldName}[${p.index}]` : p.fieldName);
			}
			const trigger = e.trigger ? Object.values(e.trigger).join("") : undefined;
			details.push({
				errorCode: code || "UNKNOWN",
				message: e.message ?? "",
				field: fieldParts.length ? fieldParts.join(".") : undefined,
				trigger,
				operationIndex,
			});
		}
	}
	return new GoogleAdsApiError(res.status, err.status ?? "UNKNOWN", err.message ?? text.slice(0, 500), requestId, details);
}

interface TokenCache {
	token: string;
	expiresAt: number;
}
let tokenCache: TokenCache | undefined;

/** Solo para tests. */
export function _resetTokenCache() {
	tokenCache = undefined;
}

export class GoogleAdsClient {
	private fetchImpl: FetchLike;
	constructor(
		private env: Pick<AdsEnv, "GOOGLE_ADS_DEVELOPER_TOKEN" | "GOOGLE_ADS_CLIENT_ID" | "GOOGLE_ADS_CLIENT_SECRET" | "GOOGLE_ADS_REFRESH_TOKEN" | "GOOGLE_ADS_LOGIN_CUSTOMER_ID">,
		fetchImpl?: FetchLike,
	) {
		this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
	}

	async getAccessToken(): Promise<string> {
		if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
		const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: this.env.GOOGLE_ADS_CLIENT_ID,
				client_secret: this.env.GOOGLE_ADS_CLIENT_SECRET,
				refresh_token: this.env.GOOGLE_ADS_REFRESH_TOKEN,
				grant_type: "refresh_token",
			}).toString(),
		});
		if (!res.ok) {
			const body = await res.text();
			// No se loguea ningún secreto: solo el cuerpo de error de Google (error / error_description).
			throw new Error(`No se pudo obtener el access token de Google Ads (HTTP ${res.status}): ${body.slice(0, 500)}`);
		}
		const json = (await res.json()) as { access_token: string; expires_in: number };
		tokenCache = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
		return json.access_token;
	}

	private async headers(): Promise<Record<string, string>> {
		const h: Record<string, string> = {
			Authorization: `Bearer ${await this.getAccessToken()}`,
			"login-customer-id": normalizeCustomerId(this.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
			"Content-Type": "application/json",
		};
		// Google retiró los developer tokens el 09-09-2026: el nivel de acceso lo determina el proyecto de
		// Google Cloud que emitió el cliente OAuth. La cabecera es opcional (se ignora); solo se envía si existe.
		if (this.env.GOOGLE_ADS_DEVELOPER_TOKEN) h["developer-token"] = this.env.GOOGLE_ADS_DEVELOPER_TOKEN;
		return h;
	}

	async request(method: "GET" | "POST", path: string, body?: Json): Promise<Json> {
		const res = await this.fetchImpl(`${GOOGLE_ADS_BASE_URL}/${path}`, {
			method,
			headers: await this.headers(),
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) throw await parseAdsError(res);
		const text = await res.text();
		return text ? JSON.parse(text) : {};
	}

	/** GAQL con paginación propia. Devuelve como mucho maxRows filas e indica si se truncó. */
	async search(customerId: string, query: string, maxRows = HARD_MAX_ROWS): Promise<{ rows: Json[]; truncated: boolean }> {
		const cid = normalizeCustomerId(customerId);
		const rows: Json[] = [];
		let pageToken: string | undefined;
		do {
			const res = await this.request("POST", `customers/${cid}/googleAds:search`, pageToken ? { query, pageToken } : { query });
			for (const r of res.results ?? []) {
				if (rows.length >= maxRows) return { rows, truncated: true };
				rows.push(r);
			}
			pageToken = res.nextPageToken;
		} while (pageToken);
		return { rows, truncated: false };
	}

	async searchAll(customerId: string, query: string): Promise<Json[]> {
		return (await this.search(customerId, query)).rows;
	}

	async mutate(customerId: string, mutateOperations: Json[], validateOnly: boolean): Promise<Json> {
		const cid = normalizeCustomerId(customerId);
		return this.request("POST", `customers/${cid}/googleAds:mutate`, {
			mutateOperations,
			partialFailure: false,
			validateOnly,
			responseContentType: "RESOURCE_NAME_ONLY",
		});
	}

	/** Mutate de un servicio específico (p. ej. customAudiences, que no existe en GoogleAdsService.Mutate). */
	async mutateService(customerId: string, service: "customAudiences", operations: Json[], validateOnly: boolean): Promise<Json> {
		const cid = normalizeCustomerId(customerId);
		return this.request("POST", `customers/${cid}/${service}:mutate`, { operations, validateOnly });
	}

	async listAccessibleCustomers(): Promise<string[]> {
		const res = await this.request("GET", "customers:listAccessibleCustomers");
		return res.resourceNames ?? [];
	}
}

/** Escapa un literal de cadena para GAQL. */
export function gaqlString(value: string): string {
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function assertDate(value: string, name: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} debe tener formato YYYY-MM-DD, recibido "${value}"`);
	return value;
}

export function assertId(value: string | number, name: string): string {
	const s = String(value).trim();
	if (!/^\d+$/.test(s)) throw new Error(`${name} debe ser numérico, recibido "${value}"`);
	return s;
}
