import { describe, expect, it } from "vitest";
import { type DemandGenInput, buildDemandGenPlan } from "../src/plans/demandgen";
import { createPlan } from "../src/plans/engine";
import { isEmailAllowed } from "../src/auth/google-handler";
import { CID, setup } from "./helpers";

const A = (id: string) => `customers/${CID}/assets/${id}`;

function seed(ads: ReturnType<typeof setup>["ads"]) {
	ads.on(/FROM customer_conversion_goal/, [
		{ customerConversionGoal: { category: "SUBMIT_LEAD_FORM", origin: "WEBSITE", biddable: true } },
		{ customerConversionGoal: { category: "ENGAGEMENT", origin: "YOUTUBE_HOSTED", biddable: true } },
		{ customerConversionGoal: { category: "CONTACT", origin: "WEBSITE", biddable: false } },
	]);
	ads.on(/FROM geo_target_constant/, (() => {
		const all = [
			{ geoTargetConstant: { resourceName: "geoTargetConstants/2784", countryCode: "AE", name: "United Arab Emirates" } },
			{ geoTargetConstant: { resourceName: "geoTargetConstants/2702", countryCode: "SG", name: "Singapore" } },
		];
		return () => all;
	})());
	ads.on(/FROM language_constant/, [{ languageConstant: { resourceName: "languageConstants/1000", code: "en", name: "English" } }]);
	ads.on(/FROM campaign WHERE campaign.id = 24049877221/, [{ campaign: { id: "24049877221", name: "Neurored_EN_NATO_PMax_Freight_Forwarding_Software", advertisingChannelType: "PERFORMANCE_MAX" } }]);
	ads.on(/FROM asset_group_asset/, [
		{ assetGroupAsset: { fieldType: "HEADLINE" }, asset: { resourceName: A("1"), type: "TEXT", textAsset: { text: "Freight Forwarding Software" } } },
		{ assetGroupAsset: { fieldType: "HEADLINE" }, asset: { resourceName: A("2"), type: "TEXT", textAsset: { text: "Freight Forwarding CRM" } } },
		{ assetGroupAsset: { fieldType: "DESCRIPTION" }, asset: { resourceName: A("3"), type: "TEXT", textAsset: { text: "Manage rates, quotes, bookings, billing, and tracking from one platform." } } },
		{ assetGroupAsset: { fieldType: "MARKETING_IMAGE" }, asset: { resourceName: A("10"), type: "IMAGE", imageAsset: { fullSize: { widthPixels: 1200, heightPixels: 628 } } } },
		{ assetGroupAsset: { fieldType: "SQUARE_MARKETING_IMAGE" }, asset: { resourceName: A("11"), type: "IMAGE" } },
		{ assetGroupAsset: { fieldType: "PORTRAIT_MARKETING_IMAGE" }, asset: { resourceName: A("12"), type: "IMAGE" } },
	]);
	ads.on(/FROM campaign_asset/, [
		{ campaignAsset: { fieldType: "LOGO" }, asset: { resourceName: A("20"), type: "IMAGE" } },
		{ campaignAsset: { fieldType: "BUSINESS_NAME" }, asset: { resourceName: A("21"), type: "TEXT", textAsset: { text: "Neurored" } } },
	]);
}

const INPUT: DemandGenInput = {
	name: "TEST_MCP_DemandGen_Discover",
	daily_budget: 25,
	bidding_strategy: "MAXIMIZE_CONVERSIONS",
	country_codes: ["AE", "SG"],
	geo_target_type: "PRESENCE",
	language_codes: ["en"],
	channels: ["DISCOVER", "GMAIL"],
	reuse_assets_from_campaign_id: "24049877221",
	new_custom_audiences: [{ key: "ff", name: "TEST_MCP FF searchers", search_terms: ["freight forwarding software", "freight forwarder crm", "tms for freight forwarders", "logistics software salesforce"] }],
	ad_groups: [
		{ name: "UAE", country_codes: ["AE"], custom_audience_keys: ["ff"], ads: [{ final_url: "https://www.neurored.com/", call_to_action: "Sign up" }] },
		{ name: "SG", country_codes: ["SG"], custom_audience_keys: ["ff"], ads: [{ final_url: "https://www.neurored.com/" }] },
	],
};

const ofKind = (ops: any[], k: string) => ops.filter((o) => o[k]).map((o) => o[k]);

describe("plan Demand Gen", () => {
	it("construye todo en un mutate con IDs temporales negativos y campaña en PAUSED", async () => {
		const { ads, client } = setup();
		seed(ads);
		const d = await buildDemandGenPlan(client, CID, INPUT, "CUSTOM_AUDIENCE_CRITERION");
		const ops = d.operations;
		const [budget] = ofKind(ops, "campaignBudgetOperation");
		expect(budget.create.amountMicros).toBe("25000000");
		expect(budget.create.resourceName).toMatch(/campaignBudgets\/-\d+$/);
		const [camp] = ofKind(ops, "campaignOperation");
		expect(camp.create).toMatchObject({
			status: "PAUSED",
			advertisingChannelType: "DEMAND_GEN",
			campaignBudget: budget.create.resourceName,
			maximizeConversions: {},
			geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" },
			demandGenCampaignSettings: { upgradedTargeting: true },
		});
		const ags = ofKind(ops, "adGroupOperation");
		expect(ags).toHaveLength(2);
		for (const ag of ags) {
			expect(ag.create.campaign).toBe(camp.create.resourceName);
			expect(ag.create.demandGenAdGroupSettings.channelControls.selectedChannels).toEqual({
				discover: true,
				gmail: true,
				display: false,
				youtubeInFeed: false,
				youtubeInStream: false,
				youtubeShorts: false,
				maps: false,
			});
		}
		// Geo distinta por grupo, a nivel de grupo de anuncios
		const crits = ofKind(ops, "adGroupCriterionOperation").map((c) => c.create);
		expect(crits.filter((c) => c.adGroup === ags[0].create.resourceName && c.location).map((c) => c.location.geoTargetConstant)).toEqual(["geoTargetConstants/2784"]);
		expect(crits.filter((c) => c.adGroup === ags[1].create.resourceName && c.location).map((c) => c.location.geoTargetConstant)).toEqual(["geoTargetConstants/2702"]);
		expect(crits.filter((c) => c.language)).toHaveLength(2);
		// Custom audience nueva (SEARCH): paso previo en CustomAudienceService, referenciada por placeholder
		expect(ofKind(ops, "customAudienceOperation")).toHaveLength(0);
		const [pre] = d.preSteps!;
		expect(pre.service).toBe("customAudiences");
		expect(pre.operation.create.type).toBe("SEARCH");
		expect(pre.operation.create.members).toHaveLength(4);
		expect(pre.operation.create.resourceName).toBeUndefined();
		expect(crits.filter((c) => c.customAudience?.customAudience === pre.placeholder)).toHaveLength(2);
		// Ningún campo de campaña de nivel campaña de ubicación (upgraded targeting)
		expect(ofKind(ops, "campaignCriterionOperation")).toHaveLength(0);
		// Anuncio multi-imagen con assets reutilizados del PMax
		const [ad1] = ofKind(ops, "adGroupAdOperation");
		const dg = ad1.create.ad.demandGenMultiAssetAd;
		expect(dg.headlines.map((h: any) => h.text)).toEqual(["Freight Forwarding Software", "Freight Forwarding CRM"]);
		expect(dg.businessName).toBe("Neurored");
		expect(dg.logoImages).toEqual([{ asset: A("20") }]);
		expect(dg.marketingImages).toEqual([{ asset: A("10") }]);
		expect(dg.squareMarketingImages).toEqual([{ asset: A("11") }]);
		expect(dg.portraitMarketingImages).toEqual([{ asset: A("12") }]);
		expect(dg.callToActionText).toBe("Sign up");
		expect(ad1.create.ad.finalUrls).toEqual(["https://www.neurored.com/"]);
		// Orden: presupuesto y campaña antes que lo que los referencia
		const idx = (k: string) => ops.findIndex((o) => o[k]);
		expect(idx("campaignBudgetOperation")).toBeLessThan(idx("campaignOperation"));
		expect(idx("campaignOperation")).toBeLessThan(idx("adGroupOperation"));
		// Por defecto solo optimiza hacia el lead: el resto de objetivos de cuenta quedan no biddable en la campaña
		const goals = ofKind(ops, "campaignConversionGoalOperation").map((g) => g.update);
		expect(goals.find((g) => g.resourceName.endsWith("~SUBMIT_LEAD_FORM~WEBSITE")).biddable).toBe(true);
		expect(goals.find((g) => g.resourceName.endsWith("~ENGAGEMENT~YOUTUBE_HOSTED")).biddable).toBe(false);
		expect(d.warnings?.join() ?? "").not.toMatch(/ENGAGEMENT/);
		// Segmentación optimizada fijada explícitamente
		for (const ag of ags) expect(ag.create.optimizedTargetingEnabled).toBe(false);
		expect(d.summary.join("\n")).toMatch(/Segmentación optimizada: desactivada/);
	});

	it("restrict_to_conversion_goal=false usa los objetivos de cuenta y avisa de los de YouTube", async () => {
		const { ads, client } = setup();
		seed(ads);
		const d = await buildDemandGenPlan(client, CID, { ...INPUT, restrict_to_conversion_goal: false }, "CUSTOM_AUDIENCE_CRITERION");
		expect(ofKind(d.operations, "campaignConversionGoalOperation")).toHaveLength(0);
		expect(d.warnings?.join()).toMatch(/ENGAGEMENT\/YOUTUBE_HOSTED/);
	});

	it("rellena {_campaignname} de las plantillas de la cuenta y exige el resto de parámetros", async () => {
		const { ads, client } = setup();
		seed(ads);
		ads.on(/customer.final_url_suffix FROM customer$/, [
			{ customer: { trackingUrlTemplate: "https://t.example/?u={lpurl}&src={_source}", finalUrlSuffix: "utm_campaign={_campaignname}&utm_content={_adgroupname}" } },
		]);
		await expect(buildDemandGenPlan(client, CID, INPUT, "CUSTOM_AUDIENCE_CRITERION")).rejects.toThrow(/\{_source\}/);
		const d = await buildDemandGenPlan(client, CID, { ...INPUT, url_custom_parameters: { source: "dg" } }, "CUSTOM_AUDIENCE_CRITERION");
		const [camp] = ofKind(d.operations, "campaignOperation");
		expect(camp.create.urlCustomParameters).toEqual([
			{ key: "source", value: "dg" },
			{ key: "campaignname", value: INPUT.name },
		]);
		expect(d.summary.join("\n")).toMatch(/\{_campaignname\}=TEST_MCP_DemandGen_Discover/);
		// {_adgroupname} va en cada grupo con su nombre, no en la campaña
		const ags = ofKind(d.operations, "adGroupOperation");
		expect(ags.map((g) => g.create.urlCustomParameters)).toEqual([[{ key: "adgroupname", value: "UAE" }], [{ key: "adgroupname", value: "SG" }]]);
	});

	it("optimized_targeting=true lo activa en todos los grupos", async () => {
		const { ads, client } = setup();
		seed(ads);
		const d = await buildDemandGenPlan(client, CID, { ...INPUT, optimized_targeting: true }, "CUSTOM_AUDIENCE_CRITERION");
		for (const ag of ofKind(d.operations, "adGroupOperation")) expect(ag.create.optimizedTargetingEnabled).toBe(true);
	});

	it("pasa las barreras y valida con validateOnly", async () => {
		const { ads, client, deps } = setup();
		seed(ads);
		ads.on(/FROM custom_audience WHERE custom_audience.status/, [{ customAudience: { resourceName: `customers/${CID}/customAudiences/555` } }]);
		const r = await createPlan(deps, await buildDemandGenPlan(client, CID, INPUT, "CUSTOM_AUDIENCE_CRITERION"));
		expect(r.ok).toBe(true);
		// Segmento validado en su servicio; campaña validada sustituyendo el placeholder por uno existente
		expect(ads.serviceCalls).toHaveLength(1);
		expect(ads.serviceCalls[0].body.validateOnly).toBe(true);
		expect(ads.mutateCalls[0].body.validateOnly).toBe(true);
		const sent = JSON.stringify(ads.mutateCalls[0].body.mutateOperations);
		expect(sent).toContain(`customers/${CID}/customAudiences/555`);
		expect(sent).not.toContain("customAudienceOperation");
	});

	it("apply: crea primero el segmento y usa su resource name real en la campaña", async () => {
		const { ads, client, deps } = setup();
		seed(ads);
		const { applyPlan, getAuditLog } = await import("../src/plans/engine");
		const r = await createPlan(deps, await buildDemandGenPlan(client, CID, INPUT, "CUSTOM_AUDIENCE_CRITERION"));
		if (!r.ok) throw new Error(r.message);
		ads.mutateResponse = { mutateOperationResponses: [{ campaignResult: { resourceName: `customers/${CID}/campaigns/1` } }] };
		const a = await applyPlan(deps, r.plan_id, `APPLY ${r.plan_id}`);
		expect(a.ok).toBe(true);
		const real = ads.serviceCalls.at(-1)!;
		expect(real.body.validateOnly).toBe(false);
		const main = ads.mutateCalls.at(-1)!.body;
		expect(main.validateOnly).toBe(false);
		const txt = JSON.stringify(main.mutateOperations);
		expect(txt).toContain(`customers/${CID}/customAudiences/900`);
		expect(txt).not.toMatch(/customAudiences\/-\d/);
		const [log] = await getAuditLog(deps.kv, 1, deps.userEmail);
		expect(log.resource_names).toEqual([`customers/${CID}/customAudiences/900`, `customers/${CID}/campaigns/1`]);
	});

	it("sin custom audience previo en la cuenta: valida el resto y avisa", async () => {
		const { ads, client, deps } = setup();
		seed(ads);
		const r = await createPlan(deps, await buildDemandGenPlan(client, CID, INPUT, "CUSTOM_AUDIENCE_CRITERION"));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.warnings.join()).toMatch(/Validación parcial/);
		expect(JSON.stringify(ads.mutateCalls[0].body.mutateOperations)).not.toMatch(/customAudiences\/-\d/);
	});

	it("modo AUDIENCE_RESOURCE: crea un Audience con el segmento y lo asigna al grupo", async () => {
		const { ads, client } = setup();
		seed(ads);
		const d = await buildDemandGenPlan(client, CID, INPUT, "AUDIENCE_RESOURCE");
		const auds = ofKind(d.operations, "audienceOperation");
		expect(auds).toHaveLength(2);
		expect(auds[0].create.dimensions[0].audienceSegments.segments[0]).toEqual({ customAudience: { customAudience: d.preSteps![0].placeholder } });
		const crits = ofKind(d.operations, "adGroupCriterionOperation").map((c) => c.create);
		expect(crits.filter((c) => c.audience)).toHaveLength(2);
		expect(crits.filter((c) => c.customAudience)).toHaveLength(0);
	});

	it("presupuesto por encima del límite: exige confirmación reforzada", async () => {
		const { ads, client, deps } = setup();
		seed(ads);
		const r = await createPlan(deps, await buildDemandGenPlan(client, CID, { ...INPUT, daily_budget: 80 }, "CUSTOM_AUDIENCE_CRITERION"));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.confirm_with).toBe(`APPLY-ELEVATED ${r.plan_id}`);
		expect(r.elevated.join()).toMatch(/MAX_DAILY_BUDGET/);
	});

	it("falla con mensaje claro si el objetivo de conversión no existe", async () => {
		const { ads, client } = setup();
		seed(ads);
		await expect(buildDemandGenPlan(client, CID, { ...INPUT, conversion_goal_category: "PURCHASE" }, "CUSTOM_AUDIENCE_CRITERION")).rejects.toThrow(/PURCHASE/);
	});

	it("falla si ya existe una campaña con ese nombre", async () => {
		const { ads, client } = setup();
		seed(ads);
		ads.on(/FROM campaign WHERE campaign.name =/, [{ campaign: { resourceName: "x", name: INPUT.name } }]);
		await expect(buildDemandGenPlan(client, CID, INPUT, "CUSTOM_AUDIENCE_CRITERION")).rejects.toThrow(/Ya existe/);
	});

	it("MAXIMIZE_CLICKS usa targetSpend; canal desconocido falla", async () => {
		const { ads, client } = setup();
		seed(ads);
		const d = await buildDemandGenPlan(client, CID, { ...INPUT, bidding_strategy: "MAXIMIZE_CLICKS", new_custom_audiences: [], ad_groups: [{ ...INPUT.ad_groups[1], custom_audience_keys: [] }] }, "CUSTOM_AUDIENCE_CRITERION");
		expect(ofKind(d.operations, "campaignOperation")[0].create.targetSpend).toEqual({});
		await expect(buildDemandGenPlan(client, CID, { ...INPUT, channels: ["TIKTOK" as any] }, "CUSTOM_AUDIENCE_CRITERION")).rejects.toThrow(/Canal desconocido/);
	});

	it("descarta imágenes del PMax que no cumplen proporción/tamaño de Demand Gen (logo 32x32)", async () => {
		const { ads, client } = setup();
		seed(ads);
		ads.on(/FROM campaign_asset/, [
			{ campaignAsset: { fieldType: "LOGO" }, asset: { resourceName: A("20"), type: "IMAGE", imageAsset: { fullSize: { widthPixels: 512, heightPixels: 512 } } } },
			{ campaignAsset: { fieldType: "LOGO" }, asset: { resourceName: A("22"), type: "IMAGE", imageAsset: { fullSize: { widthPixels: 32, heightPixels: 32 } } } },
			{ campaignAsset: { fieldType: "BUSINESS_NAME" }, asset: { resourceName: A("21"), type: "TEXT", textAsset: { text: "Neurored" } } },
		]);
		const d = await buildDemandGenPlan(client, CID, INPUT, "AUDIENCE_RESOURCE");
		const [ad] = ofKind(d.operations, "adGroupAdOperation");
		expect(ad.create.ad.demandGenMultiAssetAd.logoImages).toEqual([{ asset: A("20") }]);
		expect(d.warnings?.join()).toContain(`${A("22")} (32x32)`);
	});

	it("anuncio incompleto (sin logo) falla antes de llamar a la API", async () => {
		const { ads, client } = setup();
		seed(ads);
		ads.on(/FROM campaign_asset/, []);
		await expect(buildDemandGenPlan(client, CID, INPUT, "CUSTOM_AUDIENCE_CRITERION")).rejects.toThrow(/logos: 0|business_name/);
	});
});

describe("ALLOWED_EMAILS", () => {
	it("solo deja pasar emails de la lista (sin distinguir mayúsculas)", () => {
		expect(isEmailAllowed("ivan@mycontent.agency", "ivan@mycontent.agency")).toBe(true);
		expect(isEmailAllowed("Ivan@MyContent.agency", "ivan@mycontent.agency, otro@x.com")).toBe(true);
		expect(isEmailAllowed("intruso@gmail.com", "ivan@mycontent.agency")).toBe(false);
		expect(isEmailAllowed(undefined, "ivan@mycontent.agency")).toBe(false);
		expect(isEmailAllowed("ivan@mycontent.agency", "")).toBe(false);
	});
});
