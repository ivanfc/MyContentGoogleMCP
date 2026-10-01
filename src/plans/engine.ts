import { GoogleAdsApiError, type GoogleAdsClient, type Json } from "../ads/client";
import { type Limits, PLAN_TTL_SECONDS, fromMicros } from "../config";
import { type BudgetInfo, GuardError, enforceGuards } from "../guards";

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
}

export interface Deps {
	client: GoogleAdsClient;
	kv: KVNamespace;
	limits: Limits;
	userEmail: string;
	now?: () => number;
}

export interface PlanDraft {
	kind: string;
	customerId: string;
	summary: string[];
	warnings?: string[];
	operations: Json[];
	/** GAQL que leen exactamente los campos que el plan va a tocar. Se re-ejecutan en apply_plan. */
	stateQueries: string[];
	guardFlags?: Plan["guardFlags"];
}

export type PlanResult =
	| { ok: true; plan_id: string; expires_at_utc: string; confirm_with: string; kind: string; customer_id: string; summary: string[]; warnings: string[]; operations_count: number; validation: "OK (validateOnly)" }
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
	const parts: string[] = [];
	for (const q of queries) {
		const rows = await client.searchAll(customerId, q);
		parts.push(JSON.stringify(rows.map((r) => JSON.stringify(stripVolatile(r))).sort()));
	}
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

function guardCtx(deps: Deps, customerId: string, flags: Plan["guardFlags"]) {
	return {
		customerId,
		limits: deps.limits,
		getBudget: budgetReader(deps.client, customerId),
		allowCampaignEnable: flags.allowCampaignEnable,
		allowSharedBudget: flags.allowSharedBudget,
	};
}

/** Fase 1: barreras → lectura de estado → validateOnly → guardar plan en KV (30 min). */
export async function createPlan(deps: Deps, draft: PlanDraft): Promise<PlanResult> {
	const warnings = draft.warnings ?? [];
	const flags = draft.guardFlags ?? {};
	try {
		await enforceGuards(draft.operations, guardCtx(deps, draft.customerId, flags));
	} catch (e) {
		if (e instanceof GuardError) {
			return { ok: false, stage: "guards", summary: draft.summary, warnings, errors: e.violations, message: e.message };
		}
		throw e;
	}

	const stateHash = await computeStateHash(deps.client, draft.customerId, draft.stateQueries);

	try {
		await deps.client.mutate(draft.customerId, draft.operations, true);
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
	};
	await deps.kv.put(`plan:${id}`, JSON.stringify(plan), { expirationTtl: PLAN_TTL_SECONDS });
	return {
		ok: true,
		plan_id: id,
		expires_at_utc: new Date(plan.expiresAt).toISOString(),
		confirm_with: `APPLY ${id}`,
		kind: plan.kind,
		customer_id: plan.customerId,
		summary: plan.summary,
		warnings,
		operations_count: plan.operations.length,
		validation: "OK (validateOnly)",
	};
}

export async function loadPlan(deps: Deps, planId: string): Promise<Plan | undefined> {
	const raw = await deps.kv.get(`plan:${planId}`);
	if (!raw) return undefined;
	const plan = JSON.parse(raw) as Plan;
	if (plan.expiresAt <= now(deps)) {
		await deps.kv.delete(`plan:${planId}`);
		return undefined;
	}
	return plan;
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
	summary: string[];
	operations: Json[];
	api_response?: Json;
	resource_names?: string[];
	error?: unknown;
}

const AUDIT_MAX_KEY = 9_999_999_999_999;

async function writeAudit(deps: Deps, rec: AuditRecord) {
	const inverted = String(AUDIT_MAX_KEY - now(deps)).padStart(13, "0");
	await deps.kv.put(`audit:${inverted}:${rec.plan_id}`, JSON.stringify(rec));
}

export async function getAuditLog(kv: KVNamespace, limit: number): Promise<AuditRecord[]> {
	const list = await kv.list({ prefix: "audit:", limit: Math.min(Math.max(limit, 1), 100) });
	const out: AuditRecord[] = [];
	for (const k of list.keys) {
		const raw = await kv.get(k.name);
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
	if (!plan) return { ok: false, message: `El plan ${planId} no existe o ha caducado (30 min). Genera un plan nuevo.` };
	if (confirm !== `APPLY ${planId}`) {
		return { ok: false, message: `Confirmación incorrecta. Debe ser exactamente "APPLY ${planId}".` };
	}

	// Defensa en profundidad: las barreras se re-evalúan con el estado actual.
	try {
		await enforceGuards(plan.operations, guardCtx(deps, plan.customerId, plan.guardFlags));
	} catch (e) {
		if (e instanceof GuardError) return { ok: false, message: e.message };
		throw e;
	}

	const currentHash = await computeStateHash(deps.client, plan.customerId, plan.stateQueries);
	const base: Omit<AuditRecord, "outcome"> = {
		timestamp_utc: new Date(now(deps)).toISOString(),
		user_email: deps.userEmail,
		customer_id: plan.customerId,
		plan_id: plan.id,
		kind: plan.kind,
		summary: plan.summary,
		operations: plan.operations,
	};
	if (currentHash !== plan.stateHash) {
		await deps.kv.delete(`plan:${planId}`);
		await writeAudit(deps, { ...base, outcome: "ABORTED_STATE_CHANGED" });
		return {
			ok: false,
			message: "El estado de la cuenta ha cambiado desde que se creó el plan (hash distinto). No se ha aplicado nada. Genera un plan nuevo.",
		};
	}

	try {
		const response = await deps.client.mutate(plan.customerId, plan.operations, false);
		const resourceNames = extractResourceNames(response);
		await writeAudit(deps, { ...base, outcome: "APPLIED", api_response: response, resource_names: resourceNames });
		await deps.kv.delete(`plan:${planId}`);
		return { ok: true, plan_id: planId, applied_operations: plan.operations.length, resource_names: resourceNames, summary: plan.summary };
	} catch (e) {
		const error = e instanceof GoogleAdsApiError ? e.toJSON() : String(e);
		await writeAudit(deps, { ...base, outcome: "FAILED", error });
		return { ok: false, message: e instanceof Error ? e.message : String(e), errors: error };
	}
}

export function money(micros: number | string | undefined, currency: string): string {
	return `${fromMicros(micros as number).toFixed(2)} ${currency}`;
}
