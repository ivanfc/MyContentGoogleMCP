import { GOOGLE_ADS_API_VERSION } from "../config";
import { type GoogleAdsClient, GoogleAdsApiError, type Json } from "./client";

/**
 * Metadatos de campos GAQL (GoogleAdsFieldService) para que el modelo no adivine nombres, compatibilidades ni enums.
 * Visto en logs (03-07/10/2026): el 7 % de las gaql_search fallaban por UNRECOGNIZED_FIELD, PROHIBITED_*_IN_SELECT,
 * BAD_ENUM_CONSTANT… Los metadatos solo cambian con la versión de la API: se cachean 7 días en KV.
 */
const TTL = 7 * 24 * 3600;

async function fieldsSearch(client: GoogleAdsClient, kv: KVNamespace | undefined, query: string): Promise<Json[]> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(query));
	const key = `gaqlmeta:${GOOGLE_ADS_API_VERSION}:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
	const cached = kv ? await kv.get(key) : null;
	if (cached) return JSON.parse(cached);
	const out: Json[] = [];
	let pageToken: string | undefined;
	for (let page = 0; page < 10; page++) {
		const res = await client.request("POST", "googleAdsFields:search", { query, pageSize: 10000, ...(pageToken ? { pageToken } : {}) });
		out.push(...(res.results ?? []));
		pageToken = res.nextPageToken;
		if (!pageToken) break;
	}
	if (kv) await kv.put(key, JSON.stringify(out), { expirationTtl: TTL });
	return out;
}

const isName = (s: string) => /^[a-z_]+(\.[a-z_0-9]+)*$/.test(s);

/** Prefijo de búsqueda de un campo: "metrics.", "segments." o el recurso ("ad_group_ad.policy_summary.x" → "ad_group_ad."). */
const prefixOf = (field: string) => `${field.split(".")[0]}.`;

function similarity(a: string, b: string): number {
	const ta = new Set(a.split(/[._]/));
	const tb = new Set(b.split(/[._]/));
	let common = 0;
	for (const t of ta) if (tb.has(t)) common++;
	const sub = b.includes(a.split(".").pop() ?? "") ? 1 : 0;
	return common / Math.max(ta.size, tb.size) + sub;
}

export async function suggestFields(client: GoogleAdsClient, kv: KVNamespace | undefined, bad: string, limit = 6): Promise<string[]> {
	const rows = await fieldsSearch(client, kv, `SELECT name WHERE name LIKE '${prefixOf(bad)}%' AND selectable = true`);
	return rows
		.map((r) => String(r.name))
		.map((n) => [n, similarity(bad, n)] as const)
		.filter(([, s]) => s > 0)
		.sort((x, y) => y[1] - x[1])
		.slice(0, limit)
		.map(([n]) => n);
}

async function fieldMeta(client: GoogleAdsClient, kv: KVNamespace | undefined, names: string[]): Promise<Map<string, Json>> {
	const valid = [...new Set(names.filter(isName))].slice(0, 50);
	if (!valid.length) return new Map();
	const rows = await fieldsSearch(
		client,
		kv,
		`SELECT name, category, data_type, enum_values, selectable, filterable, selectable_with WHERE name IN (${valid.map((n) => `'${n}'`).join(", ")})`,
	);
	return new Map(rows.map((r) => [String(r.name), r]));
}

function parseQuery(query: string) {
	const sel = query.match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)/i);
	const where = query.match(/\sWHERE\s+([\s\S]+?)(\s+ORDER\s+BY|\s+LIMIT|\s+PARAMETERS|$)/i)?.[1] ?? "";
	return { select: sel ? sel[1].split(",").map((f) => f.trim()) : [], from: sel?.[2]?.toLowerCase(), where };
}

/** Pista accionable para un error de GAQL. Nunca lanza: si no hay pista, devuelve undefined. */
export async function gaqlHint(client: GoogleAdsClient, kv: KVNamespace | undefined, query: string, err: unknown): Promise<string | undefined> {
	if (!(err instanceof GoogleAdsApiError)) return undefined;
	try {
		const codes = err.details.map((d) => d.errorCode);
		const text = err.details.map((d) => `${d.message} ${d.trigger ?? ""}`).join(" ");
		const quoted = [...text.matchAll(/'([a-z_]+(?:\.[a-z_0-9]+)+)'/g)].map((m) => m[1]);
		const { select, from, where } = parseQuery(query);
		const hints: string[] = [];

		if (codes.includes("queryError.UNRECOGNIZED_FIELD")) {
			const meta = await fieldMeta(client, kv, [...select, ...quoted]);
			const unknown = [...new Set([...quoted, ...select.filter((f) => isName(f) && !meta.has(f))])].filter((f) => !meta.has(f));
			for (const f of unknown.slice(0, 4)) {
				const s = await suggestFields(client, kv, f);
				hints.push(`"${f}" no existe.${s.length ? ` Parecidos: ${s.join(", ")}.` : ""}`);
			}
		}
		if (codes.some((c) => /PROHIBITED_(FIELD|RESOURCE_TYPE|METRIC|SEGMENT).*IN_SELECT|PROHIBITED_SEGMENT_WITH_METRIC/.test(c)) && from) {
			const meta = await fieldMeta(client, kv, [from]);
			const compatible = new Set<string>((meta.get(from)?.selectableWith ?? []).map(String));
			const bad = select.filter((f) => isName(f) && !f.startsWith(`${from}.`)).filter((f) => {
				const key = f.startsWith("metrics.") || f.startsWith("segments.") ? f : f.split(".")[0];
				return !compatible.has(key);
			});
			if (bad.length) hints.push(`Con FROM ${from} no se pueden pedir: ${bad.join(", ")}. Usa describe_gaql_fields("${from}") para ver qué recursos, segmentos y métricas admite, o consulta desde el recurso de esos campos.`);
		}
		if (codes.includes("queryError.BAD_ENUM_CONSTANT")) {
			const pairs = [...where.matchAll(/([a-z_]+(?:\.[a-z_0-9]+)+)\s*(?:=|!=|IN|NOT IN)\s*\(?([^)]*?)\)?(?=\s+AND\s+|$)/gi)];
			const meta = await fieldMeta(client, kv, pairs.map((p) => p[1]));
			for (const [, field, raw] of pairs) {
				const m = meta.get(field);
				if (!m?.enumValues?.length) continue;
				const used = [...raw.matchAll(/'([^']*)'|\b([A-Z_]{2,})\b/g)].map((x) => x[1] ?? x[2]);
				const wrong = used.filter((u) => !m.enumValues.includes(u));
				if (wrong.length) hints.push(`${field}: ${wrong.join(", ")} no es válido. Valores: ${m.enumValues.filter((v: string) => v !== "UNSPECIFIED" && v !== "UNKNOWN").join(", ")}.`);
			}
		}
		if (codes.includes("queryError.EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE")) {
			hints.push(`Los campos usados en WHERE u ORDER BY ${quoted.length ? `(${quoted.join(", ")}) ` : ""}tienen que estar también en el SELECT para esta consulta.`);
		}
		if (codes.includes("changeEventError.CHANGE_DATE_RANGE_INFINITE") || codes.includes("changeEventError.START_DATE_TOO_OLD")) {
			hints.push("change_event exige acotar change_event.change_date_time por los dos lados (>= y <=), dentro de los últimos 30 días, y un LIMIT ≤ 10000. O usa get_change_history.");
		}
		if (codes.includes("queryError.UNEXPECTED_INPUT")) {
			hints.push("Error de sintaxis GAQL: no hay OR ni paréntesis para agrupar condiciones (solo para listas IN); las cadenas van entre comillas simples; fechas con segments.date DURING LAST_30_DAYS o BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'.");
		}
		return hints.length ? hints.join("\n") : undefined;
	} catch {
		return undefined;
	}
}

/** Herramienta describe_gaql_fields: qué se puede pedir desde un recurso (atributos, recursos, segmentos, métricas y enums). */
export async function describeGaqlFields(client: GoogleAdsClient, kv: KVNamespace | undefined, resource: string, filter?: string) {
	const res = resource.trim().toLowerCase();
	if (!/^[a-z_]+$/.test(res)) throw new Error(`Recurso GAQL inválido: "${resource}" (p. ej. campaign, ad_group_ad, keyword_view).`);
	const meta = await fieldMeta(client, kv, [res]);
	const r = meta.get(res);
	if (!r) throw new Error(`"${res}" no es un recurso GAQL de la API ${GOOGLE_ADS_API_VERSION}. Usa describe_gaql_fields con un recurso válido (campaign, ad_group, ad_group_ad, keyword_view, search_term_view, asset_group_asset, change_event…).`);
	const f = filter?.toLowerCase();
	const match = (n: string) => !f || n.toLowerCase().includes(f);
	const attrs = (await fieldsSearch(client, kv, `SELECT name WHERE name LIKE '${res}.%' AND selectable = true`)).map((x) => String(x.name)).filter(match);
	const withList: string[] = (r.selectableWith ?? []).map(String);
	const out: Json = {
		resource: res,
		attributes: attrs,
		related_resources: withList.filter((n) => !n.includes(".")).filter(match),
		segments: withList.filter((n) => n.startsWith("segments.")).filter(match),
		metrics: withList.filter((n) => n.startsWith("metrics.")).filter(match),
	};
	if (f) {
		const enumMeta = await fieldMeta(client, kv, [...attrs, ...out.segments].slice(0, 50));
		const enums: Record<string, string[]> = {};
		for (const [n, m] of enumMeta) if (m.dataType === "ENUM" && m.enumValues?.length) enums[n] = m.enumValues.filter((v: string) => v !== "UNSPECIFIED" && v !== "UNKNOWN");
		if (Object.keys(enums).length) out.enum_values = enums;
	} else {
		out.note = "Sin filter no se incluyen los valores de enum; pásale filter (p. ej. \"status\") para verlos.";
	}
	return out;
}
