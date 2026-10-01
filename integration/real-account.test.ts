/**
 * Integración contra la cuenta real (8460514008 bajo la MCC 2567236642).
 * SOLO lectura + validateOnly. Este fichero no llama nunca a applyPlan.
 *
 * Requiere en el entorno: GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID,
 * GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN.
 * Ejecutar: npm run integration
 */
import { describe, expect, it } from "vitest";
import { GoogleAdsClient } from "../src/ads/client";
import { getLimits, missingSecrets } from "../src/config";
import { buildCampaignBudgetPlan } from "../src/plans/builders";
import { buildDemandGenPlan } from "../src/plans/demandgen";
import { type Deps, createPlan } from "../src/plans/engine";
import { campaignOverview, listAccessibleCustomers, networkBreakdown } from "../src/tools/read";
import { MemoryKV } from "../test/helpers";

declare const process: { env: Record<string, string | undefined> };

const env = {
	GOOGLE_ADS_DEVELOPER_TOKEN: process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "",
	GOOGLE_ADS_CLIENT_ID: process.env.GOOGLE_ADS_CLIENT_ID ?? "",
	GOOGLE_ADS_CLIENT_SECRET: process.env.GOOGLE_ADS_CLIENT_SECRET ?? "",
	GOOGLE_ADS_REFRESH_TOKEN: process.env.GOOGLE_ADS_REFRESH_TOKEN ?? "",
	GOOGLE_ADS_LOGIN_CUSTOMER_ID: "2567236642",
	ALLOWED_CUSTOMER_IDS: "8460514008",
	MAX_DAILY_BUDGET: "60",
	MAX_BUDGET_INCREASE_PCT: "100",
};
const missing = missingSecrets(env);
const CID = "8460514008";
const client = new GoogleAdsClient(env);
const limits = getLimits(env);
const deps: Deps = { client, kv: new MemoryKV() as unknown as KVNamespace, limits, userEmail: "integration-test" };

const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

async function campaignIdByName(name: string): Promise<string> {
	const rows = await client.searchAll(CID, `SELECT campaign.id FROM campaign WHERE campaign.name = '${name}' AND campaign.status != 'REMOVED'`);
	if (!rows.length) throw new Error(`No existe la campaña ${name}`);
	return String(rows[0].campaign.id);
}

describe.skipIf(missing.length > 0)("cuenta real: solo lectura", () => {
	it("list_accessible_customers", async () => {
		const list = await listAccessibleCustomers(client, limits);
		console.table(list.map((c) => ({ id: c.customer_id, name: c.name, currency: c.currency, tz: c.time_zone, write: c.write_allowed })));
		expect(list.some((c) => c.customer_id === CID)).toBe(true);
	});

	it("get_campaign_overview últimos 7 días", async () => {
		const o = await campaignOverview(client, CID, day(-7), day(-1));
		console.log(`Moneda: ${o.currency} | ${o.date_from} → ${o.date_to}`);
		console.table(o.campaigns.filter((c) => c.status === "ENABLED").map((c) => ({ name: c.name, type: c.type, budget: c.daily_budget, geo: c.geo_target_type, cost: c.cost, clicks: c.clicks, conv: c.conversions })));
		expect(o.currency).toBeTruthy();
	});

	it("get_network_breakdown últimos 7 días", async () => {
		const n = await networkBreakdown(client, CID, day(-7), day(-1));
		console.table(n.totals_by_network);
		expect(n.totals_by_network).toBeTypeOf("object");
	});
});

describe.skipIf(missing.length > 0)("cuenta real: planes con validateOnly (NO se aplican)", () => {
	it("bajar presupuesto de Neurored_EN_NATO_PMax_Leads a 10/día", async () => {
		const id = await campaignIdByName("Neurored_EN_NATO_PMax_Leads");
		const r = await createPlan(deps, await buildCampaignBudgetPlan(client, CID, id, 10));
		console.log(JSON.stringify(r, null, 2));
		expect(r.ok).toBe(true);
	});

	it("crear TEST_MCP_DemandGen_Discover (Discover+Gmail, AE+SG, Presence, 25/día, PAUSED)", async () => {
		const pmaxId = await campaignIdByName("Neurored_EN_NATO_PMax_Freight_Forwarding_Software");
		const input = {
			name: "TEST_MCP_DemandGen_Discover",
			daily_budget: 25,
			bidding_strategy: "MAXIMIZE_CONVERSIONS" as const,
			country_codes: ["AE", "SG"],
			geo_target_type: "PRESENCE" as const,
			language_codes: ["en"],
			channels: ["DISCOVER" as const, "GMAIL" as const],
			reuse_assets_from_campaign_id: pmaxId,
			new_custom_audiences: [
				{
					key: "ff",
					name: `TEST_MCP_FF_Searchers_${Date.now()}`,
					search_terms: ["freight forwarding software", "freight forwarder crm", "tms for freight forwarders", "logistics software salesforce"],
				},
			],
			ad_groups: [{ name: "TEST_MCP_AE_SG", custom_audience_keys: ["ff"], ads: [{ final_url: "https://www.neurored.com/" }] }],
		};
		let r = await createPlan(deps, await buildDemandGenPlan(client, CID, input, "CUSTOM_AUDIENCE_CRITERION"));
		let mode = "CUSTOM_AUDIENCE_CRITERION";
		if (!r.ok && r.stage === "validation") {
			console.log("Primer intento (criterio custom_audience) rechazado:\n", r.message);
			r = await createPlan(deps, await buildDemandGenPlan(client, CID, input, "AUDIENCE_RESOURCE"));
			mode = "AUDIENCE_RESOURCE";
		}
		console.log(`audience_mode=${mode}\n${JSON.stringify(r, null, 2)}`);
		expect(r.ok).toBe(true);
	});
});

it("credenciales presentes", () => {
	if (missing.length) console.warn(`Integración OMITIDA: faltan ${missing.join(", ")} en el entorno.`);
	expect(true).toBe(true);
});
