import { GoogleAdsApiError, type GoogleAdsClient, type Json } from "../ads/client";
import { type Limits, PLAN_TTL_LABEL, PLAN_TTL_SECONDS, fromMicros } from "../config";
import { type BudgetInfo, GuardError, enforceGuards } from "../guards";
import { type ApiCall, guardApiCall } from "./apicall";

export interface Plan {
	id: string;
	kind: string;
	customerId: string;
	createdBy: string;
	createdAt: string;
	expiresAt: number;
	summary: string[];
	warnings: string[];
	operations: Json[];
	stateQueries: string[];
	stateHash: string;
	guardFlags: { allowCampaignEnable?: boolean; allowSharedBudget?: boolean };
	preSteps?: PreStep[];
	/** Llamada a un método de la API fuera de GoogleAdsService.Mutate (plan_api_call). */
	apiCall?: ApiCall;
	/** Motivos de confirmación reforzada (vacío = "APPLY <id>"). */
	elevated: string[];
}

/**
 * Operación previa en un servicio aparte (CustomAudienceService no existe en GoogleAdsService.Mutate).
 * `placeholder` es el resource name temporal que usan las operaciones principales; en apply_plan se
 * sustituye por el resource name real devuelto por la API.
 */
export interface PreStep {
	service: "customAudiences";
	placeholder: string;
	operation: Json;
}

export interface Deps {
	client: GoogleAdsClient;
	kv: KVNamespace;
	limits: Limits;
	userEmail: string;
	now?: () => number;
	/** Reclama el plan en un cerrojo global (Durable Object). false = ya lo está aplicando o lo aplicó otro. */
	claim?: (planId: string) => Promise<boolean>;
	/** Re-comprueba al aplicar que la cuenta sigue siendo escribible (allowlist / pertenencia a la MCC). */
	assertWritable?: (customerId: string) => Promise<void>;
}

export interface PlanDraft {
	kind: string;
	customerId: string;
	summary: string[];
	warnings?: string[];
	operations: Json[];
	/** GAQL que leen exactamente los campos que el plan va a tocar. Se re-ejecutan en apply_plan. */
	stateQueries: string[];
	/** Motivos de confirmación reforzada detectados por el constructor (se suman a los de las barreras). */
	elevated?: string[];
	guardFlags?: Plan["guardFlags"];
	preSteps?: PreStep[];
	apiCall?: ApiCall;
}

export type PlanResult =
	| {
			ok: true;
			plan_id: string;
			expires_at_utc: string;
			confirm_with: string;
			elevated: string[];
			kind: string;
			customer_id: string;
			summary: string[];
			warnings: string[];
			operations_count: number;
			validation: string;
	  }
	| { ok: false; stage: "guards" | "validation"; summary: string[]; warnings: string[]; errors: unknown; message: string };

const now = (deps: Deps) => (deps.now ? deps.now() : Date.now());

function newPlanId(): string {
	return `p_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export async function sha256(text: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function stripVolatile(row: Json): Json {
	const { metrics: _m, segments: _s, ...rest } = row;
	return rest;
}

export async function computeStateHash(client: GoogleAdsClient, customerId: string, queries: string[]): Promise<string> {
	// En paralelo (máx. 4 a la vez) y en el orden original de las consultas.
	const parts: string[] = new Array(queries.length);
	let next = 0;
	const worker = async () => {
		while (next < queries.length) {
			const i = next++;
			const q = queries[i];
			const { rows, truncated } = await client.search(customerId, q);
			// Un estado truncado haría el hash arbitrario (falsos "estado cambiado" o cambios no detectados).
			if (truncated) throw new Error(`La lectura de estado devuelve más de 10.000 filas y no se puede comprobar de forma fiable: ${q.slice(0, 160)}… Divide el cambio en planes más pequeños.`);
			parts[i] = JSON.stringify(rows.map((r) => JSON.stringify(stripVolatile(r))).sort());
		}
	};
	await Promise.all(Array.from({ length: Math.min(4, queries.length) }, worker));
	return sha256(parts.join("\n"));
}

export function budgetReader(client: GoogleAdsClient, customerId: string) {
	return async (resourceName: string): Promise<BudgetInfo | undefined> => {
		if (!resourceName || !new RegExp(`^customers/${customerId}/campaignBudgets/\\d+$`).test(resourceName)) return undefined;
		const rows = await client.searchAll(
			customerId,
			`SELECT campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign_budget WHERE campaign_budget.resource_name = '${resourceName}'`,
		);
		const b = rows[0]?.campaignBudget;
		if (!b) return undefined;
		return { amountMicros: Number(b.amountMicros), explicitlyShared: Boolean(b.explicitlyShared), referenceCount: Number(b.referenceCount ?? 1) };
	};
}

export const confirmPhrase = (planId: string, elevated: string[]) => (elevated.length ? `APPLY-ELEVATED ${planId}` : `APPLY ${planId}`);

async function runGuards(deps: Deps, d: { customerId: string; operations: Json[]; preSteps?: PreStep[]; apiCall?: ApiCall; guardFlags?: Plan["guardFlags"] }): Promise<string[]> {
	if (d.apiCall) return guardApiCall(d.apiCall, d.customerId, deps.limits);
	return (await enforceGuards(guardedOps(d.preSteps, d.operations), guardCtx(deps, d.customerId, d.guardFlags ?? {}))).elevated;
}

/** Operaciones que pasan por las barreras: pasos previos (en formato MutateOperation) + principales. */
function guardedOps(preSteps: PreStep[] | undefined, operations: Json[]): Json[] {
	return [...(preSteps ?? []).map((p) => ({ customAudienceOperation: p.operation })), ...operations];
}

function replacePlaceholders(operations: Json[], map: Map<string, string>): Json[] {
	let s = JSON.stringify(operations);
	for (const [ph, rn] of map) s = s.split(JSON.stringify(ph)).join(JSON.stringify(rn));
	return JSON.parse(s);
}

/** Quita las operaciones que referencian `refs` (y, en cascada, las que referencian a esas). */
function stripReferencing(operations: Json[], refs: string[]): { kept: Json[]; removed: number } {
	const gone = new Set(refs);
	let kept = operations;
	let changed = true;
	while (changed) {
		changed = false;
		const next: Json[] = [];
		for (const op of kept) {
			const txt = JSON.stringify(op);
			if ([...gone].some((r) => txt.includes(JSON.stringify(r)))) {
				const own = (Object.values(op)[0] as Json)?.create?.resourceName;
				if (own) gone.add(own);
				changed = true;
			} else next.push(op);
		}
		kept = next;
	}
	return { kept, removed: operations.length - kept.length };
}

/**
 * Valida con validateOnly. Los pasos previos se validan en su servicio; en las operaciones principales
 * los placeholders se sustituyen por un custom audience existente de la cuenta (o, si no hay ninguno,
 * se omiten las operaciones que dependen de ellos y se avisa).
 */
async function validate(deps: Deps, draft: PlanDraft, warnings: string[]) {
	if (draft.apiCall) {
		if (draft.apiCall.supportsValidateOnly) {
			await deps.client.request(draft.apiCall.httpMethod, draft.apiCall.path, { ...draft.apiCall.body, validateOnly: true });
		} else {
			warnings.push(`El método ${draft.apiCall.methodId} no admite validateOnly: la API solo lo comprobará al aplicarlo.`);
		}
		return;
	}
	const pre = draft.preSteps ?? [];
	if (pre.length) await deps.client.mutateService(draft.customerId, "customAudiences", pre.map((p) => p.operation), true);
	if (!draft.operations.length) return;
	if (!pre.length) {
		await deps.client.mutate(draft.customerId, draft.operations, true);
		return;
	}
	const existing = await deps.client.searchAll(
		draft.customerId,
		"SELECT custom_audience.resource_name FROM custom_audience WHERE custom_audience.status = 'ENABLED' LIMIT 1",
	);
	const stand = existing[0]?.customAudience?.resourceName as string | undefined;
	if (stand) {
		const map = new Map(pre.map((p) => [p.placeholder, stand] as [string, string]));
		await deps.client.mutate(draft.customerId, replacePlaceholders(draft.operations, map), true);
		warnings.push(`Validación: el segmento nuevo se ha sustituido por ${stand} solo para validar la campaña; en apply se usa el real.`);
	} else {
		const { kept, removed } = stripReferencing(draft.operations, pre.map((p) => p.placeholder));
		if (kept.length) await deps.client.mutate(draft.customerId, kept, true);
		warnings.push(`Validación parcial: ${removed} operación(es) que usan el segmento nuevo no se han podido validar (no hay ningún custom audience previo en la cuenta). Se validarán en apply.`);
	}
}

function guardCtx(deps: Deps, customerId: string, flags: Plan["guardFlags"]) {
	return {
		customerId,
		limits: deps.limits,
		getBudget: budgetReader(deps.client, customerId),
		allowCampaignEnable: flags.allowCampaignEnable,
		allowSharedBudget: flags.allowSharedBudget,
	};
}

/** Fase 1: barreras → lectura de estado → validateOnly → guardar plan en KV (PLAN_TTL_SECONDS). */
export async function createPlan(deps: Deps, draft: PlanDraft): Promise<PlanResult> {
	const warnings = [...(draft.warnings ?? [])];
	if (!draft.stateQueries.length && !draft.apiCall) {
		warnings.push("Este plan no tiene lectura de estado previa (solo crea recursos): apply_plan no podrá detectar si la cuenta cambió entre medias. Revisa el resumen justo antes de aplicar.");
	}
	const flags = draft.guardFlags ?? {};
	let elevated: string[];
	try {
		elevated = [...new Set([...(draft.elevated ?? []), ...(await runGuards(deps, draft))])];
	} catch (e) {
		if (e instanceof GuardError) {
			return { ok: false, stage: "guards", summary: draft.summary, warnings, errors: e.violations, message: e.message };
		}
		throw e;
	}

	const stateHash = await computeStateHash(deps.client, draft.customerId, draft.stateQueries);

	try {
		await validate(deps, draft, warnings);
	} catch (e) {
		if (e instanceof GoogleAdsApiError) {
			return { ok: false, stage: "validation", summary: draft.summary, warnings, errors: e.toJSON(), message: e.message };
		}
		throw e;
	}

	const id = newPlanId();
	const t = now(deps);
	const plan: Plan = {
		id,
		kind: draft.kind,
		customerId: draft.customerId,
		createdBy: deps.userEmail,
		createdAt: new Date(t).toISOString(),
		expiresAt: t + PLAN_TTL_SECONDS * 1000,
		summary: draft.summary,
		warnings,
		operations: draft.operations,
		stateQueries: draft.stateQueries,
		stateHash,
		guardFlags: flags,
		...(draft.preSteps?.length ? { preSteps: draft.preSteps } : {}),
		...(draft.apiCall ? { apiCall: draft.apiCall } : {}),
		elevated,
	};
	await deps.kv.put(`plan:${id}`, JSON.stringify(plan), { expirationTtl: PLAN_TTL_SECONDS });
	// Índice por usuario: list_pending_plans no recorre los planes de los demás.
	await deps.kv.put(`planu:${await userKey(deps.userEmail)}:${id}`, "", { expirationTtl: PLAN_TTL_SECONDS });
	return {
		ok: true,
		plan_id: id,
		expires_at_utc: new Date(plan.expiresAt).toISOString(),
		confirm_with: confirmPhrase(id, elevated),
		elevated,
		kind: plan.kind,
		customer_id: plan.customerId,
		summary: plan.summary,
		warnings,
		operations_count: plan.operations.length + (plan.preSteps?.length ?? 0) + (plan.apiCall ? 1 : 0),
		validation: plan.apiCall && !plan.apiCall.supportsValidateOnly ? "sin validación previa (el método no la admite)" : "OK (validateOnly)",
	};
}

/** Clave opaca por usuario para prefijos de KV (no expone el email en los nombres de clave). */
export async function userKey(email: string): Promise<string> {
	return (await sha256(email.trim().toLowerCase())).slice(0, 16);
}

/** Un plan solo existe para quien lo creó: otro usuario recibe "no existe", igual que con un id inventado. */
export async function loadPlan(deps: Deps, planId: string): Promise<Plan | undefined> {
	const raw = await deps.kv.get(`plan:${planId}`);
	if (!raw) return undefined;
	const plan = JSON.parse(raw) as Plan;
	if (plan.createdBy.toLowerCase() !== deps.userEmail.toLowerCase()) return undefined;
	if (plan.expiresAt <= now(deps)) {
		await deps.kv.delete(`plan:${planId}`);
		return undefined;
	}
	return plan;
}

/** Planes pendientes (no aplicados ni caducados), más recientes primero. Sirve para recuperar un plan_id perdido. */
export async function listPendingPlans(deps: Deps, customerId?: string) {
	const prefix = `planu:${await userKey(deps.userEmail)}:`;
	const list = await deps.kv.list({ prefix, limit: 100 });
	const out = [];
	for (const k of list.keys) {
		const plan = await loadPlan(deps, k.name.slice(prefix.length));
		if (!plan || (customerId && plan.customerId !== customerId)) continue;
		out.push({
			plan_id: plan.id,
			kind: plan.kind,
			customer_id: plan.customerId,
			created_by: plan.createdBy,
			created_at_utc: plan.createdAt,
			expires_at_utc: new Date(plan.expiresAt).toISOString(),
			confirm_with: confirmPhrase(plan.id, plan.elevated ?? []),
			elevated: plan.elevated ?? [],
			summary: plan.summary.slice(0, 12),
		});
	}
	return out.sort((a, b) => b.created_at_utc.localeCompare(a.created_at_utc));
}

export async function cancelPlan(deps: Deps, planId: string) {
	const plan = await loadPlan(deps, planId);
	if (!plan) return { ok: false, message: `El plan ${planId} no existe o ha caducado.` };
	await deps.kv.delete(`plan:${planId}`);
	return { ok: true, message: `Plan ${planId} cancelado. No se ha aplicado ningún cambio.` };
}

export interface AuditRecord {
	timestamp_utc: string;
	user_email: string;
	customer_id: string;
	plan_id: string;
	kind: string;
	outcome: "APPLIED" | "FAILED" | "ABORTED_STATE_CHANGED";
	/** Motivos de confirmación reforzada aceptados en este apply. */
	elevated?: string[];
	summary: string[];
	operations: Json[];
	api_response?: Json;
	resource_names?: string[];
	error?: unknown;
}

const AUDIT_MAX_KEY = 9_999_999_999_999;

async function writeAudit(deps: Deps, rec: AuditRecord) {
	const inverted = String(AUDIT_MAX_KEY - now(deps)).padStart(13, "0");
	await deps.kv.put(`auditu:${await userKey(rec.user_email)}:${inverted}:${rec.plan_id}`, JSON.stringify(rec));
}

/**
 * Auditoría del propio usuario, más reciente primero. El propietario ve además el registro anterior a
 * multiusuario (prefijo "audit:"), que solo contiene cambios suyos.
 */
export async function getAuditLog(kv: KVNamespace, limit: number, userEmail: string, owner = false): Promise<AuditRecord[]> {
	const n = Math.min(Math.max(limit, 1), 100);
	const prefixes = [`auditu:${await userKey(userEmail)}:`, ...(owner ? ["audit:"] : [])];
	const entries: { order: string; name: string }[] = [];
	for (const prefix of prefixes) {
		const list = await kv.list({ prefix, limit: n });
		for (const k of list.keys) entries.push({ order: k.name.slice(prefix.length), name: k.name });
	}
	entries.sort((a, b) => a.order.localeCompare(b.order));
	const out: AuditRecord[] = [];
	for (const e of entries.slice(0, n)) {
		const raw = await kv.get(e.name);
		if (raw) out.push(JSON.parse(raw));
	}
	return out;
}

function extractResourceNames(response: Json): string[] {
	const names: string[] = [];
	for (const r of response.mutateOperationResponses ?? []) {
		for (const v of Object.values(r) as Json[]) {
			if (v?.resourceName) names.push(v.resourceName);
		}
	}
	return names;
}

/** Fase 2: ejecuta exactamente las operaciones guardadas, si el estado no ha cambiado. */
export async function applyPlan(deps: Deps, planId: string, confirm: string) {
	const plan = await loadPlan(deps, planId);
	if (!plan) return { ok: false, message: `El plan ${planId} no existe o ha caducado (${PLAN_TTL_LABEL}). Genera un plan nuevo.` };
	// Defensa en profundidad: las barreras se re-evalúan con el estado actual.
	let elevatedNow: string[];
	try {
		elevatedNow = await runGuards(deps, plan);
	} catch (e) {
		if (e instanceof GuardError) return { ok: false, message: e.message };
		throw e;
	}
	if (deps.assertWritable) {
		try {
			await deps.assertWritable(plan.customerId);
		} catch (e) {
			return { ok: false, message: `${(e as Error).message} No se ha aplicado nada.` };
		}
	}
	const elevated = [...new Set([...(plan.elevated ?? []), ...elevatedNow])];
	const expected = confirmPhrase(planId, elevated);
	if (confirm !== expected) {
		return {
			ok: false,
			message: `Confirmación incorrecta. Debe ser exactamente "${expected}".${elevated.length ? ` Requiere confirmación reforzada por: ${elevated.join(" | ")}` : ""}`,
		};
	}

	const currentHash = await computeStateHash(deps.client, plan.customerId, plan.stateQueries);
	const base: Omit<AuditRecord, "outcome"> = {
		timestamp_utc: new Date(now(deps)).toISOString(),
		user_email: deps.userEmail,
		customer_id: plan.customerId,
		plan_id: plan.id,
		kind: plan.kind,
		summary: plan.summary,
		operations: plan.apiCall ? [{ apiCall: plan.apiCall }] : guardedOps(plan.preSteps, plan.operations),
		elevated,
	};
	if (currentHash !== plan.stateHash) {
		await deps.kv.delete(`plan:${planId}`);
		await writeAudit(deps, { ...base, outcome: "ABORTED_STATE_CHANGED" });
		return {
			ok: false,
			message: "El estado de la cuenta ha cambiado desde que se creó el plan (hash distinto). No se ha aplicado nada. Genera un plan nuevo.",
		};
	}

	// El plan es de un solo uso. KV no es atómico: el cerrojo global evita que dos apply_plan simultáneos lo ejecuten
	// ambos; el borrado evita que un reintento posterior duplique pasos previos.
	if (deps.claim && !(await deps.claim(planId))) {
		return { ok: false, message: `El plan ${planId} ya se está aplicando o ya se aplicó. No se ha vuelto a ejecutar. Revisa get_audit_log.` };
	}
	await deps.kv.delete(`plan:${planId}`);
	const created: string[] = [];
	const responses: Json = {};
	try {
		const map = new Map<string, string>();
		if (plan.preSteps?.length) {
			const res = await deps.client.mutateService(plan.customerId, "customAudiences", plan.preSteps.map((p) => p.operation), false);
			responses.customAudiences = res;
			(res.results ?? []).forEach((r: Json, i: number) => {
				map.set(plan.preSteps![i].placeholder, r.resourceName);
				created.push(r.resourceName);
			});
			if (map.size !== plan.preSteps.length) throw new Error("La API no devolvió todos los custom audiences creados.");
		}
		if (plan.apiCall) {
			const res = await deps.client.request(plan.apiCall.httpMethod, plan.apiCall.path, plan.apiCall.body);
			responses.apiCall = res;
			for (const rn of JSON.stringify(res).match(/customers\/\d+\/[A-Za-z]+\/[\w~-]+/g) ?? []) if (!created.includes(rn)) created.push(rn);
		}
		if (plan.operations.length) {
			const ops = map.size ? replacePlaceholders(plan.operations, map) : plan.operations;
			const response = await deps.client.mutate(plan.customerId, ops, false);
			responses.googleAds = response;
			created.push(...extractResourceNames(response));
		}
	} catch (e) {
		const error = e instanceof GoogleAdsApiError ? e.toJSON() : String(e);
		let auditWarning = "";
		try {
			await writeAudit(deps, { ...base, outcome: "FAILED", error, api_response: responses, resource_names: created });
		} catch (ae) {
			auditWarning = ` (No se pudo escribir la auditoría: ${(ae as Error).message})`;
		}
		const partial = created.length ? ` Atención: ya se habían creado ${created.join(", ")} (pasos previos); la operación principal no se aplicó.` : "";
		return { ok: false, message: `${e instanceof Error ? e.message : String(e)}${partial}${auditWarning}`, errors: error, created_before_failure: created };
	}
	// Los cambios YA están aplicados: un fallo al auditar no puede convertirse en "no se aplicó".
	const warnings: string[] = [];
	try {
		await writeAudit(deps, { ...base, outcome: "APPLIED", api_response: responses, resource_names: created });
	} catch (ae) {
		warnings.push(`Cambios APLICADOS, pero no se pudo escribir el registro de auditoría: ${(ae as Error).message}`);
	}
	return {
		ok: true,
		...(warnings.length ? { warnings } : {}),
		plan_id: planId,
		applied_operations: plan.operations.length + (plan.preSteps?.length ?? 0) + (plan.apiCall ? 1 : 0),
		resource_names: created,
		summary: plan.summary,
		response: plan.apiCall ? responses.apiCall : undefined,
	};
}

export function money(micros: number | string | undefined, currency: string): string {
	return `${fromMicros(micros as number).toFixed(2)} ${currency}`;
}
