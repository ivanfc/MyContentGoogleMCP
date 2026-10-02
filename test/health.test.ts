import { describe, expect, it } from "vitest";
import { accountHealthCheck } from "../src/tools/health";
import { CID, setup } from "./helpers";

describe("account_health_check", () => {
	it("detecta seguimiento sin parámetros, negativas que bloquean keywords, objetivos blandos, estado y anuncios", async () => {
		const { ads, client } = setup();
		ads.on(/customer.final_url_suffix FROM customer$/, [{ customer: { finalUrlSuffix: "utm_campaign={_campaignname}&utm_id={_adgroupname}" } }]);
		ads.on(/campaign.url_custom_parameters FROM campaign WHERE/, [
			{ campaign: { id: "1", name: "Search_OK", advertisingChannelType: "SEARCH", urlCustomParameters: [{ key: "campaignname", value: "Search_OK" }] } },
			{ campaign: { id: "2", name: "DG_sin_nada", advertisingChannelType: "DEMAND_GEN" } },
			{ campaign: { id: "3", name: "PMax", advertisingChannelType: "PERFORMANCE_MAX", urlCustomParameters: [{ key: "campaignname", value: "PMax" }] } },
		]);
		ads.on(/ad_group.url_custom_parameters FROM ad_group WHERE/, [
			{ campaign: { id: "1", name: "Search_OK", advertisingChannelType: "SEARCH" }, adGroup: { name: "G1", urlCustomParameters: [{ key: "adgroupname", value: "G1" }] } },
			{ campaign: { id: "2", name: "DG_sin_nada", advertisingChannelType: "DEMAND_GEN" }, adGroup: { name: "UAE" } },
		]);
		ads.on(/FROM campaign_criterion WHERE/, [{ campaign: { id: "1", name: "Search_OK" }, campaignCriterion: { keyword: { text: "wms software", matchType: "EXACT" } } }]);
		ads.on(/FROM keyword_view WHERE/, [
			{ campaign: { id: "1" }, adGroup: { name: "SCM" }, adGroupCriterion: { keyword: { text: "wms software", matchType: "EXACT" } } },
			{ campaign: { id: "1" }, adGroup: { name: "TMS" }, adGroupCriterion: { keyword: { text: "tms software", matchType: "EXACT" } } },
		]);
		ads.on(/FROM customer_conversion_goal/, [
			{ customerConversionGoal: { category: "SUBMIT_LEAD_FORM", origin: "WEBSITE", biddable: true } },
			{ customerConversionGoal: { category: "ENGAGEMENT", origin: "YOUTUBE_HOSTED", biddable: true } },
		]);
		ads.on(/campaign.primary_status_reasons FROM campaign/, [
			{ campaign: { name: "Search_OK", primaryStatus: "ELIGIBLE" } },
			{ campaign: { name: "DG_sin_nada", primaryStatus: "LIMITED", primaryStatusReasons: ["BUDGET_CONSTRAINED"] } },
		]);
		ads.on(/FROM ad_group_ad WHERE/, [{ campaign: { name: "Search_OK" }, adGroup: { name: "G1" }, adGroupAd: { ad: { id: "9" }, policySummary: { approvalStatus: "DISAPPROVED" } } }]);

		const r = await accountHealthCheck(client, CID);
		const text = r.hallazgos.map((f) => `${f.severity}|${f.check}|${f.campaign ?? ""}|${f.detail}`).join("\n");
		expect(text).toMatch(/high\|seguimiento\|DG_sin_nada\|.*\{_campaignname\}/);
		expect(text).toMatch(/high\|seguimiento\|DG_sin_nada\|.*grupos activos no lo definen: UAE/);
		expect(text).not.toMatch(/seguimiento\|(Search_OK|PMax)\|/);
		expect(text).toMatch(/negativa "wms software" \(EXACT\) bloquea la keyword activa "wms software"/);
		expect(text).not.toMatch(/tms software/);
		expect(text).toMatch(/medium\|objetivos_de_conversion\|\|.*ENGAGEMENT\/YOUTUBE_HOSTED/);
		expect(text).toMatch(/medium\|estado_de_campanas\|DG_sin_nada\|Estado LIMITED: BUDGET_CONSTRAINED/);
		expect(text).toMatch(/high\|anuncios_rechazados\|Search_OK\|Anuncio 9/);
		expect(r.hallazgos[0].severity).toBe("high");
		expect(Object.values(r.comprobaciones).every((v) => v === "ok")).toBe(true);
	});

	it("una consulta que falla no tumba el resto de comprobaciones", async () => {
		const { ads, client } = setup();
		ads.on(/FROM customer_conversion_goal/, () => {
			throw new Error("boom");
		});
		const r = await accountHealthCheck(client, CID);
		expect(r.comprobaciones.objetivos_de_conversion).toMatch(/no se pudo comprobar/);
		expect(r.comprobaciones.estado_de_campanas).toBe("ok");
	});
});
