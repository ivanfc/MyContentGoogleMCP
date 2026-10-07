import { describe, expect, it } from "vitest";
import { GoogleAdsClient } from "../src/ads/client";
import { userLimits } from "../src/config";
import { applyPlan, cancelPlan, createPlan, getAuditLog, listPendingPlans, loadPlan } from "../src/plans/engine";
import { buildCampaignBudgetPlan } from "../src/plans/builders";
import { decide } from "../src/quota-policy";
import { _resetChildCache, assertReadable, listAccessibleCustomers } from "../src/tools/read";
import { CID, ENV, FakeAds, setup } from "./helpers";

const CFG = { total: 100, others: 30, perUser: 10 };

describe("cuota diaria compartida", () => {
	it("el propietario solo está limitado por el total", () => {
		const d = decide(undefined, "2026-10-07", "ivan", true, 90, CFG);
		expect(d.ok).toBe(true);
		expect(d.state).toMatchObject({ total: 90, others: 0 });
		expect(decide(d.state, "2026-10-07", "ivan", true, 11, CFG).ok).toBe(false);
	});

	it("cada invitado tiene su tope y entre todos no pasan de 'others'", () => {
		let s = decide(undefined, "2026-10-07", "a", false, 10, CFG).state;
		const over = decide(s, "2026-10-07", "a", false, 1, CFG);
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.reason).toMatch(/tu cuota diaria/);
		s = decide(s, "2026-10-07", "b", false, 10, CFG).state;
		s = decide(s, "2026-10-07", "c", false, 10, CFG).state;
		const d = decide(s, "2026-10-07", "d", false, 1, CFG);
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.reason).toMatch(/invitados agotada/);
		// El propietario conserva lo reservado.
		expect(decide(s, "2026-10-07", "ivan", true, 70, CFG).ok).toBe(true);
	});

	it("un día nuevo empieza de cero", () => {
		const s = decide(undefined, "2026-10-07", "a", false, 10, CFG).state;
		expect(decide(s, "2026-10-08", "a", false, 10, CFG).ok).toBe(true);
	});

	it("el cliente pasa por la cuota antes de cada petición y no llama a la API si se rechaza", async () => {
		const ads = new FakeAds();
		const client = new GoogleAdsClient(ENV, ads.fetch);
		const seen: number[] = [];
		client.beforeRequest = async (n) => {
			seen.push(n);
			throw new Error("Has agotado tu cuota diaria");
		};
		await expect(client.searchAll(CID, "SELECT customer.id FROM customer")).rejects.toThrow(/cuota/);
		expect(seen).toEqual([1]);
		expect(ads.queries).toHaveLength(0);
	});
});

describe("modo usuario: solo sus cuentas", () => {
	it("descubre cuentas directas y las de sus MCC, con login-customer-id por cuenta", async () => {
		_resetChildCache();
		const ads = new FakeAds();
		const headers: { url: string; login?: string }[] = [];
		const fetch = async (url: string, init?: RequestInit) => {
			if (url.endsWith("customers:listAccessibleCustomers")) return Response.json({ resourceNames: ["customers/1111111111", "customers/2222222222"] });
			if (url.includes("googleAds:search")) headers.push({ url, login: (init?.headers as Record<string, string>)["login-customer-id"] });
			return ads.fetch(url, init);
		};
		const client = new GoogleAdsClient({ ...ENV, GOOGLE_ADS_REFRESH_TOKEN: "rt-amigo", GOOGLE_ADS_LOGIN_CUSTOMER_ID: undefined } as any, fetch);
		// 1111111111 es una MCC con la cuenta 3333333333 debajo; 2222222222 es una cuenta con acceso directo.
		let current = "";
		ads.on(/FROM customer_client/, () =>
			current === "1111111111"
				? [
						{ customerClient: { id: "1111111111", descriptiveName: "MCC", manager: true, level: 0 } },
						{ customerClient: { id: "3333333333", descriptiveName: "Hija", manager: false, level: 1 } },
					]
				: [{ customerClient: { id: "2222222222", descriptiveName: "Directa", manager: false, level: 0 } }],
		);
		const orig = ads.fetch;
		ads.fetch = async (url: string, init?: RequestInit) => {
			current = url.match(/customers\/(\d+)\//)?.[1] ?? "";
			return orig(url, init);
		};
		const limits = userLimits({ ...ENV } as any, "amigo@gmail.com");
		const list = await listAccessibleCustomers(client, limits);
		expect(list.map((a) => a.customer_id).sort()).toEqual(["1111111111", "2222222222", "3333333333"]);
		expect(list.find((a) => a.customer_id === "3333333333")?.via_manager).toBe("1111111111");

		await expect(assertReadable(client, limits, CID)).rejects.toThrow(/no tiene acceso a la cuenta/);
		await expect(assertReadable(client, limits, "3333333333")).resolves.toBe("3333333333");
		headers.length = 0;
		await client.searchAll("3333333333", "SELECT customer.id FROM customer");
		expect(headers[0].login).toBe("1111111111");
		headers.length = 0;
		await client.searchAll("2222222222", "SELECT customer.id FROM customer");
		expect(headers[0].login).toBe("2222222222");
	});

	it("la caché de cuentas es por usuario: otro usuario no hereda las cuentas del anterior", async () => {
		_resetChildCache();
		const mk = (names: string[]) => {
			const ads = new FakeAds();
			ads.on(/FROM customer_client/, []);
			const fetch = async (url: string, init?: RequestInit) =>
				url.endsWith("customers:listAccessibleCustomers") ? Response.json({ resourceNames: names }) : ads.fetch(url, init);
			return new GoogleAdsClient({ ...ENV, GOOGLE_ADS_LOGIN_CUSTOMER_ID: undefined } as any, fetch);
		};
		const a = mk(["customers/1111111111"]);
		const b = mk([]);
		// Sin filas de customer_client no hay cuentas: tampoco para A, pero lo importante es que B no lee la caché de A.
		await listAccessibleCustomers(a, userLimits(ENV as any, "a@x.com"));
		await expect(assertReadable(b, userLimits(ENV as any, "b@x.com"), "1111111111")).rejects.toThrow(/no tiene acceso/);
	});
});

describe("planes y auditoría aislados por usuario", () => {
	async function planAs() {
		const ctx = setup();
		const BUDGET = `customers/${CID}/campaignBudgets/1`;
		ctx.ads.on(/FROM campaign WHERE campaign.id = 22714600993/, () => [
			{ campaign: { id: "22714600993", name: "C", campaignBudget: BUDGET }, campaignBudget: { resourceName: BUDGET, name: "b", amountMicros: "25000000", explicitlyShared: false, referenceCount: "1" } },
		]);
		ctx.ads.on(/FROM campaign_budget WHERE/, () => [{ campaignBudget: { resourceName: BUDGET, amountMicros: "25000000", explicitlyShared: false, referenceCount: "1" } }]);
		const r = await createPlan(ctx.deps, await buildCampaignBudgetPlan(ctx.client, CID, "22714600993", 10));
		if (!r.ok) throw new Error(JSON.stringify(r));
		return { ...ctx, planId: r.plan_id };
	}

	it("otro usuario no ve, no aplica y no cancela un plan ajeno", async () => {
		const { deps, ads, planId } = await planAs();
		const other = { ...deps, userEmail: "amigo@gmail.com" };
		expect(await loadPlan(other, planId)).toBeUndefined();
		expect(await listPendingPlans(other)).toEqual([]);
		expect((await applyPlan(other, planId, `APPLY ${planId}`)).ok).toBe(false);
		expect((await cancelPlan(other, planId)).ok).toBe(false);
		expect(ads.mutateCalls.filter((c) => !c.body.validateOnly)).toHaveLength(0);
		expect((await listPendingPlans(deps)).map((p) => p.plan_id)).toEqual([planId]);
	});

	it("la auditoría de cada usuario es suya; el propietario ve también el registro antiguo", async () => {
		const { deps, kv, ads, planId } = await planAs();
		ads.mutateResponse = { mutateOperationResponses: [{ campaignBudgetResult: { resourceName: `customers/${CID}/campaignBudgets/1` } }] };
		expect((await applyPlan(deps, planId, `APPLY ${planId}`)).ok).toBe(true);
		await kv.put("audit:9999999999999:legacy", JSON.stringify({ plan_id: "legacy", user_email: "ivan@mycontent.agency" }));
		const k = kv as unknown as KVNamespace;
		expect(await getAuditLog(k, 10, "amigo@gmail.com")).toEqual([]);
		expect((await getAuditLog(k, 10, deps.userEmail)).map((r) => r.plan_id)).toEqual([planId]);
		expect((await getAuditLog(k, 10, deps.userEmail, true)).map((r) => r.plan_id)).toEqual([planId, "legacy"]);
	});
});
