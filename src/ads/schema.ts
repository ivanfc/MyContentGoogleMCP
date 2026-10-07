import { ELEVATED_OPERATIONS, REMOVABLE_OPERATIONS } from "../guards";
import { GOOGLE_ADS_API_VERSION } from "../config";
import type { FetchLike, Json } from "./client";

/**
 * Esquema de mutate sacado del discovery doc oficial de la versión fijada. Sirve para que el modelo
 * construya plan_generic_mutate con campos reales (cualquier recurso, cualquier tipo de campaña)
 * en lugar de inventarlos.
 */
const DISCOVERY_URL = `https://googleads.googleapis.com/$discovery/rest?version=${GOOGLE_ADS_API_VERSION}`;
export const PREFIX = `GoogleAdsGoogleads${GOOGLE_ADS_API_VERSION.toUpperCase()}`;
const KV_KEY = `discovery:${GOOGLE_ADS_API_VERSION}`;

let memo: Json | undefined;

export async function loadDiscovery(kv: KVNamespace | undefined, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<Json> {
	if (memo) return memo;
	const cached = kv ? await kv.get(KV_KEY) : null;
	if (cached) return (memo = JSON.parse(cached));
	const res = await fetchImpl(DISCOVERY_URL);
	if (!res.ok) throw new Error(`No se pudo descargar el discovery doc (${res.status}).`);
	const text = await res.text();
	if (kv) await kv.put(KV_KEY, text, { expirationTtl: 86_400 });
	return (memo = JSON.parse(text));
}

export function _resetDiscoveryMemo() {
	memo = undefined;
}

function guardStatus(op: string): string {
	if (ELEVATED_OPERATIONS[op]) return `permitida con confirmación reforzada (${ELEVATED_OPERATIONS[op]})`;
	return REMOVABLE_OPERATIONS.has(op) ? "permitida (remove incluido)" : "permitida (remove con confirmación reforzada)";
}

export function schemaName(ref: string): string {
	return ref.replace(PREFIX, "");
}

export interface FieldInfo {
	path: string;
	type: string;
	flags: string[];
	enum?: string[];
	description: string;
}

export function flatten(schemas: Json, ref: string, depth: number, prefix: string, out: FieldInfo[], seen: Set<string>) {
	const sc = schemas[ref];
	if (!sc || seen.has(ref)) return;
	seen.add(ref);
	for (const [name, p] of Object.entries<Json>(sc.properties ?? {})) {
		const desc: string = (p.description ?? "").replace(/\s+/g, " ");
		const flags: string[] = [];
		if (/^Output only/i.test(desc)) continue; // no modificable
		if (/^Immutable/i.test(desc)) flags.push("inmutable (solo en create)");
		if (/^Required/i.test(desc)) flags.push("requerido");
		if (/deprecated/i.test(desc)) flags.push("deprecated");
		const path = prefix ? `${prefix}.${name}` : name;
		const itemRef = p.items?.$ref as string | undefined;
		const nested = (p.$ref as string | undefined) ?? itemRef;
		const type = p.$ref ? schemaName(p.$ref) : p.type === "array" ? `array<${itemRef ? schemaName(itemRef) : p.items?.type}>` : p.type;
		out.push({ path, type, flags, ...(p.enum ? { enum: p.enum.filter((e: string) => e !== "UNSPECIFIED" && e !== "UNKNOWN") } : {}), description: desc.slice(0, 220) });
		if (nested && depth > 1) flatten(schemas, nested, depth - 1, path, out, new Set(seen));
	}
}

/** Sin `operation`: lista todas las operaciones de GoogleAdsService.Mutate con su estado en las barreras. */
export function listOperations(discovery: Json) {
	const props = discovery.schemas[`${PREFIX}Services__MutateOperation`]?.properties ?? {};
	return Object.keys(props)
		.sort()
		.map((op) => ({ operation: op, guards: guardStatus(op) }))
		.concat([{ operation: "customAudienceOperation", guards: "permitida vía plan_create_custom_audience (CustomAudienceService)" }])
		.concat([{ operation: "(otros servicios)", guards: "cualquier método de escritura de la API vía plan_api_call; ver describe_api_method" }]);
}

/** Campos modificables del recurso de una operación (p. ej. campaignOperation → Campaign). */
export function describeOperation(discovery: Json, operation: string, depth = 2, filter?: string) {
	const schemas = discovery.schemas;
	const opRef = (discovery.schemas[`${PREFIX}Services__MutateOperation`]?.properties ?? {})[operation]?.$ref as string | undefined;
	if (!opRef) {
		// Algunos recursos tienen su propio servicio de mutate fuera de GoogleAdsService.Mutate (p. ej. customAudiences).
		const plural = operation.replace(/Operation$/, "").replace(/y$/, "ie").concat("s");
		const service = discovery.resources?.customers?.resources?.[plural]?.methods?.mutate?.id as string | undefined;
		if (service) {
			throw new Error(
				`${operation} no forma parte del mutate general (GoogleAdsService.Mutate): tiene su propio servicio ${service.replace(/^googleads\./, "")}. Usa describe_api_method("${service.replace(/^googleads\./, "")}") y plan_api_call${operation === "customAudienceOperation" ? ", o plan_create_custom_audience" : ""}.`,
			);
		}
		throw new Error(`Operación desconocida: ${operation}. Llama a describe_mutate_operation sin argumentos para ver la lista.`);
	}
	const op = schemas[opRef];
	const resourceRef = (op.properties?.create?.$ref ?? op.properties?.update?.$ref) as string | undefined;
	const actions = Object.keys(op.properties ?? {}).filter((k) => ["create", "update", "remove"].includes(k));
	const fields: FieldInfo[] = [];
	if (resourceRef) flatten(schemas, resourceRef, Math.min(Math.max(depth, 1), 4), "", fields, new Set());
	const f = filter?.toLowerCase();
	return {
		api_version: GOOGLE_ADS_API_VERSION,
		operation,
		resource: resourceRef ? schemaName(resourceRef) : null,
		actions,
		guards: guardStatus(operation),
		resource_description: resourceRef ? (schemas[resourceRef].description ?? "").slice(0, 400) : "",
		usage:
			"update: incluye resourceName + los campos a cambiar y pon updateMask con las rutas en snake_case separadas por comas (p. ej. \"status,network_settings.target_search_network\"). Importes *_micros en micros (1 EUR = 1000000) y como string.",
		fields: f ? fields.filter((x) => x.path.toLowerCase().includes(f) || x.description.toLowerCase().includes(f)) : fields,
	};
}
