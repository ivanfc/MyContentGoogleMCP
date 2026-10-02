import { describe, expect, it } from "vitest";
import { getLimits } from "../src/config";
import { enforceGuards } from "../src/guards";
import { type ApiCall, buildPath, guardApiCall } from "../src/plans/apicall";
import { buildCampaignBudgetPlan } from "../src/plans/builders";
import { applyPlan, computeStateHash, createPlan } from "../src/plans/engine";
import { buildGenericPlan } from "../src/plans/generic";
import { CID, ENV, setup } from "./helpers";

const BUDGET = `customers/${CID}/campaignBudgets/14685111966`;
const CAMPAIGN = `customers/${CID}/campaigns/22714600993`;

function withBudget(ads: ReturnType<typeof setup>["ads"]) {
	ads.on(/FROM campaign WHERE campaign.id = 22714600993/, () => [
		{
			campaign: { id: "22714600993", name: "PMax_Leads", campaignBudget: BUDGET },
			campaignBudget: { resourceName: BUDGET, name: "b", amountMicros: "25000000", explicitlyShared: false, referenceCount: "1" },
		},
	]);
	ads.on(/FROM campaign_budget WHERE/, () => [{ campaignBudget: { resourceName: BUDGET, amountMicros: "25000000", explicitlyShared: false, referenceCount: "1" } }]);
}

async function budgetPlan() {
	const s = setup();
	withBudget(s.ads);
	const r = await createPlan(s.deps, await buildCampaignBudgetPlan(s.client, CID, "22714600993", 10));
	if (!r.ok) throw new Error(r.message);
	return { ...s, planId: r.plan_id };
}

describe("plan_api_call: rutas", () => {
	const m = { id: "googleads.customers.experiments.endExperiment", httpMethod: "POST" as const, path: "{+experiment}:endExperiment", kind: "write" as const, supportsValidateOnly: true, description: "", params: ["experiment"] };
	it("rechaza segmentos relativos o vacíos que, normalizados, apuntarían a otra cuenta", () => {
		expect(() => buildPath(m, { experiment: `customers/${CID}/x/y/../../../2222222222/experiments/1` })).toThrow(/relativos/);
		expect(() => buildPath(m, { experiment: `customers/${CID}//experiments/1` })).toThrow(/relativos/);
		expect(() => buildPath(m, { experiment: `customers/${CID}/./experiments/1` })).toThrow(/relativos/);
		expect(buildPath(m, { experiment: `customers/${CID}/experiments/1` })).toBe(`customers/${CID}/experiments/1:endExperiment`);
	});
});

describe("plan_api_call: custom audiences", () => {
	const { limits } = setup();
	const call = (body: any): ApiCall => ({ methodId: "googleads.customers.customAudiences.mutate", httpMethod: "POST", path: `customers/${CID}/customAudiences:mutate`, body, supportsValidateOnly: true });
	it("crear es confirmación normal; borrar o editar exige APPLY-ELEVATED", () => {
		expect(guardApiCall(call({ operations: [{ create: { name: "x" } }] }), CID, limits)).toEqual([]);
		expect(guardApiCall(call({ operations: [{ remove: `customers/${CID}/customAudiences/1` }] }), CID, limits)[0]).toMatch(/BORRAN/);
		expect(guardApiCall(call({ operations: [{ update: { resourceName: `customers/${CID}/customAudiences/1` }, updateMask: "members" }] }), CID, limits)).toHaveLength(1);
	});
});

describe("guards: reasignar presupuesto", () => {
	const limits = getLimits(ENV);
	const shared = async () => ({ amountMicros: 5_000_000_000, explicitlyShared: true, referenceCount: 4 });
	it("cambiar campaign_budget a un presupuesto grande y compartido exige confirmación reforzada", async () => {
		const r = await enforceGuards(
			[{ campaignOperation: { update: { resourceName: CAMPAIGN, campaignBudget: `customers/${CID}/campaignBudgets/9` }, updateMask: "campaign_budget" } }],
			{ customerId: CID, limits, getBudget: shared },
		);
		const all = r.elevated.join(" | ");
		expect(all).toMatch(/MAX_DAILY_BUDGET/);
		expect(all).toMatch(/COMPARTIDO/);
		expect(all).toMatch(/cambia el presupuesto/);
	});
	it("un presupuesto nuevo del propio plan (ID temporal) no se lee", async () => {
		const r = await enforceGuards(
			[
				{ campaignBudgetOperation: { create: { resourceName: `customers/${CID}/campaignBudgets/-1`, amountMicros: "10000000" } } },
				{ campaignOperation: { create: { name: "x", status: "PAUSED", campaignBudget: `customers/${CID}/campaignBudgets/-1` } } },
			],
			{ customerId: CID, limits, getBudget: async () => undefined },
		);
		expect(r.elevated).toEqual([]);
	});
});

describe("apply_plan robusto", () => {
	it("si otro apply ya reclamó el plan, no ejecuta nada", async () => {
		const { ads, deps, planId } = await budgetPlan();
		const a = await applyPlan({ ...deps, claim: async () => false }, planId, `APPLY ${planId}`);
		expect(a.ok).toBe(false);
		expect(a.message).toMatch(/ya se está aplicando o ya se aplicó/);
		expect(ads.mutateCalls.filter((c) => !c.body.validateOnly)).toHaveLength(0);
	});

	it("re-comprueba al aplicar que la cuenta sigue siendo escribible", async () => {
		const { ads, deps, planId } = await budgetPlan();
		const a = await applyPlan({ ...deps, assertWritable: async () => { throw new Error("La cuenta ya no cuelga de la MCC."); } }, planId, `APPLY ${planId}`);
		expect(a.ok).toBe(false);
		expect(a.message).toMatch(/ya no cuelga/);
		expect(ads.mutateCalls.filter((c) => !c.body.validateOnly)).toHaveLength(0);
	});

	it("si la auditoría falla DESPUÉS de aplicar, informa de que se aplicó (con aviso), no de un fallo", async () => {
		const { deps, kv, planId } = await budgetPlan();
		const put = kv.put.bind(kv);
		kv.put = async (key: string, value: string, opts?: { expirationTtl?: number }) => {
			if (key.startsWith("audit:")) throw new Error("KV write limit");
			return put(key, value, opts);
		};
		const a = await applyPlan(deps, planId, `APPLY ${planId}`);
		expect(a.ok).toBe(true);
		expect((a as { warnings?: string[] }).warnings?.join()).toMatch(/APLICADOS.*auditoría/);
	});

	it("el plan de presupuesto vigila también qué presupuesto usa la campaña", async () => {
		const s = setup();
		withBudget(s.ads);
		const d = await buildCampaignBudgetPlan(s.client, CID, "22714600993", 10);
		expect(d.stateQueries.some((q) => q.includes("campaign.campaign_budget"))).toBe(true);
	});
});

describe("hash de estado", () => {
	it("falla con un estado de más de 10.000 filas en lugar de hashear un subconjunto", async () => {
		const { ads, client } = setup();
		ads.on(/FROM customer_negative_criterion/, Array.from({ length: 10_001 }, (_, i) => ({ customerNegativeCriterion: { id: String(i) } })));
		await expect(computeStateHash(client, CID, ["SELECT customer_negative_criterion.id FROM customer_negative_criterion"])).rejects.toThrow(/10.000 filas/);
	});

	it("un plan sin lectura de estado lo advierte", async () => {
		const { client, deps } = setup();
		const r = await createPlan(deps, await buildGenericPlan(client, CID, [{ labelOperation: { create: { name: "x" } } }]));
		expect(r.ok && r.warnings.join()).toMatch(/no tiene lectura de estado/);
	});
});
