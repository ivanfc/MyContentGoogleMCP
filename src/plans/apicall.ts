import type { Json } from "../ads/client";
import { type FieldInfo, PREFIX, flatten, schemaName } from "../ads/schema";
import { type Limits, isWriteAllowed, normalizeCustomerId } from "../config";
import { GuardError } from "../guards";

/** Llamada a cualquier método de la Google Ads API descrito en el discovery doc (fuera del mutate general). */
export interface ApiCall {
	methodId: string;
	httpMethod: "GET" | "POST" | "DELETE";
	/** Ruta relativa a https://googleads.googleapis.com/{versión}/ ya resuelta. */
	path: string;
	body: Json;
	supportsValidateOnly: boolean;
}

export interface MethodInfo {
	id: string;
	httpMethod: "GET" | "POST" | "DELETE";
	path: string;
	kind: "read" | "write";
	supportsValidateOnly: boolean;
	request?: string;
	description: string;
	params: string[];
}

const READ_RE = /\.(search|searchStream|get|list\w*|generate\w*|suggest\w*|getIdentityVerification|getSmartCampaignStatus|fetchIncentive|listResults|listAsyncErrors|listExperimentAsyncErrors)$/;

/**
 * Métodos de escritura que NO exigen confirmación reforzada. Todo lo demás (facturación, accesos, vínculos,
 * conversiones, Customer Match, experimentos, recomendaciones aplicadas…) es "elevated".
 */
const NORMAL_WRITE_METHODS = new Set([
	"googleads.customers.recommendations.dismiss",
	"googleads.customers.removeCampaignAutomaticallyCreatedAsset",
	"googleads.customers.adGroupAds.removeAutomaticallyCreatedAssets",
	"googleads.customers.campaigns.enablePMaxBrandGuidelines",
	"googleads.customers.customInterests.mutate",
	"googleads.customers.customAudiences.mutate",
]);

/** Métodos bloqueados del todo (bloqueo duro), p. ej. { "googleads.customers.billingSetups.mutate": "facturación" }. Vacío por decisión de Iván. */
export const HARD_BLOCKED_METHODS: Record<string, string> = {};

const ELEVATED_REASONS: [RegExp, string][] = [
	[/billingSetups|accountBudgetProposals|paymentsAccounts|invoices|incentives/, "facturación / presupuestos de cuenta"],
	[/customerUserAccess|customerUserAccessInvitations|multiPartyAuthReview|IdentityVerification/, "accesos de usuarios / verificación"],
	[/customerClientLinks|customerManagerLinks|accountLinks|productLink|dataLinks|createCustomerClient/, "vínculos y estructura de cuentas"],
	[/conversion|uploadClickConversions|uploadCallConversions|uploadConversionAdjustments|Goals|CampaignGoalConfigs|customerSkAdNetwork/i, "conversiones"],
	[/offlineUserDataJobs|uploadUserData|userListCustomerTypes/, "datos de usuarios (Customer Match / PII)"],
	[/experiments|experimentArms|campaignDrafts/, "experimentos / borradores (reparten tráfico real)"],
	[/recommendations\.apply/, "aplicar recomendaciones de Google (pueden cambiar pujas, presupuestos o keywords)"],
	[/reservations/, "reservas (compra de inventario)"],
	[/batchJobs/, "batch jobs (operaciones masivas sin validación por operación)"],
	[/youTubeVideoUploads/, "subida o borrado de vídeos de YouTube"],
	[/localServices|provideLeadFeedback/, "Local Services"],
];

export function catalog(discovery: Json): MethodInfo[] {
	const out: MethodInfo[] = [];
	const walk = (res: Json) => {
		for (const r of Object.values<Json>(res ?? {})) {
			for (const def of Object.values<Json>(r.methods ?? {})) {
				const req = def.request?.$ref as string | undefined;
				const props = req ? Object.keys(discovery.schemas[req]?.properties ?? {}) : [];
				out.push({
					id: def.id,
					httpMethod: def.httpMethod,
					path: String(def.path).replace(/^v\d+\/?/, ""),
					kind: def.httpMethod === "GET" || READ_RE.test(def.id) ? "read" : "write",
					supportsValidateOnly: props.includes("validateOnly"),
					request: req,
					description: String(def.description ?? "").replace(/\s+/g, " ").slice(0, 300),
					params: Object.keys(def.parameters ?? {}),
				});
			}
			if (r.resources) walk(r.resources);
		}
	};
	walk(discovery.resources);
	return out;
}

export function findMethod(discovery: Json, id: string): MethodInfo {
	const want = id.startsWith("googleads.") ? id : `googleads.${id}`;
	const m = catalog(discovery).find((x) => x.id === want);
	if (!m) throw new Error(`Método desconocido: ${id}. Usa describe_api_method sin argumentos para ver el catálogo.`);
	return m;
}

/** Operaciones del mutate general: los ":mutate" por servicio de esos recursos deben ir por plan_generic_mutate. */
export function mutateRedirect(discovery: Json, m: MethodInfo): string | undefined {
	const mm = m.id.match(/^googleads\.customers\.(\w+)\.mutate$/);
	if (!mm) return undefined;
	const singular = /Criteria$/.test(mm[1])
		? mm[1].replace(/Criteria$/, "Criterion")
		: mm[1].replace(/ies$/, "y").replace(/(sses|xes)$/, (x) => x.slice(0, -2)).replace(/s$/, "");
	const opKey = `${singular.charAt(0).toLowerCase()}${singular.slice(1)}Operation`;
	const ops = discovery.schemas[`${PREFIX}Services__MutateOperation`]?.properties ?? {};
	return ops[opKey] ? opKey : undefined;
}

export function buildPath(m: MethodInfo, params: Record<string, string>): string {
	return m.path.replace(/\{\+?(\w+)\}/g, (_, k: string) => {
		const v = params[k];
		if (v === undefined || v === "") throw new Error(`Falta el parámetro de ruta "${k}" para ${m.id}.`);
		if (k === "customerId") return normalizeCustomerId(v);
		if (!/^[\w/~.-]+$/.test(v)) throw new Error(`Parámetro de ruta inválido "${k}": ${v}`);
		return v;
	});
}

function collect(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") {
		for (const m of value.match(/customers\/\d+/g) ?? []) out.push(m);
	} else if (Array.isArray(value)) value.forEach((v) => collect(v, out));
	else if (value && typeof value === "object") Object.values(value).forEach((v) => collect(v, out));
	return out;
}

/** Barreras de plan_api_call: duras (cuenta) y motivos de confirmación reforzada. */
export function guardApiCall(call: ApiCall, customerId: string, limits: Limits): string[] {
	const v: string[] = [];
	if (!isWriteAllowed(limits, customerId)) {
		throw new GuardError([`La cuenta ${customerId} no está en ALLOWED_CUSTOMER_IDS. No se permite escribir en ella.`]);
	}
	const refs = collect(call.path).concat(collect(call.body));
	if (!refs.length) v.push(`La llamada ${call.methodId} no referencia ninguna cuenta: no se puede comprobar que sea ${customerId}.`);
	for (const r of refs) if (r !== `customers/${customerId}`) v.push(`Referencia a otra cuenta (${r}). Solo se permite customers/${customerId}.`);
	if (HARD_BLOCKED_METHODS[call.methodId]) v.push(`${call.methodId} bloqueado (${HARD_BLOCKED_METHODS[call.methodId]}).`);
	if (v.length) throw new GuardError(v);
	if (NORMAL_WRITE_METHODS.has(call.methodId)) return [];
	const reason = ELEVATED_REASONS.find(([re]) => re.test(call.methodId))?.[1] ?? "método fuera del mutate general";
	return [`${call.methodId}: ${reason}.`];
}

export function describeMethod(discovery: Json, id: string, depth = 2, filter?: string) {
	const m = findMethod(discovery, id);
	const fields: FieldInfo[] = [];
	if (m.request) flatten(discovery.schemas, m.request, Math.min(Math.max(depth, 1), 4), "", fields, new Set());
	const f = filter?.toLowerCase();
	const redirect = mutateRedirect(discovery, m);
	return {
		...m,
		request: m.request ? schemaName(m.request) : null,
		tool: m.kind === "read" ? "api_read" : redirect ? `plan_generic_mutate (usa ${redirect})` : "plan_api_call",
		confirmation: m.kind === "read" ? "no aplica (lectura)" : NORMAL_WRITE_METHODS.has(m.id) ? "APPLY" : "APPLY-ELEVATED",
		body_fields: f ? fields.filter((x) => x.path.toLowerCase().includes(f) || x.description.toLowerCase().includes(f)) : fields,
	};
}

export function listMethods(discovery: Json, filter?: string) {
	const f = filter?.toLowerCase();
	return catalog(discovery)
		.filter((m) => !f || m.id.toLowerCase().includes(f) || m.description.toLowerCase().includes(f))
		.map((m) => ({
			method: m.id.replace(/^googleads\./, ""),
			kind: m.kind,
			path: m.path,
			validateOnly: m.supportsValidateOnly,
			tool: m.kind === "read" ? "api_read" : mutateRedirect(discovery, m) ? "plan_generic_mutate" : "plan_api_call",
		}));
}

export function assertCustomerParam(params: Record<string, string>): string | undefined {
	return params.customerId ? normalizeCustomerId(params.customerId) : undefined;
}
