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

export async function buildGenericPlan(client: GoogleAdsClient, cid: string, operationsJson: string | Json[]): Promise<PlanDraft> {
	const ops = parseOperations(operationsJson);
	const summary: string[] = [];
	const warnings: string[] = [];
	const stateQueries: string[] = [];

	for (const [i, wrapper] of ops.entries()) {
		const kind = Object.keys(wrapper ?? {})[0];
		if (kind === "customAudienceOperation") {
			throw new Error(`#${i}: customAudienceOperation no existe en GoogleAdsService.Mutate. Usa plan_create_custom_audience.`);
		}
		const op = wrapper?.[kind] ?? {};
		const action = ["create", "update", "remove"].find((a) => op[a] !== undefined) ?? "?";
		const res = RESOURCE_BY_OP[kind];
		const target: string | undefined = action === "remove" ? op.remove : op[action]?.resourceName;
		if (action === "create") {
			summary.push(`#${i} ${kind} CREATE (no existe) → ${JSON.stringify(op.create).slice(0, 400)}`);
			continue;
		}
		if (!res || !target || !/^customers\/\d+\/[A-Za-z]+\/[\w~-]+$/.test(target)) {
			summary.push(`#${i} ${kind} ${action.toUpperCase()} ${target ?? "?"}`);
			warnings.push(`#${i}: no se puede leer el estado previo de ${kind}; no entra en la detección de cambios.`);
			continue;
		}
		const mask = action === "update" ? String(op.updateMask ?? "").split(",").map((s: string) => s.trim()).filter(Boolean) : [];
		const fields = [`${res}.resource_name`, ...mask.map((m: string) => `${res}.${m}`), ...(res.endsWith("criterion") || res === "campaign" || res === "ad_group" ? [`${res}.status`] : [])];
		let q = `SELECT ${[...new Set(fields)].join(", ")} FROM ${res} WHERE ${res}.resource_name = '${target}'`;
		let before: Json | undefined;
		try {
			before = (await client.searchAll(cid, q))[0]?.[camel(res)];
		} catch {
			// Algún campo del updateMask no es seleccionable en GAQL: se lee solo el estado básico.
			q = `SELECT ${res}.resource_name FROM ${res} WHERE ${res}.resource_name = '${target}'`;
			try {
				before = (await client.searchAll(cid, q))[0]?.[camel(res)];
			} catch (e) {
				throw new Error(`No se pudo leer el estado de ${target} (#${i}): ${(e as Error).message}`);
			}
			warnings.push(`#${i}: los campos ${mask.join(", ")} no se pueden leer por GAQL; el ANTES no se muestra y no entran en la detección de cambios.`);
		}
		stateQueries.push(q);
		if (!before) throw new Error(`#${i}: ${target} no existe en la cuenta ${cid}.`);
		if (action === "remove") {
			summary.push(`#${i} ${kind} REMOVE ${target} (estado actual ${JSON.stringify(before.status ?? "?")}) → eliminado`);
		} else {
			const changes = mask.map((m: string) => `${m}: ${JSON.stringify(getPath(before, m))} → ${JSON.stringify(getPath(op.update, m))}`);
			summary.push(`#${i} ${kind} UPDATE ${target}: ${changes.join("; ") || "(sin updateMask)"}`);
			if (!mask.length) warnings.push(`#${i}: update sin updateMask.`);
		}
	}
	return { kind: "generic_mutate", customerId: cid, summary, warnings, operations: ops, stateQueries };
}
