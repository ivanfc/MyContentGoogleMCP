import { describe, expect, it } from "vitest";
import { getLimits, isWriteAllowed, normalizeCustomerId, toMicros } from "../src/config";
import { GuardError, enforceGuards } from "../src/guards";
import { CID, ENV } from "./helpers";

const limits = getLimits(ENV);
const budget = (amountMicros: number, shared = false, refs = 1) => async () => ({ amountMicros, explicitlyShared: shared, referenceCount: refs });
const ctx = (over: Partial<Parameters<typeof enforceGuards>[1]> = {}) => ({ customerId: CID, limits, getBudget: budget(25_000_000), ...over });
const BRN = `customers/${CID}/campaignBudgets/1`;

/** Bloqueos duros (GuardError). */
async function hard(ops: any[], c = ctx()): Promise<string[]> {
	try {
		await enforceGuards(ops, c);
		return [];
	} catch (e) {
		if (e instanceof GuardError) return e.violations;
		throw e;
	}
}

/** Motivos de confirmación reforzada (APPLY-ELEVATED). Falla si hay bloqueo duro. */
async function violations(ops: any[], c = ctx()): Promise<string[]> {
	return (await enforceGuards(ops, c)).elevated;
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
		const v = await hard([{ campaignOperation: { update: { resourceName: "customers/1111111111/campaigns/1", status: "PAUSED" }, updateMask: "status" } }], ctx({ customerId: "1111111111" }));
		expect(v[0]).toMatch(/ALLOWED_CUSTOMER_IDS/);
	});

	it("rechaza resource names de otra cuenta dentro de una cuenta permitida (bloqueo duro)", async () => {
		const v = await hard([{ campaignOperation: { update: { resourceName: "customers/1111111111/campaigns/1", status: "PAUSED" }, updateMask: "status" } }]);
		expect(v.join()).toMatch(/otra cuenta/);
	});

	it.each([
		["conversionActionOperation", /acciones de conversión/],
		["biddingStrategyOperation", /cartera/],
		["customerOperation", /configuración de la cuenta/],
		["customerConversionGoalOperation", /conversión/],
	])("%s exige confirmación reforzada", async (kind, re) => {
		const v = await violations([{ [kind]: { create: { name: "x" } } }]);
		expect(v.join()).toMatch(re);
	});

	it("configuración de la propia cuenta (customers/<id> sin sufijo): reforzada, no bloqueada", async () => {
		const v = await violations([{ customerOperation: { update: { resourceName: `customers/${CID}`, autoTaggingEnabled: true }, updateMask: "auto_tagging_enabled" } }]);
		expect(v.join()).toMatch(/configuración de la cuenta/);
		expect(await hard([{ customerOperation: { update: { resourceName: "customers/1111111111", autoTaggingEnabled: true }, updateMask: "auto_tagging_enabled" } }])).not.toEqual([]);
	});

	it("cualquier tipo de operación de la API es posible; las no sensibles no exigen refuerzo", async () => {
		expect(await violations([{ keywordPlanOperation: { create: {} } }])).toEqual([]);
		expect(await violations([{ assetSetOperation: { create: { name: "x" } } }])).toEqual([]);
	});

	it.each(["campaignOperation", "adGroupOperation", "adGroupAdOperation", "campaignBudgetOperation", "assetGroupOperation", "sharedSetOperation", "userListOperation"])(
		"remove en %s exige confirmación reforzada (borrado)",
		async (kind) => {
			const v = await violations([{ [kind]: { remove: `customers/${CID}/x/1` } }]);
			expect(v.join()).toMatch(/BORRADO/);
		},
	);

	it.each(["campaignCriterionOperation", "customerNegativeCriterionOperation", "assetGroupSignalOperation", "assetGroupAssetOperation", "campaignAssetOperation", "campaignSharedSetOperation", "campaignBidModifierOperation", "campaignLabelOperation"])(
		"remove en %s (criterios, vínculos, señales, ajustes) es confirmación normal",
		async (kind) => {
			expect(await violations([{ [kind]: { remove: `customers/${CID}/x/1~2` } }])).toEqual([]);
		},
	);

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

	it("activar campañas por el genérico exige refuerzo; con plan_update_campaign_status no", async () => {
		const op = [{ campaignOperation: { update: { resourceName: `customers/${CID}/campaigns/1`, status: "ENABLED" }, updateMask: "status" } }];
		expect((await violations(op)).join()).toMatch(/ACTIVA una campaña/);
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

	it("formato inválido (bloqueo duro)", async () => {
		expect((await hard([{ a: {}, b: {} }])).join()).toMatch(/exactamente una clave/);
		expect((await hard([{ campaignOperation: { create: {}, update: {} } }])).join()).toMatch(/exactamente una acción/);
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

describe('ALLOWED_CUSTOMER_IDS="*" (todas las cuentas de la MCC)', () => {
	const wild = getLimits({ ...ENV, ALLOWED_CUSTOMER_IDS: "*" });
	it("activa allowAllUnderMcc y permite cualquier cuenta en la configuración", () => {
		expect(wild.allowAllUnderMcc).toBe(true);
		expect(wild.allowedCustomerIds.size).toBe(0);
		expect(isWriteAllowed(wild, "1234567890")).toBe(true);
		expect(isWriteAllowed(limits, "1234567890")).toBe(false);
	});
	it("combina comodín y lista explícita", () => {
		const mixed = getLimits({ ...ENV, ALLOWED_CUSTOMER_IDS: "*, 846-051-4008" });
		expect(mixed.allowAllUnderMcc).toBe(true);
		expect(mixed.allowedCustomerIds.has("8460514008")).toBe(true);
	});
	it("las guardas aceptan otra cuenta con comodín, pero siguen bloqueando referencias cruzadas", async () => {
		const other = "1234567890";
		const ok = await enforceGuards(
			[{ campaignOperation: { update: { resourceName: `customers/${other}/campaigns/1`, status: "PAUSED" }, updateMask: "status" } }],
			{ customerId: other, limits: wild, getBudget: budget(1) },
		);
		expect(ok.elevated).toEqual([]);
		const v = await hard(
			[{ campaignOperation: { update: { resourceName: `customers/${CID}/campaigns/1`, status: "PAUSED" }, updateMask: "status" } }],
			{ customerId: other, limits: wild, getBudget: budget(1) },
		);
		expect(v.join(" ")).toMatch(/otra cuenta/);
	});
});

describe("assertReadable con comodín", () => {
	it("rechaza cuentas que no cuelgan de la MCC", async () => {
		const { assertReadable, _resetChildCache } = await import("../src/tools/read");
		_resetChildCache();
		const client = { setLogins: () => {}, searchAll: async () => [{ customerClient: { id: "8460514008", descriptiveName: "N", manager: false, status: "ENABLED", level: 1 } }] } as any;
		const wild = getLimits({ ...ENV, ALLOWED_CUSTOMER_IDS: "*" });
		await expect(assertReadable(client, wild, "8460514008")).resolves.toBe("8460514008");
		await expect(assertReadable(client, wild, "9999999999")).rejects.toThrow(/no cuelga de la MCC/);
	});
});
