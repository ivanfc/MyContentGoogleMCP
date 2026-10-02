import { describe, expect, it } from "vitest";
import { getLimits, normalizeCustomerId, toMicros } from "../src/config";
import { GuardError, enforceGuards } from "../src/guards";
import { CID, ENV } from "./helpers";

const limits = getLimits(ENV);
const budget = (amountMicros: number, shared = false, refs = 1) => async () => ({ amountMicros, explicitlyShared: shared, referenceCount: refs });
const ctx = (over: Partial<Parameters<typeof enforceGuards>[1]> = {}) => ({ customerId: CID, limits, getBudget: budget(25_000_000), ...over });
const BRN = `customers/${CID}/campaignBudgets/1`;

async function violations(ops: any[], c = ctx()): Promise<string[]> {
	try {
		await enforceGuards(ops, c);
		return [];
	} catch (e) {
		if (e instanceof GuardError) return e.violations;
		throw e;
	}
}

describe("conversión a micros", () => {
	it("convierte moneda de la cuenta a micros redondeando al céntimo", () => {
		expect(toMicros(10)).toBe(10_000_000);
		expect(toMicros(25.5)).toBe(25_500_000);
		expect(toMicros(10.004)).toBe(10_000_000);
		expect(toMicros(0.01)).toBe(10_000);
	});
	it("rechaza importes no positivos", () => {
		expect(() => toMicros(0)).toThrow();
		expect(() => toMicros(-5)).toThrow();
		expect(() => toMicros(Number.NaN)).toThrow();
	});
	it("normaliza customer ids con guiones", () => {
		expect(normalizeCustomerId("846-051-4008")).toBe(CID);
		expect(() => normalizeCustomerId("123")).toThrow();
	});
});

describe("barreras", () => {
	it("allowlist: rechaza cuentas fuera de ALLOWED_CUSTOMER_IDS", async () => {
		const v = await violations([{ campaignOperation: { update: { resourceName: "customers/1111111111/campaigns/1", status: "PAUSED" }, updateMask: "status" } }], ctx({ customerId: "1111111111" }));
		expect(v[0]).toMatch(/ALLOWED_CUSTOMER_IDS/);
	});

	it("rechaza resource names de otra cuenta dentro de una cuenta permitida", async () => {
		const v = await violations([{ campaignOperation: { update: { resourceName: "customers/1111111111/campaigns/1", status: "PAUSED" }, updateMask: "status" } }]);
		expect(v.join()).toMatch(/otra cuenta/);
	});

	it.each([
		["conversionActionOperation", /acciones de conversión/],
		["biddingStrategyOperation", /cartera/],
		["customerOperation", /configuración de la cuenta/],
		["customerConversionGoalOperation", /conversión/],
	])("prohíbe %s", async (kind, re) => {
		const v = await violations([{ [kind]: { create: { name: "x" } } }]);
		expect(v.join()).toMatch(re);
	});

	it("rechaza tipos de operación fuera de la allowlist", async () => {
		const v = await violations([{ keywordPlanOperation: { create: {} } }]);
		expect(v.join()).toMatch(/no está en la lista/);
	});

	it.each(["campaignOperation", "adGroupOperation", "adGroupAdOperation", "campaignBudgetOperation", "assetOperation"])("bloquea remove en %s", async (kind) => {
		const v = await violations([{ [kind]: { remove: `customers/${CID}/x/1` } }]);
		expect(v.join()).toMatch(/remove no permitido/);
	});

	it("permite remove en criterios", async () => {
		await expect(enforceGuards([{ campaignCriterionOperation: { remove: `customers/${CID}/campaignCriteria/1~2` } }], ctx())).resolves.toBeUndefined();
		await expect(enforceGuards([{ customerNegativeCriterionOperation: { remove: `customers/${CID}/customerNegativeCriteria/2` } }], ctx())).resolves.toBeUndefined();
	});

	it("bloquea status REMOVED vía update", async () => {
		const v = await violations([{ adGroupOperation: { update: { resourceName: `customers/${CID}/adGroups/1`, status: "REMOVED" }, updateMask: "status" } }]);
		expect(v.join()).toMatch(/REMOVED/);
	});

	it("campañas nuevas deben ir en PAUSED", async () => {
		const v = await violations([{ campaignOperation: { create: { name: "x", status: "ENABLED" } } }]);
		expect(v.join()).toMatch(/PAUSED/);
		const v2 = await violations([{ campaignOperation: { create: { name: "x" } } }]);
		expect(v2.join()).toMatch(/PAUSED/);
	});

	it("activar campañas solo con el flag de plan_update_campaign_status", async () => {
		const op = [{ campaignOperation: { update: { resourceName: `customers/${CID}/campaigns/1`, status: "ENABLED" }, updateMask: "status" } }];
		expect((await violations(op)).join()).toMatch(/plan_update_campaign_status/);
		expect(await violations(op, ctx({ allowCampaignEnable: true }))).toEqual([]);
	});

	it("bloquea asignar estrategias de puja de cartera", async () => {
		const v = await violations([{ campaignOperation: { update: { resourceName: `customers/${CID}/campaigns/1`, biddingStrategy: `customers/${CID}/biddingStrategies/9` }, updateMask: "bidding_strategy" } }]);
		expect(v.join()).toMatch(/cartera/);
	});

	it("presupuesto nuevo por encima de MAX_DAILY_BUDGET", async () => {
		const v = await violations([{ campaignBudgetOperation: { create: { name: "b", amountMicros: "61000000" } } }]);
		expect(v.join()).toMatch(/MAX_DAILY_BUDGET/);
		expect(await violations([{ campaignBudgetOperation: { create: { name: "b", amountMicros: "60000000" } } }])).toEqual([]);
	});

	it("subida mayor que MAX_BUDGET_INCREASE_PCT", async () => {
		const up = (micros: number) => [{ campaignBudgetOperation: { update: { resourceName: BRN, amountMicros: String(micros) }, updateMask: "amount_micros" } }];
		const c = ctx({ getBudget: budget(20_000_000) });
		expect((await violations(up(41_000_000), c)).join()).toMatch(/MAX_BUDGET_INCREASE_PCT/); // +105%
		expect(await violations(up(40_000_000), c)).toEqual([]); // +100% exacto
	});

	it("las bajadas siempre se permiten", async () => {
		const c = ctx({ getBudget: budget(25_000_000) });
		expect(await violations([{ campaignBudgetOperation: { update: { resourceName: BRN, amountMicros: "10000000" }, updateMask: "amount_micros" } }], c)).toEqual([]);
	});

	it("presupuesto compartido requiere flag explícito", async () => {
		const op = [{ campaignBudgetOperation: { update: { resourceName: BRN, amountMicros: "10000000" }, updateMask: "amount_micros" } }];
		expect((await violations(op, ctx({ getBudget: budget(25_000_000, true, 3) }))).join()).toMatch(/compartido/);
		expect(await violations(op, ctx({ getBudget: budget(25_000_000, true, 3), allowSharedBudget: true }))).toEqual([]);
	});

	it("si no puede leer el presupuesto actual, bloquea", async () => {
		const v = await violations([{ campaignBudgetOperation: { update: { resourceName: BRN, amountMicros: "1000000" }, updateMask: "amount_micros" } }], ctx({ getBudget: async () => undefined }));
		expect(v.join()).toMatch(/no se pudo leer/);
	});

	it("formato inválido", async () => {
		expect((await violations([{ a: {}, b: {} }])).join()).toMatch(/exactamente una clave/);
		expect((await violations([{ campaignOperation: { create: {}, update: {} } }])).join()).toMatch(/exactamente una acción/);
	});
});

describe("budgetReader", () => {
	it("no interpola resource names malformados en GAQL", async () => {
		const { budgetReader } = await import("../src/plans/engine");
		const { setup } = await import("./helpers");
		const { client, ads } = setup();
		expect(await budgetReader(client, CID)(`customers/${CID}/campaignBudgets/1' OR campaign_budget.id > '0`)).toBeUndefined();
		expect(ads.queries.filter((q) => q.includes("campaign_budget"))).toHaveLength(0);
	});
});
