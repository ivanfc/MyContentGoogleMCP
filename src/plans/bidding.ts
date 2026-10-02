import { type GoogleAdsClient, type Json, assertId } from "../ads/client";
import { fromMicros, toMicros } from "../config";
import { getCurrency } from "./builders";
import type { PlanDraft } from "./engine";

export const BIDDING_STRATEGIES = ["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "MAXIMIZE_CLICKS", "MANUAL_CPC"] as const;
export type BiddingStrategy = (typeof BIDDING_STRATEGIES)[number];

export interface BiddingInput {
	strategy: BiddingStrategy;
	/** CPA objetivo en moneda de la cuenta (solo MAXIMIZE_CONVERSIONS). */
	target_cpa?: number;
	/** ROAS objetivo como ratio (4 = 400 %) (solo MAXIMIZE_CONVERSION_VALUE). */
	target_roas?: number;
	/** CPC máximo en moneda de la cuenta (MAXIMIZE_CLICKS). */
	max_cpc?: number;
}

/**
 * Representaciones alternativas de cada estrategia estándar. La API acepta unas u otras según el tipo y la
 * antigüedad de la campaña (verificado: en una Display antigua el CPA objetivo solo vale como `target_cpa`,
 * en Search/PMax vale dentro de `maximize_conversions`). La herramienta prueba en orden con validateOnly.
 */
export function biddingVariants(input: BiddingInput): { update: Json; updateMask: string; label: string }[] {
	const { strategy } = input;
	if (strategy === "MAXIMIZE_CONVERSIONS") {
		const cpa = input.target_cpa ? String(toMicros(input.target_cpa)) : "0";
		const v: { update: Json; updateMask: string; label: string }[] = [{ update: { maximizeConversions: { targetCpaMicros: cpa } }, updateMask: "maximize_conversions.target_cpa_micros", label: "maximize_conversions" }];
		if (input.target_cpa) v.push({ update: { targetCpa: { targetCpaMicros: cpa } }, updateMask: "target_cpa.target_cpa_micros", label: "target_cpa" });
		return v;
	}
	if (strategy === "MAXIMIZE_CONVERSION_VALUE") {
		const roas = input.target_roas ?? 0;
		const v: { update: Json; updateMask: string; label: string }[] = [{ update: { maximizeConversionValue: { targetRoas: roas } }, updateMask: "maximize_conversion_value.target_roas", label: "maximize_conversion_value" }];
		if (input.target_roas) v.push({ update: { targetRoas: { targetRoas: roas } }, updateMask: "target_roas.target_roas", label: "target_roas" });
		return v;
	}
	if (strategy === "MAXIMIZE_CLICKS") {
		const ceiling = input.max_cpc ? String(toMicros(input.max_cpc)) : "0";
		return [{ update: { targetSpend: { cpcBidCeilingMicros: ceiling } }, updateMask: "target_spend.cpc_bid_ceiling_micros", label: "target_spend" }];
	}
	return [{ update: { manualCpc: { enhancedCpcEnabled: false } }, updateMask: "manual_cpc.enhanced_cpc_enabled", label: "manual_cpc" }];
}

export async function buildBiddingPlans(client: GoogleAdsClient, cid: string, campaignId: string, input: BiddingInput): Promise<PlanDraft[]> {
	const id = assertId(campaignId, "campaign_id");
	if (input.target_cpa !== undefined && input.strategy !== "MAXIMIZE_CONVERSIONS") throw new Error("target_cpa solo aplica a MAXIMIZE_CONVERSIONS.");
	if (input.target_roas !== undefined && input.strategy !== "MAXIMIZE_CONVERSION_VALUE") throw new Error("target_roas solo aplica a MAXIMIZE_CONVERSION_VALUE.");
	if (input.max_cpc !== undefined && input.strategy !== "MAXIMIZE_CLICKS") throw new Error("max_cpc solo aplica a MAXIMIZE_CLICKS.");
	const q = `SELECT campaign.resource_name, campaign.name, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.maximize_conversions.target_cpa_micros, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversion_value.target_roas, campaign.target_roas.target_roas, campaign.target_spend.cpc_bid_ceiling_micros FROM campaign WHERE campaign.id = ${id}`;
	const row = (await client.searchAll(cid, q))[0]?.campaign;
	if (!row) throw new Error(`La campaña ${id} no existe en ${cid}.`);
	if (row.biddingStrategy) {
		throw new Error(`La campaña "${row.name}" usa una estrategia de cartera compartida (${row.biddingStrategy}). Para cambiarla usa plan_generic_mutate (exige APPLY-ELEVATED).`);
	}
	if (row.advertisingChannelType === "PERFORMANCE_MAX" && (input.strategy === "MAXIMIZE_CLICKS" || input.strategy === "MANUAL_CPC")) {
		// Verificado contra la API: OPERATION_NOT_PERMITTED_FOR_CONTEXT.
		throw new Error("Performance Max solo admite MAXIMIZE_CONVERSIONS (con o sin CPA objetivo) y MAXIMIZE_CONVERSION_VALUE (con o sin ROAS objetivo).");
	}
	if (row.advertisingChannelType === "DEMAND_GEN" && (input.strategy === "MANUAL_CPC" || (input.strategy === "MAXIMIZE_CLICKS" && input.max_cpc !== undefined))) {
		// Verificado contra la API (Neurored, 02-10-2026): OPERATION_NOT_PERMITTED_FOR_CONTEXT.
		throw new Error("Demand Gen no admite CPC manual ni MAXIMIZE_CLICKS con CPC máximo. Usa MAXIMIZE_CONVERSIONS (con o sin CPA objetivo) o MAXIMIZE_CLICKS sin max_cpc.");
	}
	const currency = await getCurrency(client, cid);
	const curCpa = row.maximizeConversions?.targetCpaMicros ?? row.targetCpa?.targetCpaMicros;
	const curRoas = row.maximizeConversionValue?.targetRoas ?? row.targetRoas?.targetRoas;
	const before = `${row.biddingStrategyType}${curCpa ? ` (CPA ${fromMicros(curCpa).toFixed(2)} ${currency})` : ""}${curRoas ? ` (ROAS ${curRoas})` : ""}`;
	const after = `${input.strategy}${input.target_cpa ? ` (CPA ${input.target_cpa.toFixed(2)} ${currency})` : ""}${input.target_roas ? ` (ROAS ${input.target_roas})` : ""}${input.max_cpc ? ` (CPC máx. ${input.max_cpc.toFixed(2)} ${currency})` : ""}`;
	return biddingVariants(input).map((v) => ({
		kind: "update_bidding_strategy",
		customerId: cid,
		summary: [`Campaña "${row.name}" (${id}, ${row.advertisingChannelType})`, `Estrategia de puja: ${before} → ${after} [representación API: ${v.label}]`],
		warnings: ["Cambiar la estrategia reinicia el aprendizaje del algoritmo (varios días de rendimiento inestable)."],
		operations: [{ campaignOperation: { update: { resourceName: row.resourceName, ...v.update }, updateMask: v.updateMask } }],
		stateQueries: [q],
	}));
}
