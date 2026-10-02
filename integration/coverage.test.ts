/**
 * Matriz de cobertura: valida con validateOnly (NUNCA aplica) cada tipo de cambio habitual sobre campañas
 * reales de cada tipo en 8460514008. Escribe el resultado en integration/coverage-result.json.
 * Ejecutar: npm run integration -- coverage
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GoogleAdsClient, type Json } from "../src/ads/client";
import { getLimits, missingSecrets, toMicros } from "../src/config";
import { buildCampaignBudgetPlan, buildExcludePlacementsPlan, buildGeoTargetingPlan, buildNegativeKeywordsPlan, buildCustomAudiencePlan, buildCampaignStatusPlan } from "../src/plans/builders";
import { type Deps, type PlanDraft, createPlan } from "../src/plans/engine";
import { buildGenericPlan } from "../src/plans/generic";
import { type BiddingInput, buildBiddingPlans } from "../src/plans/bidding";
import { MemoryKV } from "../test/helpers";

declare const process: { env: Record<string, string | undefined> };
// Sin @types/node: escritura del resultado mediante import dinámico.
const writeFile = async (path: string, data: string) => ((await import("node:fs" as string)) as { writeFileSync: (p: string, d: string) => void }).writeFileSync(path, data);

const env = {
	GOOGLE_ADS_DEVELOPER_TOKEN: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || undefined,
	GOOGLE_ADS_CLIENT_ID: process.env.GOOGLE_ADS_CLIENT_ID ?? "",
	GOOGLE_ADS_CLIENT_SECRET: process.env.GOOGLE_ADS_CLIENT_SECRET ?? "",
	GOOGLE_ADS_REFRESH_TOKEN: process.env.GOOGLE_ADS_REFRESH_TOKEN ?? "",
	GOOGLE_ADS_LOGIN_CUSTOMER_ID: "2567236642",
	ALLOWED_CUSTOMER_IDS: "8460514008",
	MAX_DAILY_BUDGET: "60",
	MAX_BUDGET_INCREASE_PCT: "100",
};
const CID = "8460514008";
const client = new GoogleAdsClient(env);
const deps: Deps = { client, kv: new MemoryKV() as unknown as KVNamespace, limits: getLimits(env), userEmail: "coverage-test" };
const R = (c: string, id: string) => `customers/${CID}/${c}/${id}`;

/** Campañas reales por tipo (se buscan por API; si no existe el tipo, sus casos se omiten). */
const ids: Record<string, Json | undefined> = {};
const results: { type: string; change: string; tool: string; ok: boolean; detail: string }[] = [];

async function one(q: string): Promise<Json | undefined> {
	return (await client.searchAll(CID, q))[0];
}

beforeAll(async () => {
	if (missingSecrets(env).length) return;
	const pick = async (type: string, extra = "") =>
		one(`SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.advertising_channel_type = '${type}' AND campaign.status != 'REMOVED' ${extra} ORDER BY campaign.status LIMIT 1`);
	ids.SEARCH = await pick("SEARCH", "AND campaign.name LIKE 'Neurored_EN_NATO_Brand%'");
	ids.PERFORMANCE_MAX = await pick("PERFORMANCE_MAX", "AND campaign.name = 'Neurored_EN_NATO_PMax_Freight_Forwarding_Software'");
	ids.DISPLAY = await pick("DISPLAY");
	ids.DEMAND_GEN = await pick("DEMAND_GEN");
	ids.VIDEO = await pick("VIDEO");
	ids.SHOPPING = await pick("SHOPPING");
	for (const t of ["SEARCH", "DISPLAY", "DEMAND_GEN", "VIDEO"]) {
		const c = ids[t] as Json;
		if (!c) continue;
		const cid = c.campaign.id;
		c.adGroup = (await one(`SELECT ad_group.id, ad_group.status, ad_group.cpc_bid_micros FROM ad_group WHERE campaign.id = ${cid} AND ad_group.status != 'REMOVED' LIMIT 1`))?.adGroup;
		if (c.adGroup) {
			c.keyword = (await one(`SELECT ad_group_criterion.criterion_id, ad_group_criterion.status FROM ad_group_criterion WHERE ad_group.id = ${c.adGroup.id} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED' LIMIT 1`))?.adGroupCriterion;
			c.ad = (await one(`SELECT ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.ad.type FROM ad_group_ad WHERE ad_group.id = ${c.adGroup.id} AND ad_group_ad.status != 'REMOVED' LIMIT 1`))?.adGroupAd;
		}
	}
	if (ids.PERFORMANCE_MAX) {
		const pm = ids.PERFORMANCE_MAX as Json;
		pm.assetGroup = (await one(`SELECT asset_group.id, asset_group.status FROM asset_group WHERE campaign.id = ${pm.campaign.id} AND asset_group.status != 'REMOVED' LIMIT 1`))?.assetGroup;
		pm.agAsset = (await one(`SELECT asset_group_asset.resource_name FROM asset_group_asset WHERE asset_group.id = ${pm.assetGroup?.id} AND asset_group_asset.field_type = 'HEADLINE' AND asset_group_asset.status = 'ENABLED' LIMIT 1`))?.assetGroupAsset;
	}
	console.log("Campañas usadas:", Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v ? `${v.campaign.name} (${v.campaign.id}, ${v.campaign.status})` : "no existe en la cuenta"])));
});

afterAll(async () => {
	if (!results.length) return;
	await writeFile("integration/coverage-result.json", JSON.stringify(results, null, 2));
	console.table(results.map((r) => ({ tipo: r.type, cambio: r.change, ok: r.ok ? "OK" : "FALLA", detalle: r.detail.slice(0, 110) })));
});

/** Restricciones reales de la API: se espera que fallen con un mensaje claro (no cuentan como fallo del MCP). */
const EXPECTED_UNSUPPORTED = new Set([
	"PERFORMANCE_MAX/placement excluido (campaña)",
	"PERFORMANCE_MAX/bid modifier dispositivo",
	"PERFORMANCE_MAX/puja: MAXIMIZE_CLICKS + CPC máx.",
	"PERFORMANCE_MAX/puja: MANUAL_CPC",
	// Demand Gen con upgraded targeting (verificado 02-10-2026 en la campaña Discover de Neurored).
	"DEMAND_GEN/geo: excluir país + PRESENCE",
	"DEMAND_GEN/idioma (criterio de campaña)",
	"DEMAND_GEN/bid modifier dispositivo",
	"DEMAND_GEN/puja: MAXIMIZE_CLICKS + CPC máx.",
	"DEMAND_GEN/puja: MANUAL_CPC",
	// tROAS: OPERATION_NOT_PERMITTED_FOR_CONTEXT en esta cuenta (sin valores de conversión); puede depender de la cuenta.
	"DEMAND_GEN/puja: MAXIMIZE_CONVERSION_VALUE + tROAS",
]);

async function check(type: string, change: string, tool: string, draftFn: () => Promise<PlanDraft>) {
	let ok = false;
	let detail = "";
	try {
		const r = await createPlan(deps, await draftFn());
		ok = r.ok;
		detail = r.ok ? (r.warnings.join(" | ") || "validateOnly OK") : `[${r.stage}] ${r.message.replace(/\n/g, " ")}`;
	} catch (e) {
		detail = `[builder] ${(e as Error).message.replace(/\n/g, " ")}`;
	}
	if (EXPECTED_UNSUPPORTED.has(`${type}/${change}`)) {
		results.push({ type, change, tool, ok: !ok, detail: ok ? "ACEPTADO (se esperaba restricción de la API)" : `NO SOPORTADO por la API: ${detail}` });
		expect.soft(ok, `${type} / ${change}: debería estar restringido`).toBe(false);
		return;
	}
	results.push({ type, change, tool, ok, detail });
	if (!ok) console.log(`FALLA ${type} / ${change}: ${detail}`);
	expect.soft(ok, `${type} / ${change}: ${detail}`).toBe(true);
}

const generic = (ops: Json[]) => () => buildGenericPlan(client, CID, ops);
const camp = (t: string) => R("campaigns", (ids[t] as Json).campaign.id);

const CAMPAIGN_TYPES = ["SEARCH", "PERFORMANCE_MAX", "DISPLAY", "DEMAND_GEN", "VIDEO", "SHOPPING"];

describe.skipIf(missingSecrets(env).length > 0)("cobertura de cambios por tipo de campaña (validateOnly)", () => {
	for (const t of CAMPAIGN_TYPES) {
		describe(t, () => {
			const has = () => Boolean(ids[t]);
			const c = () => ids[t] as Json;

			it("pausar / activar campaña", async (ctx) => {
				if (!has()) return ctx.skip();
				await check(t, "estado de campaña", "plan_update_campaign_status", () =>
					buildCampaignStatusPlan(client, CID, c().campaign.id, c().campaign.status === "PAUSED" ? "ENABLED" : "PAUSED"),
				);
			});
			it("bajar presupuesto diario", async (ctx) => {
				if (!has()) return ctx.skip();
				const cur = Number(c().campaignBudget.amountMicros) / 1e6;
				await check(t, "presupuesto (bajada)", "plan_update_campaign_budget", () => buildCampaignBudgetPlan(client, CID, c().campaign.id, Math.max(1, Math.round((cur - 1) * 100) / 100)));
			});
			it("excluir país + opción PRESENCE", async (ctx) => {
				if (!has()) return ctx.skip();
				await check(t, "geo: excluir país + PRESENCE", "plan_set_geo_targeting", () =>
					buildGeoTargetingPlan(client, CID, c().campaign.id, { exclude_country_codes: ["IS"], geo_target_type: "PRESENCE" }),
				);
			});
			it("cambiar opción de ubicación a PRESENCE_OR_INTEREST", async (ctx) => {
				if (!has()) return ctx.skip();
				await check(t, "geo: opción de ubicación", "plan_set_geo_targeting", () =>
					buildGeoTargetingPlan(client, CID, c().campaign.id, { geo_target_type: "PRESENCE_OR_INTEREST" }),
				);
			});
			it("keyword negativa de campaña", async (ctx) => {
				if (!has()) return ctx.skip();
				await check(t, "keyword negativa", "plan_add_negative_keywords", () => buildNegativeKeywordsPlan(client, CID, c().campaign.id, [`mcp coverage test ${Date.now()}`], "PHRASE"));
			});
			it("excluir placement en campaña", async (ctx) => {
				if (!has()) return ctx.skip();
				await check(t, "placement excluido (campaña)", "plan_exclude_placements", () => buildExcludePlacementsPlan(client, CID, "campaign", [`mcp-coverage-${Date.now()}.example.com`], c().campaign.id));
			});
			it("renombrar campaña", async (ctx) => {
				if (!has()) return ctx.skip();
				await check(t, "nombre", "plan_generic_mutate", generic([{ campaignOperation: { update: { resourceName: camp(t), name: `${c().campaign.name} (mcp test)` }, updateMask: "name" } }]));
			});
			it("fecha de fin", async (ctx) => {
				if (!has()) return ctx.skip();
				await check(t, "fecha de fin", "plan_generic_mutate", generic([{ campaignOperation: { update: { resourceName: camp(t), endDateTime: "2030-12-31 23:59:59" }, updateMask: "end_date_time" } }]));
			});
			it("sufijo de URL final", async (ctx) => {
				if (!has()) return ctx.skip();
				await check(t, "final_url_suffix", "plan_generic_mutate", generic([{ campaignOperation: { update: { resourceName: camp(t), finalUrlSuffix: "utm_source=google&utm_medium=cpc" }, updateMask: "final_url_suffix" } }]));
			});
			for (const b of [
				{ strategy: "MAXIMIZE_CONVERSIONS", target_cpa: 50 },
				{ strategy: "MAXIMIZE_CONVERSIONS" },
				{ strategy: "MAXIMIZE_CONVERSION_VALUE", target_roas: 4 },
				{ strategy: "MAXIMIZE_CLICKS", max_cpc: 2 },
				{ strategy: "MANUAL_CPC" },
			] as BiddingInput[]) {
				const label = `puja: ${b.strategy}${b.target_cpa ? " + tCPA" : ""}${b.target_roas ? " + tROAS" : ""}${b.max_cpc ? " + CPC máx." : ""}`;
				it(label, async (ctx) => {
					if (!has()) return ctx.skip();
					if (EXPECTED_UNSUPPORTED.has(`${t}/${label}`)) {
						await check(t, label, "plan_update_bidding_strategy", async () => (await buildBiddingPlans(client, CID, c().campaign.id, b))[0]);
						return;
					}
					const drafts = await buildBiddingPlans(client, CID, c().campaign.id, b);
					let ok = false;
					let detail = "";
					for (const d of drafts) {
						const r = await createPlan(deps, d);
						if (r.ok) {
							ok = true;
							detail = `validateOnly OK vía ${d.operations[0].campaignOperation.updateMask}`;
							break;
						}
						detail += `[${d.operations[0].campaignOperation.updateMask}] ${r.message.split("\n").slice(2).join(" ").slice(0, 160)} `;
					}
					results.push({ type: t, change: label, tool: "plan_update_bidding_strategy", ok, detail });
					expect.soft(ok, `${t} / ${label}: ${detail}`).toBe(true);
				});
			}
			it("idioma de campaña", async (ctx) => {
				if (!has()) return ctx.skip();
				await check(t, "idioma (criterio de campaña)", "plan_generic_mutate", generic([
					{ campaignCriterionOperation: { create: { campaign: camp(t), language: { languageConstant: "languageConstants/1003" } } } },
				]));
			});
			it("programación horaria", async (ctx) => {
				if (!has()) return ctx.skip();
				await check(t, "ad schedule", "plan_generic_mutate", generic([
					{ campaignCriterionOperation: { create: { campaign: camp(t), adSchedule: { dayOfWeek: "SUNDAY", startHour: 9, startMinute: "ZERO", endHour: 18, endMinute: "ZERO" } } } },
				]));
			});
			it("ajuste de puja por dispositivo (móvil -20 %)", async (ctx) => {
				if (!has()) return ctx.skip();
				await check(t, "bid modifier dispositivo", "plan_generic_mutate", generic([
					{ campaignCriterionOperation: { create: { campaign: camp(t), device: { type: "MOBILE" }, bidModifier: 0.8 } } },
				]));
			});
			it("sitelink nuevo vinculado a la campaña", async (ctx) => {
				if (!has()) return ctx.skip();
				await check(t, "sitelink (asset + campaign_asset)", "plan_generic_mutate", generic([
					{ assetOperation: { create: { resourceName: R("assets", "-1"), sitelinkAsset: { linkText: "Book a demo", description1: "Talk to a logistics expert", description2: "Free 30-min session" }, finalUrls: ["https://www.neurored.com/"] } } },
					{ campaignAssetOperation: { create: { campaign: camp(t), asset: R("assets", "-1"), fieldType: "SITELINK" } } },
				]));
			});
			it("red de búsqueda: desactivar partners (solo Search)", async (ctx) => {
				if (!has() || t !== "SEARCH") return ctx.skip();
				await check(t, "network: sin search partners", "plan_generic_mutate", generic([
					{ campaignOperation: { update: { resourceName: camp(t), networkSettings: { targetSearchNetwork: false } }, updateMask: "network_settings.target_search_network" } },
				]));
			});

			// ---- grupos de anuncios (no PMax)
			it("pausar grupo de anuncios", async (ctx) => {
				if (!has() || !c().adGroup) return ctx.skip();
				await check(t, "estado de grupo", "plan_generic_mutate", generic([
					{ adGroupOperation: { update: { resourceName: R("adGroups", c().adGroup.id), status: c().adGroup.status === "PAUSED" ? "ENABLED" : "PAUSED" }, updateMask: "status" } },
				]));
			});
			it("crear grupo de anuncios", async (ctx) => {
				if (!has() || !c().adGroup || t === "DEMAND_GEN") return ctx.skip();
				await check(t, "nuevo grupo", "plan_generic_mutate", generic([
					{ adGroupOperation: { create: { campaign: camp(t), name: `MCP coverage ${Date.now()}`, status: "PAUSED" } } },
				]));
			});
			it("añadir keyword (Search)", async (ctx) => {
				if (!has() || !c().adGroup || t !== "SEARCH") return ctx.skip();
				await check(t, "keyword nueva", "plan_generic_mutate", generic([
					{ adGroupCriterionOperation: { create: { adGroup: R("adGroups", c().adGroup.id), status: "PAUSED", keyword: { text: "freight forwarding crm demo", matchType: "PHRASE" } } } },
				]));
			});
			it("pausar keyword (Search)", async (ctx) => {
				if (!has() || !c().keyword) return ctx.skip();
				await check(t, "estado de keyword", "plan_generic_mutate", generic([
					{ adGroupCriterionOperation: { update: { resourceName: R("adGroupCriteria", `${c().adGroup.id}~${c().keyword.criterionId}`), status: c().keyword.status === "PAUSED" ? "ENABLED" : "PAUSED" }, updateMask: "status" } },
				]));
			});
			it("keyword negativa de grupo", async (ctx) => {
				if (!has() || !c().adGroup || t !== "SEARCH") return ctx.skip();
				await check(t, "negativa de grupo", "plan_generic_mutate", generic([
					{ adGroupCriterionOperation: { create: { adGroup: R("adGroups", c().adGroup.id), negative: true, keyword: { text: "free download", matchType: "PHRASE" } } } },
				]));
			});
			it("pausar anuncio", async (ctx) => {
				if (!has() || !c().ad) return ctx.skip();
				await check(t, "estado de anuncio", "plan_generic_mutate", generic([
					{ adGroupAdOperation: { update: { resourceName: R("adGroupAds", `${c().adGroup.id}~${c().ad.ad.id}`), status: c().ad.status === "PAUSED" ? "ENABLED" : "PAUSED" }, updateMask: "status" } },
				]));
			});
			it("crear RSA (Search)", async (ctx) => {
				if (!has() || !c().adGroup || t !== "SEARCH") return ctx.skip();
				await check(t, "anuncio RSA nuevo", "plan_generic_mutate", generic([
					{
						adGroupAdOperation: {
							create: {
								adGroup: R("adGroups", c().adGroup.id),
								status: "PAUSED",
								ad: {
									finalUrls: ["https://www.neurored.com/"],
									responsiveSearchAd: {
										headlines: ["Neurored TMS", "Freight Forwarding CRM", "Built on Salesforce"].map((text) => ({ text })),
										descriptions: ["Manage quotes, bookings and billing in one platform.", "Book a demo with a logistics expert."].map((text) => ({ text })),
									},
								},
							},
						},
					},
				]));
			});

			// ---- Performance Max
			it("pausar asset group (PMax)", async (ctx) => {
				if (!has() || !c().assetGroup) return ctx.skip();
				await check(t, "estado de asset group", "plan_generic_mutate", generic([
					{ assetGroupOperation: { update: { resourceName: R("assetGroups", c().assetGroup.id), status: c().assetGroup.status === "PAUSED" ? "ENABLED" : "PAUSED" }, updateMask: "status" } },
				]));
			});
			it("search theme nuevo (PMax)", async (ctx) => {
				if (!has() || !c().assetGroup) return ctx.skip();
				await check(t, "search theme (asset group signal)", "plan_generic_mutate", generic([
					{ assetGroupSignalOperation: { create: { assetGroup: R("assetGroups", c().assetGroup.id), searchTheme: { text: `freight forwarding software demo ${Date.now() % 1000}` } } } },
				]));
			});
			it("titular nuevo en asset group (PMax)", async (ctx) => {
				if (!has() || !c().assetGroup) return ctx.skip();
				await check(t, "titular nuevo (asset + asset_group_asset)", "plan_generic_mutate", generic([
					{ assetOperation: { create: { resourceName: R("assets", "-1"), textAsset: { text: "Freight CRM on Salesforce" } } } },
					{ assetGroupAssetOperation: { create: { assetGroup: R("assetGroups", c().assetGroup.id), asset: R("assets", "-1"), fieldType: "HEADLINE" } } },
				]));
			});
			it("pausar un asset del asset group (PMax)", async (ctx) => {
				if (!has() || !c().agAsset) return ctx.skip();
				await check(t, "pausar asset de asset group", "plan_generic_mutate", generic([
					{ assetGroupAssetOperation: { update: { resourceName: c().agAsset.resourceName, status: "PAUSED" }, updateMask: "status" } },
				]));
			});
			it("URL final del asset group (PMax)", async (ctx) => {
				if (!has() || !c().assetGroup) return ctx.skip();
				await check(t, "final URL de asset group", "plan_generic_mutate", generic([
					{ assetGroupOperation: { update: { resourceName: R("assetGroups", c().assetGroup.id), finalUrls: ["https://www.neurored.com/"] }, updateMask: "final_urls" } },
				]));
			});
		});
	}

	describe("cuenta / creación", () => {
		it("excluir placement a nivel de cuenta", async () => {
			await check("CUENTA", "placement excluido (cuenta)", "plan_exclude_placements", () => buildExcludePlacementsPlan(client, CID, "account", [`mcp-coverage-${Date.now()}.example.com`]));
		});
		it("crear custom audience (búsquedas)", async () => {
			await check("CUENTA", "custom audience", "plan_create_custom_audience", () => buildCustomAudiencePlan(client, CID, `MCP coverage ${Date.now()}`, ["freight software", "tms demo"]));
		});
		it("crear campaña Search completa en PAUSED", async () => {
			await check("SEARCH", "crear campaña (budget+campaña+grupo+keyword+RSA)", "plan_generic_mutate", generic([
				{ campaignBudgetOperation: { create: { resourceName: R("campaignBudgets", "-1"), name: `MCP coverage budget ${Date.now()}`, amountMicros: String(toMicros(5)), deliveryMethod: "STANDARD", explicitlyShared: false } } },
				{
					campaignOperation: {
						create: {
							resourceName: R("campaigns", "-2"),
							name: `MCP coverage Search ${Date.now()}`,
							status: "PAUSED",
							advertisingChannelType: "SEARCH",
							campaignBudget: R("campaignBudgets", "-1"),
							maximizeConversions: {},
							networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false },
							geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" },
							containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
						},
					},
				},
				{ campaignCriterionOperation: { create: { campaign: R("campaigns", "-2"), location: { geoTargetConstant: "geoTargetConstants/2784" } } } },
				{ adGroupOperation: { create: { resourceName: R("adGroups", "-3"), campaign: R("campaigns", "-2"), name: "MCP coverage AG", status: "ENABLED", type: "SEARCH_STANDARD" } } },
				{ adGroupCriterionOperation: { create: { adGroup: R("adGroups", "-3"), keyword: { text: "freight forwarding software", matchType: "PHRASE" } } } },
				{
					adGroupAdOperation: {
						create: {
							adGroup: R("adGroups", "-3"),
							ad: {
								finalUrls: ["https://www.neurored.com/"],
								responsiveSearchAd: {
									headlines: ["Neurored TMS", "Freight Forwarding CRM", "Built on Salesforce"].map((text) => ({ text })),
									descriptions: ["Manage quotes, bookings and billing in one platform.", "Book a demo with a logistics expert."].map((text) => ({ text })),
								},
							},
						},
					},
				},
			]));
		});
		it("barrera: activar campaña por el genérico exige APPLY-ELEVATED", async () => {
			const t = ids.SEARCH ? "SEARCH" : "PERFORMANCE_MAX";
			const r = await createPlan(deps, await buildGenericPlan(client, CID, [{ campaignOperation: { update: { resourceName: camp(t), status: "ENABLED" }, updateMask: "status" } }]));
			const ok = r.ok && r.confirm_with.startsWith("APPLY-ELEVATED");
			results.push({ type: "BARRERA", change: "activar campaña por genérico", tool: "plan_generic_mutate", ok, detail: ok ? "confirmación reforzada (correcto)" : "SIN REFUERZO" });
			expect(ok).toBe(true);
		});
		it("barrera: cuenta fuera de ALLOWED_CUSTOMER_IDS bloqueada", async () => {
			const r = await createPlan(deps, { kind: "x", customerId: "2567236642", summary: [], operations: [{ campaignOperation: { update: { resourceName: "customers/2567236642/campaigns/1", status: "PAUSED" }, updateMask: "status" } }], stateQueries: [] });
			results.push({ type: "BARRERA", change: "escritura en cuenta no permitida", tool: "plan_generic_mutate", ok: !r.ok, detail: r.ok ? "NO BLOQUEADO" : "bloqueado (correcto)" });
			expect(r.ok).toBe(false);
		});
	});

	describe("ampliación: borrados, señales, audiencias, cuenta, conversiones y lectura avanzada", () => {
		/** El plan debe validar contra la API; `elevated` indica si se espera confirmación reforzada. */
		async function checkPlan(type: string, change: string, draftFn: () => Promise<PlanDraft>, elevated: boolean) {
			let ok = false;
			let detail = "";
			try {
				const r = await createPlan(deps, await draftFn());
				if (r.ok) {
					const isElevated = r.confirm_with.startsWith("APPLY-ELEVATED");
					ok = isElevated === elevated;
					detail = `validateOnly OK · ${isElevated ? `APPLY-ELEVATED (${r.elevated.join(" | ").slice(0, 120)})` : "APPLY"}`;
				} else detail = `[${r.stage}] ${r.message.replace(/\n/g, " ")}`;
			} catch (e) {
				detail = `[builder] ${(e as Error).message.replace(/\n/g, " ")}`;
			}
			results.push({ type, change, tool: "plan_generic_mutate", ok, detail });
			expect.soft(ok, `${type} / ${change}: ${detail}`).toBe(true);
		}

		it("borrar campaña (Search)", async (ctx) => {
			if (!ids.SEARCH) return ctx.skip();
			await checkPlan("SEARCH", "BORRAR campaña", generic([{ campaignOperation: { remove: camp("SEARCH") } }]), true);
		});
		it("borrar grupo de anuncios (Search)", async (ctx) => {
			const ag = (ids.SEARCH as Json | undefined)?.adGroup;
			if (!ag) return ctx.skip();
			await checkPlan("SEARCH", "BORRAR grupo de anuncios", generic([{ adGroupOperation: { remove: R("adGroups", ag.id) } }]), true);
		});
		it("quitar search theme de PMax", async (ctx) => {
			const pm = ids.PERFORMANCE_MAX as Json | undefined;
			if (!pm?.assetGroup) return ctx.skip();
			const sig = (await client.searchAll(CID, `SELECT asset_group_signal.resource_name, asset_group_signal.search_theme.text FROM asset_group_signal WHERE asset_group.id = ${pm.assetGroup.id}`)).find((r) => r.assetGroupSignal.searchTheme?.text);
			if (!sig) return ctx.skip();
			await checkPlan("PERFORMANCE_MAX", "quitar search theme", generic([{ assetGroupSignalOperation: { remove: sig.assetGroupSignal.resourceName } }]), false);
		});
		it("quitar un titular del asset group (PMax)", async (ctx) => {
			const pm = ids.PERFORMANCE_MAX as Json | undefined;
			if (!pm?.agAsset) return ctx.skip();
			await checkPlan("PERFORMANCE_MAX", "quitar asset de asset group", generic([{ assetGroupAssetOperation: { remove: pm.agAsset.resourceName } }]), false);
		});
		it("quitar un sitelink de la campaña (Search)", async (ctx) => {
			if (!ids.SEARCH) return ctx.skip();
			// campaign_asset exige campaign.id en el SELECT cuando se filtra por campaña.
			const ca = (await client.searchAll(CID, `SELECT campaign.id, campaign_asset.resource_name FROM campaign_asset WHERE campaign.id = ${(ids.SEARCH as Json).campaign.id} AND campaign_asset.field_type = 'SITELINK' AND campaign_asset.status != 'REMOVED' LIMIT 1`))[0];
			if (!ca) return ctx.skip();
			await checkPlan("SEARCH", "quitar sitelink de campaña", generic([{ campaignAssetOperation: { remove: ca.campaignAsset.resourceName } }]), false);
		});
		it("lista de remarketing basada en reglas", async () => {
			await checkPlan(
				"CUENTA",
				"crear lista de remarketing (reglas)",
				generic([
					{
						userListOperation: {
							create: {
								name: `MCP coverage visitantes ${Date.now()}`,
								membershipLifeSpan: 30,
								ruleBasedUserList: {
									prepopulationStatus: "REQUESTED",
									flexibleRuleUserList: {
										inclusiveRuleOperator: "AND",
										inclusiveOperands: [{ rule: { ruleItemGroups: [{ ruleItems: [{ name: "url__", stringRuleItem: { operator: "CONTAINS", value: "neurored.com" } }] }] }, lookbackWindowDays: 30 }],
									},
								},
							},
						},
					},
				]),
				false,
			);
		});
		it("configuración de cuenta: auto-tagging", async () => {
			await checkPlan("CUENTA", "auto-tagging (configuración de cuenta)", generic([{ customerOperation: { update: { resourceName: `customers/${CID}`, autoTaggingEnabled: true }, updateMask: "auto_tagging_enabled" } }]), true);
		});
		it("objetivo de conversión a nivel de campaña (PMax)", async (ctx) => {
			if (!ids.PERFORMANCE_MAX) return ctx.skip();
			const id = (ids.PERFORMANCE_MAX as Json).campaign.id;
			await checkPlan(
				"PERFORMANCE_MAX",
				"objetivos de conversión de la campaña",
				generic([{ conversionGoalCampaignConfigOperation: { update: { resourceName: R("conversionGoalCampaignConfigs", id), goalConfigLevel: "CUSTOMER" }, updateMask: "goal_config_level" } }]),
				false,
			);
		});
		it("lectura avanzada: ideas de keywords (api_read)", async () => {
			let ok = false;
			let detail = "";
			try {
				const res = await client.request("POST", `customers/${CID}:generateKeywordIdeas`, {
					language: "languageConstants/1000",
					geoTargetConstants: ["geoTargetConstants/2784"],
					keywordSeed: { keywords: ["freight forwarding software"] },
					pageSize: 5,
				});
				const n = (res.results ?? []).length;
				ok = n > 0;
				detail = `${n} ideas, p. ej. "${res.results?.[0]?.text ?? ""}"`;
			} catch (e) {
				detail = (e as Error).message.replace(/\n/g, " ");
				// Limitación del nivel de acceso del proyecto de Google Cloud (Explorer), no del MCP: se registra tal cual.
				if (/explorer access/i.test(detail)) {
					results.push({ type: "CUENTA", change: "ideas de keywords (Keyword Planner)", tool: "api_read", ok: true, detail: `NO DISPONIBLE con acceso Explorer del proyecto de Cloud (requiere Basic/Standard): ${detail.slice(0, 200)}` });
					return;
				}
			}
			results.push({ type: "CUENTA", change: "ideas de keywords (Keyword Planner)", tool: "api_read", ok, detail });
			expect.soft(ok, detail).toBe(true);
		});
	});
});
