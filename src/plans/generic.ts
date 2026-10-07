import type { GoogleAdsClient, Json } from "../ads/client";
import type { PlanDraft } from "./engine";

/** Operación de mutate → recurso GAQL, para leer el estado ANTES y calcular el hash. */
const RESOURCE_BY_OP: Record<string, string> = {
	campaignOperation: "campaign",
	campaignBudgetOperation: "campaign_budget",
	campaignCriterionOperation: "campaign_criterion",
	campaignAssetOperation: "campaign_asset",
	campaignSharedSetOperation: "campaign_shared_set",
	campaignBidModifierOperation: "campaign_bid_modifier",
	campaignConversionGoalOperation: "campaign_conversion_goal",
	adGroupOperation: "ad_group",
	adGroupAdOperation: "ad_group_ad",
	adGroupCriterionOperation: "ad_group_criterion",
	adGroupAssetOperation: "ad_group_asset",
	adGroupBidModifierOperation: "ad_group_bid_modifier",
	adOperation: "ad",
	assetOperation: "asset",
	assetGroupOperation: "asset_group",
	assetGroupAssetOperation: "asset_group_asset",
	customAudienceOperation: "custom_audience",
	customerNegativeCriterionOperation: "customer_negative_criterion",
	sharedSetOperation: "shared_set",
	sharedCriterionOperation: "shared_criterion",
};

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function getPath(obj: Json | undefined, path: string): unknown {
	return path.split(".").reduce<any>((o, k) => (o == null ? undefined : o[camel(k)]), obj);
}

export function parseOperations(operationsJson: string | Json[]): Json[] {
	let ops: unknown = operationsJson;
	if (typeof operationsJson === "string") {
		try {
			ops = JSON.parse(operationsJson);
		} catch (e) {
			throw new Error(`operations_json no es JSON válido: ${(e as Error).message}`);
		}
	}
	if (ops && !Array.isArray(ops) && Array.isArray((ops as Json).mutateOperations)) ops = (ops as Json).mutateOperations;
	if (!Array.isArray(ops)) throw new Error('operations_json debe ser un array de MutateOperation, p. ej. [{"campaignOperation": {"update": {...}, "updateMask": "status"}}]');
	return ops as Json[];
}

/** Ejecuta tareas con concurrencia limitada (respeta el orden de los resultados). */
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

const IN_CHUNK = 200;

export async function buildGenericPlan(client: GoogleAdsClient, cid: string, operationsJson: string | Json[]): Promise<PlanDraft> {
	const ops = parseOperations(operationsJson);
	const summary: string[] = [];
	const warnings: string[] = [];
	const stateQueries: string[] = [];

	// 1) Clasificar. Las lecturas de estado se agrupan por recurso y campos (una consulta con IN por grupo, no una
	//    por operación): un plan de 40 updates pasaba de ~80 consultas en serie (40 al crear + 40 del hash) a unas pocas.
	type Item = { i: number; kind: string; op: Json; action: string; res?: string; target?: string; mask: string[]; groupKey?: string };
	const items: Item[] = [];
	const groups = new Map<string, { res: string; fields: string[]; targets: Set<string>; mask: string[] }>();
	for (const [i, wrapper] of ops.entries()) {
		const kind = Object.keys(wrapper ?? {})[0];
		if (kind === "customAudienceOperation") {
			throw new Error(`#${i}: customAudienceOperation no existe en GoogleAdsService.Mutate. Usa plan_create_custom_audience o plan_api_call con customers.customAudiences.mutate.`);
		}
		const op = wrapper?.[kind] ?? {};
		const action = ["create", "update", "remove"].find((a) => op[a] !== undefined) ?? "?";
		const res = RESOURCE_BY_OP[kind];
		const target: string | undefined = action === "remove" ? op.remove : op[action]?.resourceName;
		const mask = action === "update" ? String(op.updateMask ?? "").split(",").map((s: string) => s.trim()).filter(Boolean) : [];
		const item: Item = { i, kind, op, action, res, target, mask };
		items.push(item);
		if (action === "create" || !res || !target || !/^customers\/\d+\/[A-Za-z]+\/[\w~-]+$/.test(target)) continue;
		const fields = [...new Set([`${res}.resource_name`, ...mask.map((m) => `${res}.${m}`), ...(res.endsWith("criterion") || res === "campaign" || res === "ad_group" ? [`${res}.status`] : [])])];
		const key = `${res}|${fields.join(",")}`;
		const g = groups.get(key) ?? { res, fields, targets: new Set<string>(), mask };
		g.targets.add(target);
		groups.set(key, g);
		item.groupKey = key;
	}

	// 2) Leer el estado de cada grupo (en paralelo, con límite) en bloques de IN_CHUNK resource names.
	const before = new Map<string, Json>();
	const unreadable = new Set<string>();
	const jobs = [...groups.entries()].flatMap(([key, g]) => {
		const t = [...g.targets];
		return Array.from({ length: Math.ceil(t.length / IN_CHUNK) }, (_, c) => ({ key, g, names: t.slice(c * IN_CHUNK, (c + 1) * IN_CHUNK) }));
	});
	await pool(jobs, 4, async ({ key, g, names }) => {
		const where = `WHERE ${g.res}.resource_name IN (${names.map((n) => `'${n}'`).join(", ")})`;
		let q = `SELECT ${g.fields.join(", ")} FROM ${g.res} ${where}`;
		let rows: Json[];
		try {
			rows = await client.searchAll(cid, q);
		} catch {
			// Algún campo del updateMask no es seleccionable en GAQL: se lee solo el estado básico.
			q = `SELECT ${g.res}.resource_name FROM ${g.res} ${where}`;
			try {
				rows = await client.searchAll(cid, q);
			} catch (e) {
				throw new Error(`No se pudo leer el estado de ${names[0]}${names.length > 1 ? ` (y ${names.length - 1} más)` : ""}: ${(e as Error).message}`);
			}
			unreadable.add(key);
		}
		stateQueries.push(q);
		for (const r of rows) {
			const obj = r[camel(g.res)];
			if (obj?.resourceName) before.set(obj.resourceName, obj);
		}
	});
	stateQueries.sort();

	// 3) Resumen en el orden original.
	const show = (v: unknown) => (v === undefined ? "(vacío / valor por defecto)" : JSON.stringify(v));
	for (const it of items) {
		const { i, kind, op, action, target, mask } = it;
		if (action === "create") {
			summary.push(`#${i} ${kind} CREATE (no existe) → ${JSON.stringify(op.create).slice(0, 400)}`);
			continue;
		}
		if (!it.groupKey) {
			summary.push(`#${i} ${kind} ${action.toUpperCase()} ${target ?? "?"}`);
			warnings.push(`#${i}: no se puede leer el estado previo de ${kind}; no entra en la detección de cambios.`);
			continue;
		}
		const b = before.get(target!);
		if (!b) throw new Error(`#${i}: ${target} no existe en la cuenta ${cid}.`);
		if (unreadable.has(it.groupKey)) warnings.push(`#${i}: los campos ${mask.join(", ")} no se pueden leer por GAQL; el ANTES no se muestra y no entran en la detección de cambios.`);
		if (action === "remove") {
			summary.push(`#${i} ${kind} REMOVE ${target} (estado actual ${JSON.stringify(b.status ?? "?")}) → eliminado`);
		} else {
			// La API omite los valores por defecto (false, 0, "", listas vacías): ausente ≠ desconocido.
			const changes = mask.map((m: string) => `${m}: ${show(getPath(b, m))} → ${show(getPath(op.update, m))}`);
			summary.push(`#${i} ${kind} UPDATE ${target}: ${changes.join("; ") || "(sin updateMask)"}`);
			if (!mask.length) warnings.push(`#${i}: update sin updateMask.`);
		}
	}
	return { kind: "generic_mutate", customerId: cid, summary, warnings, operations: ops, stateQueries };
}
