import { describe, expect, it } from "vitest";
import { GoogleAdsApiError } from "../src/ads/client";
import { buildCampaignBudgetPlan, buildCampaignStatusPlan, buildGeoTargetingPlan, buildNegativeKeywordsPlan, parsePlacement } from "../src/plans/builders";
import { applyPlan, cancelPlan, createPlan, getAuditLog } from "../src/plans/engine";
import { buildGenericPlan } from "../src/plans/generic";
import { CID, adsError, setup } from "./helpers";

const CAMPAIGN = `customers/${CID}/campaigns/22714600993`;
const BUDGET = `customers/${CID}/campaignBudgets/555`;

function withBudget(ads: ReturnType<typeof setup>["ads"], state: { amount: number; shared?: boolean; refs?: number }) {
	ads.on(/FROM campaign WHERE campaign.id = 22714600993/, () => [
		{
			campaign: { id: "22714600993", name: "Neurored_EN_NATO_PMax_Leads" },
			campaignBudget: { resourceName: BUDGET, name: "b", amountMicros: String(state.amount), explicitlyShared: state.shared ?? false, referenceCount: String(state.refs ?? 1) },
		},
	]);
	ads.on(/FROM campaign_budget WHERE/, () => [
		{ campaignBudget: { resourceName: BUDGET, amountMicros: String(state.amount), explicitlyShared: state.shared ?? false, referenceCount: String(state.refs ?? 1) } },
	]);
}

describe("plan de presupuesto", () => {
	it("convierte a micros, resume ANTES → DESPUÉS y usa updateMask", async () => {
		const { ads, client } = setup();
		withBudget(ads, { amount: 25_000_000 });
		const d = await buildCampaignBudgetPlan(client, CID, "22714600993", 10);
		expect(d.operations).toEqual([{ campaignBudgetOperation: { update: { resourceName: BUDGET, amountMicros: "10000000" }, updateMask: "amount_micros" } }]);
		expect(d.summary.join("\n")).toContain("25.00 EUR → 10.00 EUR (-60.0%)");
	});

	it("presupuesto compartido: no crea plan sin el flag", async () => {
		const { ads, client } = setup();
		withBudget(ads, { amount: 25_000_000, shared: true, refs: 2 });
		await expect(buildCampaignBudgetPlan(client, CID, "22714600993", 10)).rejects.toThrow(/COMPARTIDO/);
		const d = await buildCampaignBudgetPlan(client, CID, "22714600993", 10, true);
		expect(d.guardFlags?.allowSharedBudget).toBe(true);
	});
});

describe("plan → apply", () => {
	it("crea plan con validateOnly y lo guarda en KV con TTL de 30 min", async () => {
		const { ads, client, deps, kv } = setup();
		withBudget(ads, { amount: 25_000_000 });
		const r = await createPlan(deps, await buildCampaignBudgetPlan(client, CID, "22714600993", 10));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(ads.mutateCalls).toHaveLength(1);
		expect(ads.mutateCalls[0].body.validateOnly).toBe(true);
		expect(ads.mutateCalls[0].body.partialFailure).toBe(false);
		expect(r.confirm_with).toBe(`APPLY ${r.plan_id}`);
		expect(await kv.get(`plan:${r.plan_id}`)).toBeTruthy();
		expect(ads.lastHeaders?.["login-customer-id"]).toBe("2567236642");
		expect(ads.lastHeaders?.["developer-token"]).toBe("dev");
	});

	it("sin developer token no envía la cabecera (retirado por Google en 09-2026)", async () => {
		const { ads } = setup();
		const { GoogleAdsClient } = await import("../src/ads/client");
		const { ENV } = await import("./helpers");
		const { GOOGLE_ADS_DEVELOPER_TOKEN: _d, ...noDev } = ENV;
		await new GoogleAdsClient(noDev, ads.fetch).search(CID, "SELECT customer.currency_code FROM customer");
		expect(ads.lastHeaders && "developer-token" in ads.lastHeaders).toBe(false);
		expect(ads.lastHeaders?.["login-customer-id"]).toBe("2567236642");
	});

	it("presupuesto por encima del límite: plan válido pero con confirmación reforzada", async () => {
		const { ads, client, deps } = setup();
		withBudget(ads, { amount: 25_000_000 });
		const r = await createPlan(deps, await buildCampaignBudgetPlan(client, CID, "22714600993", 61));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.elevated.join()).toMatch(/MAX_DAILY_BUDGET/);
		expect(r.confirm_with).toBe(`APPLY-ELEVATED ${r.plan_id}`);
		// "APPLY" normal no basta y no ejecuta nada
		const a1 = await applyPlan(deps, r.plan_id, `APPLY ${r.plan_id}`);
		expect(a1.ok).toBe(false);
		expect(a1.message).toMatch(/APPLY-ELEVATED/);
		expect(ads.mutateCalls.filter((c) => !c.body.validateOnly)).toHaveLength(0);
		const a2 = await applyPlan(deps, r.plan_id, `APPLY-ELEVATED ${r.plan_id}`);
		expect(a2.ok).toBe(true);
	});

	it("errores de validación completos: código, campo, mensaje y request-id", async () => {
		const { ads, client, deps } = setup();
		withBudget(ads, { amount: 25_000_000 });
		ads.mutateError = adsError({ campaignBudgetError: "NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT" }, "Budget amount bad", "amount_micros");
		const r = await createPlan(deps, await buildCampaignBudgetPlan(client, CID, "22714600993", 10));
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.stage).toBe("validation");
		expect(r.message).toContain("campaignBudgetError.NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT");
		expect(r.message).toContain("request-id: REQ-123");
		expect(r.message).toContain("campo: amount_micros");
		expect(r.message).toContain("operación #1");
	});

	it("apply exige la confirmación literal", async () => {
		const { ads, client, deps } = setup();
		withBudget(ads, { amount: 25_000_000 });
		const r = await createPlan(deps, await buildCampaignBudgetPlan(client, CID, "22714600993", 10));
		if (!r.ok) throw new Error("plan");
		const a = await applyPlan(deps, r.plan_id, "APPLY");
		expect(a.ok).toBe(false);
		expect(ads.mutateCalls).toHaveLength(1);
	});

	it("apply ejecuta exactamente las operaciones guardadas y audita", async () => {
		const { ads, client, deps, kv } = setup();
		withBudget(ads, { amount: 25_000_000 });
		const r = await createPlan(deps, await buildCampaignBudgetPlan(client, CID, "22714600993", 10));
		if (!r.ok) throw new Error("plan");
		ads.mutateResponse = { mutateOperationResponses: [{ campaignBudgetResult: { resourceName: BUDGET } }] };
		const a = await applyPlan(deps, r.plan_id, `APPLY ${r.plan_id}`);
		expect(a.ok).toBe(true);
		expect(ads.mutateCalls).toHaveLength(2);
		expect(ads.mutateCalls[1].body.validateOnly).toBe(false);
		expect(ads.mutateCalls[1].body.mutateOperations).toEqual(ads.mutateCalls[0].body.mutateOperations);
		const log = await getAuditLog(kv as unknown as KVNamespace, 10);
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ outcome: "APPLIED", user_email: "ivan@mycontent.agency", customer_id: CID, resource_names: [BUDGET] });
		expect(log[0].operations).toEqual(ads.mutateCalls[1].body.mutateOperations);
		// El plan es de un solo uso.
		expect((await applyPlan(deps, r.plan_id, `APPLY ${r.plan_id}`)).ok).toBe(false);
	});

	it("aborta si el estado cambió entre plan y apply", async () => {
		const { ads, client, deps, kv } = setup();
		const state = { amount: 25_000_000 };
		withBudget(ads, state);
		const r = await createPlan(deps, await buildCampaignBudgetPlan(client, CID, "22714600993", 10));
		if (!r.ok) throw new Error("plan");
		state.amount = 30_000_000; // alguien cambió el presupuesto desde la UI
		const a = await applyPlan(deps, r.plan_id, `APPLY ${r.plan_id}`);
		expect(a.ok).toBe(false);
		expect(a.message).toMatch(/ha cambiado/);
		expect(ads.mutateCalls).toHaveLength(1); // solo el validateOnly
		expect((await getAuditLog(kv as unknown as KVNamespace, 10))[0].outcome).toBe("ABORTED_STATE_CHANGED");
	});

	it("los planes caducan a los 30 minutos", async () => {
		const { ads, client, deps, clock } = setup();
		withBudget(ads, { amount: 25_000_000 });
		const r = await createPlan(deps, await buildCampaignBudgetPlan(client, CID, "22714600993", 10));
		if (!r.ok) throw new Error("plan");
		clock.advance(29 * 60_000);
		expect((await cancelPlan(deps, "p_nope")).ok).toBe(false);
		clock.advance(2 * 60_000);
		const a = await applyPlan(deps, r.plan_id, `APPLY ${r.plan_id}`);
		expect(a.ok).toBe(false);
		expect(a.message).toMatch(/caducado/);
		expect(ads.mutateCalls).toHaveLength(1);
	});

	it("apply fallido queda auditado con el error de la API", async () => {
		const { ads, client, deps, kv } = setup();
		withBudget(ads, { amount: 25_000_000 });
		const r = await createPlan(deps, await buildCampaignBudgetPlan(client, CID, "22714600993", 10));
		if (!r.ok) throw new Error("plan");
		ads.mutateError = adsError({ internalError: "TRANSIENT_ERROR" }, "try again");
		const a = await applyPlan(deps, r.plan_id, `APPLY ${r.plan_id}`);
		expect(a.ok).toBe(false);
		const log = await getAuditLog(kv as unknown as KVNamespace, 10);
		expect(log[0].outcome).toBe("FAILED");
		expect(JSON.stringify(log[0].error)).toContain("REQ-123");
	});
});

describe("estado de campaña", () => {
	it("pausar no requiere flag; activar sí y lo marca", async () => {
		const { ads, client } = setup();
		ads.on(/FROM campaign WHERE campaign.id = 1\b/, [{ campaign: { resourceName: `customers/${CID}/campaigns/1`, id: "1", name: "C", status: "PAUSED", advertisingChannelType: "SEARCH" } }]);
		const d = await buildCampaignStatusPlan(client, CID, "1", "ENABLED");
		expect(d.guardFlags?.allowCampaignEnable).toBe(true);
		expect(d.summary[0]).toContain("PAUSED → ENABLED");
		await expect(buildCampaignStatusPlan(client, CID, "1", "PAUSED")).rejects.toThrow(/ya está/);
	});
});

describe("geo", () => {
	it("resuelve países por API, sustituye inclusión por exclusión y cambia a PRESENCE", async () => {
		const { ads, client } = setup();
		ads.on(/FROM campaign WHERE campaign.id = 7/, [
			{ campaign: { resourceName: `customers/${CID}/campaigns/7`, id: "7", name: "PMax", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX", geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE_OR_INTEREST" } } },
		]);
		ads.on(/FROM geo_target_constant/, [
			{ geoTargetConstant: { resourceName: "geoTargetConstants/2356", countryCode: "IN", name: "India" } },
			{ geoTargetConstant: { resourceName: "geoTargetConstants/2586", countryCode: "PK", name: "Pakistan" } },
		]);
		ads.on(/FROM campaign_criterion/, [{ campaignCriterion: { resourceName: `customers/${CID}/campaignCriteria/7~2356`, negative: false, location: { geoTargetConstant: "geoTargetConstants/2356" } } }]);
		const d = await buildGeoTargetingPlan(client, CID, "7", { exclude_country_codes: ["in", "PK"], geo_target_type: "PRESENCE" });
		expect(ads.queries.some((q) => q.includes("geo_target_constant.country_code IN ('IN', 'PK')"))).toBe(true);
		expect(d.operations[0]).toEqual({ campaignCriterionOperation: { remove: `customers/${CID}/campaignCriteria/7~2356` } });
		expect(d.operations.filter((o) => o.campaignCriterionOperation?.create?.negative === true)).toHaveLength(2);
		expect(d.operations.at(-1)).toEqual({
			campaignOperation: {
				update: { resourceName: `customers/${CID}/campaigns/7`, geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" } },
				updateMask: "geo_target_type_setting.positive_geo_target_type",
			},
		});
	});

	it("falla si la API no conoce un país", async () => {
		const { ads, client } = setup();
		ads.on(/FROM campaign WHERE campaign.id = 7/, [{ campaign: { resourceName: `customers/${CID}/campaigns/7`, id: "7", name: "x", status: "ENABLED", advertisingChannelType: "SEARCH" } }]);
		ads.on(/FROM geo_target_constant/, []);
		await expect(buildGeoTargetingPlan(client, CID, "7", { exclude_country_codes: ["ZZ"] })).rejects.toThrow(/ZZ/);
	});

	it("Demand Gen con upgraded targeting: rechaza países de campaña con un mensaje claro", async () => {
		const { ads, client } = setup();
		ads.on(/FROM campaign WHERE campaign.id = 9/, [{ campaign: { resourceName: `customers/${CID}/campaigns/9`, id: "9", name: "DG", status: "PAUSED", advertisingChannelType: "DEMAND_GEN" } }]);
		ads.on(/upgraded_targeting FROM campaign/, [{ campaign: { demandGenCampaignSettings: { upgradedTargeting: true } } }]);
		ads.on(/FROM geo_target_constant/, [{ geoTargetConstant: { resourceName: "geoTargetConstants/2352", countryCode: "IS", name: "Iceland" } }]);
		await expect(buildGeoTargetingPlan(client, CID, "9", { exclude_country_codes: ["IS"] })).rejects.toThrow(/grupo de anuncios/);
	});
});

describe("keywords negativas y placements", () => {
	it("omite negativas existentes", async () => {
		const { ads, client } = setup();
		ads.on(/FROM campaign WHERE campaign.id = 7/, [{ campaign: { resourceName: `customers/${CID}/campaigns/7`, id: "7", name: "x", status: "ENABLED", advertisingChannelType: "SEARCH" } }]);
		ads.on(/FROM campaign_criterion/, [{ campaignCriterion: { keyword: { text: "Gratis", matchType: "PHRASE" } } }]);
		const d = await buildNegativeKeywordsPlan(client, CID, "7", ["gratis", "curso"], "PHRASE");
		expect(d.operations).toHaveLength(1);
		expect(d.operations[0].campaignCriterionOperation.create.keyword).toEqual({ text: "curso", matchType: "PHRASE" });
	});

	it("reconoce dominios, canales y vídeos de YouTube", () => {
		expect(parsePlacement("https://example.com/")).toEqual({ placement: { url: "example.com" } });
		expect(parsePlacement("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv")).toEqual({ youtubeChannel: { channelId: "UCabcdefghijklmnopqrstuv" } });
		expect(parsePlacement("https://youtu.be/abcdefghijk")).toEqual({ youtubeVideo: { videoId: "abcdefghijk" } });
		expect(() => parsePlacement("not a placement")).toThrow();
	});
});

describe("mutate genérico", () => {
	it("borrar una campaña es posible pero exige APPLY-ELEVATED", async () => {
		const { ads, client, deps } = setup();
		ads.on(/FROM campaign WHERE campaign.resource_name/, [{ campaign: { resourceName: CAMPAIGN, status: "ENABLED" } }]);
		const r = await createPlan(deps, await buildGenericPlan(client, CID, JSON.stringify([{ campaignOperation: { remove: CAMPAIGN } }])));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.elevated.join()).toMatch(/BORRADO/);
		expect(r.confirm_with).toBe(`APPLY-ELEVATED ${r.plan_id}`);
	});

	it("acciones de conversión por el genérico: posibles con APPLY-ELEVATED", async () => {
		const { client, deps } = setup();
		const r = await createPlan(deps, await buildGenericPlan(client, CID, [{ conversionActionOperation: { create: { name: "x" } } }]));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.elevated.join()).toMatch(/acciones de conversión/);
	});

	it("cuenta fuera de la lista permitida: bloqueo duro, nunca llega a la API", async () => {
		const { ads, deps } = setup();
		const r = await createPlan(deps, {
			kind: "x",
			customerId: "1111111111",
			summary: [],
			operations: [{ campaignOperation: { update: { resourceName: "customers/1111111111/campaigns/1", status: "PAUSED" }, updateMask: "status" } }],
			stateQueries: [],
		});
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.stage).toBe("guards");
		expect(ads.mutateCalls).toHaveLength(0);
	});

	it("resume ANTES → DESPUÉS con los campos del updateMask", async () => {
		const { ads, client, deps } = setup();
		const AG = `customers/${CID}/adGroups/42`;
		ads.on(/FROM ad_group WHERE ad_group.resource_name/, [{ adGroup: { resourceName: AG, status: "ENABLED" } }]);
		const d = await buildGenericPlan(client, CID, [{ adGroupOperation: { update: { resourceName: AG, status: "PAUSED" }, updateMask: "status" } }]);
		expect(d.summary[0]).toContain('status: "ENABLED" → "PAUSED"');
		const r = await createPlan(deps, d);
		expect(r.ok).toBe(true);
	});

	it("rechaza JSON inválido", async () => {
		const { client } = setup();
		await expect(buildGenericPlan(client, CID, "{nope")).rejects.toThrow(/JSON/);
	});
});

describe("cliente", () => {
	it("pagina los resultados y respeta max_rows", async () => {
		const { client } = setup();
		let page = 0;
		const fetchPaged = async (url: string, init?: RequestInit) => {
			if (url.includes("oauth2")) return Response.json({ access_token: "t", expires_in: 3600 });
			page++;
			const body = JSON.parse(String(init?.body));
			if (!body.pageToken) return Response.json({ results: [{ a: 1 }, { a: 2 }], nextPageToken: "p2" });
			return Response.json({ results: [{ a: 3 }] });
		};
		const c = new (client.constructor as any)({ ...client["env"] }, fetchPaged);
		expect((await c.search(CID, "SELECT x FROM y")).rows).toHaveLength(3);
		page = 0;
		const r = await c.search(CID, "SELECT x FROM y", 2);
		expect(r).toMatchObject({ truncated: true });
		expect(r.rows).toHaveLength(2);
	});

	it("convierte el error REST en GoogleAdsApiError legible", async () => {
		const { ads, client } = setup();
		ads.mutateError = adsError({ fieldError: "REQUIRED" }, "The required field was not present.", "name");
		await expect(client.mutate(CID, [{}], true)).rejects.toBeInstanceOf(GoogleAdsApiError);
		try {
			await client.mutate(CID, [{}], true);
		} catch (e) {
			const j = (e as GoogleAdsApiError).toJSON();
			expect(j).toMatchObject({ httpStatus: 400, requestId: "REQ-123", errors: [{ errorCode: "fieldError.REQUIRED", field: "name", operationIndex: 1 }] });
		}
	});

	it("cachea el access token", async () => {
		const { ads, client } = setup();
		await client.search(CID, "SELECT customer.currency_code FROM customer");
		await client.search(CID, "SELECT customer.currency_code FROM customer");
		expect(ads.tokenCalls).toBe(1);
	});
});
