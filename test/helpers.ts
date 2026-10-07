import { GoogleAdsClient, _resetTokenCache, type Json } from "../src/ads/client";
import { getLimits } from "../src/config";
import type { Deps } from "../src/plans/engine";

export class MemoryKV {
	store = new Map<string, { value: string; expiresAt?: number }>();
	now = () => Date.now();
	async get(key: string) {
		const e = this.store.get(key);
		if (!e) return null;
		if (e.expiresAt && e.expiresAt <= this.now()) {
			this.store.delete(key);
			return null;
		}
		return e.value;
	}
	async put(key: string, value: string, opts?: { expirationTtl?: number }) {
		this.store.set(key, { value, expiresAt: opts?.expirationTtl ? this.now() + opts.expirationTtl * 1000 : undefined });
	}
	async delete(key: string) {
		this.store.delete(key);
	}
	async list({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) {
		const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
		return { keys: keys.map((name) => ({ name })), list_complete: true };
	}
}

type SearchHandler = { match: RegExp; rows: Json[] | (() => Json[]) };

/** fetch simulado de Google Ads: token OAuth, googleAds:search por regex de la consulta y googleAds:mutate. */
export class FakeAds {
	searches: SearchHandler[] = [];
	queries: string[] = [];
	mutateCalls: { customerId: string; body: Json }[] = [];
	serviceCalls: { service: string; body: Json }[] = [];
	serviceError?: { status: number; body: Json };
	mutateError?: { status: number; body: Json };
	mutateResponse: Json = { mutateOperationResponses: [] };
	tokenCalls = 0;
	lastHeaders?: Record<string, string>;

	fieldSearches: SearchHandler[] = [];
	fieldQueries: string[] = [];
	onFields(match: RegExp, rows: Json[] | (() => Json[])) {
		this.fieldSearches.unshift({ match, rows });
		return this;
	}

	on(match: RegExp, rows: Json[] | (() => Json[])) {
		this.searches.unshift({ match, rows });
		return this;
	}

	fetch = async (url: string, init?: RequestInit): Promise<Response> => {
		if (url === "https://oauth2.googleapis.com/token") {
			this.tokenCalls++;
			return Response.json({ access_token: "tok", expires_in: 3600 });
		}
		this.lastHeaders = init?.headers as Record<string, string>;
		const body = JSON.parse(String(init?.body ?? "{}"));
		const svc = url.match(/customers\/(\d+)\/(customAudiences):mutate$/);
		if (svc) {
			this.serviceCalls.push({ service: svc[2], body });
			if (this.serviceError) return Response.json(this.serviceError.body, { status: this.serviceError.status });
			if (body.validateOnly) return Response.json({});
			return Response.json({ results: body.operations.map((_: Json, i: number) => ({ resourceName: `customers/${svc[1]}/customAudiences/${900 + i}` })) });
		}
		if (url.endsWith("/googleAdsFields:search")) {
			this.fieldQueries.push(body.query);
			const h = this.fieldSearches.find((s) => s.match.test(body.query));
			return Response.json({ results: h ? (typeof h.rows === "function" ? h.rows() : h.rows) : [] });
		}
		const m = url.match(/customers\/(\d+)\/googleAds:(search|mutate)$/);
		if (!m) return new Response("not found", { status: 404 });
		if (m[2] === "search") {
			this.queries.push(body.query);
			const h = this.searches.find((s) => s.match.test(body.query));
			const rows = h ? (typeof h.rows === "function" ? h.rows() : h.rows) : [];
			return Response.json({ results: rows });
		}
		this.mutateCalls.push({ customerId: m[1], body });
		if (this.mutateError) return Response.json(this.mutateError.body, { status: this.mutateError.status, headers: { "request-id": "hdr-req-id" } });
		return Response.json(body.validateOnly ? {} : this.mutateResponse);
	};
}

export const ENV = {
	GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
	GOOGLE_ADS_CLIENT_ID: "cid",
	GOOGLE_ADS_CLIENT_SECRET: "sec",
	GOOGLE_ADS_REFRESH_TOKEN: "ref",
	GOOGLE_ADS_LOGIN_CUSTOMER_ID: "2567236642",
	ALLOWED_CUSTOMER_IDS: "8460514008",
	MAX_DAILY_BUDGET: "60",
	MAX_BUDGET_INCREASE_PCT: "100",
};

export const CID = "8460514008";

export function setup() {
	_resetTokenCache();
	const ads = new FakeAds();
	const client = new GoogleAdsClient(ENV, ads.fetch);
	const kv = new MemoryKV();
	let t = Date.parse("2026-10-01T10:00:00Z");
	const clock = { now: () => t, advance: (ms: number) => (t += ms) };
	kv.now = clock.now;
	const deps: Deps = { client, kv: kv as unknown as KVNamespace, limits: getLimits(ENV), userEmail: "ivan@mycontent.agency", now: clock.now };
	ads.on(/FROM customer$/, [{ customer: { currencyCode: "EUR" } }]);
	return { ads, client, kv, deps, clock, limits: deps.limits };
}

export const adsError = (code: Json, message: string, field = "operations") => ({
	status: 400,
	body: {
		error: {
			code: 400,
			message: "Request contains an invalid argument.",
			status: "INVALID_ARGUMENT",
			details: [
				{
					"@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
					errors: [{ errorCode: code, message, location: { fieldPathElements: [{ fieldName: "mutate_operations", index: 1 }, { fieldName: field }] } }],
					requestId: "REQ-123",
				},
			],
		},
	},
});
