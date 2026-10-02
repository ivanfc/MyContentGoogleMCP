import type { GoogleAdsClient, Json } from "../ads/client";
import { negativeBlocks } from "../plans/builders";

export interface HealthFinding {
	severity: "high" | "medium" | "info";
	check: string;
	campaign?: string;
	detail: string;
}

/** Objetivos de cuenta que no son leads ni ventas: si son biddable, las campañas que heredan los objetivos de cuenta optimizan hacia ellos. */
const SOFT_GOALS = new Set(["ENGAGEMENT", "YOUTUBE_FOLLOW_ON_VIEWS", "PAGE_VIEW", "STORE_VISIT", "GET_DIRECTIONS", "DEFAULT", "OUTBOUND_CLICK"]);

const keysOf = (list: Json[] | undefined) => new Set((list ?? []).map((p) => String(p.key)));

/**
 * Diagnóstico de solo lectura de una cuenta con lo aprendido en uso real (Neurored, 02-10-2026):
 * seguimiento sin parámetros, negativas que bloquean keywords activas, objetivos de conversión "blandos",
 * estado de servicio de las campañas, anuncios rechazados y segmentación optimizada en Demand Gen.
 * Cada comprobación es independiente: si una consulta falla, se informa y se siguen las demás.
 */
export async function accountHealthCheck(client: GoogleAdsClient, cid: string) {
	const findings: HealthFinding[] = [];
	const checks: Record<string, "ok" | string> = {};
	const run = async (name: string, fn: () => Promise<void>) => {
		try {
			await fn();
			checks[name] = "ok";
		} catch (e) {
			checks[name] = `no se pudo comprobar: ${(e as Error).message.split("\n")[0].slice(0, 200)}`;
		}
	};

	await run("seguimiento", async () => {
		const tpl = ((await client.searchAll(cid, "SELECT customer.tracking_url_template, customer.final_url_suffix FROM customer"))[0]?.customer ?? {}) as Json;
		const keys = [...new Set([...`${tpl.trackingUrlTemplate ?? ""} ${tpl.finalUrlSuffix ?? ""}`.matchAll(/\{_([A-Za-z0-9]+)\}/g)].map((m) => m[1]))];
		if (!keys.length) return;
		const agKeys = keys.filter((k) => /^ad_?group_?name$/i.test(k));
		const campKeysNeeded = keys.filter((k) => !agKeys.includes(k));
		const camps = await client.searchAll(
			cid,
			"SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.url_custom_parameters FROM campaign WHERE campaign.status = 'ENABLED'",
		);
		const campParams = new Map<string, Set<string>>();
		for (const r of camps) {
			const have = keysOf(r.campaign.urlCustomParameters);
			campParams.set(String(r.campaign.id), have);
			const missing = campKeysNeeded.filter((k) => !have.has(k));
			if (missing.length) findings.push({ severity: "high", check: "seguimiento", campaign: r.campaign.name, detail: `La cuenta usa {_${missing.join("}, {_")}} y la campaña no lo define: ese dato llega vacío.` });
		}
		if (!agKeys.length) return;
		const groups = await client.searchAll(
			cid,
			"SELECT campaign.id, campaign.name, campaign.advertising_channel_type, ad_group.name, ad_group.url_custom_parameters FROM ad_group WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED'",
		);
		const byCampaign = new Map<string, { name: string; groups: string[] }>();
		for (const g of groups) {
			if (g.campaign.advertisingChannelType === "PERFORMANCE_MAX") continue;
			const have = keysOf(g.adGroup.urlCustomParameters);
			const campHave = campParams.get(String(g.campaign.id)) ?? new Set();
			if (agKeys.every((k) => have.has(k) || campHave.has(k))) continue;
			const e = byCampaign.get(String(g.campaign.id)) ?? { name: String(g.campaign.name), groups: [] as string[] };
			e.groups.push(g.adGroup.name);
			byCampaign.set(String(g.campaign.id), e);
		}
		for (const e of byCampaign.values()) {
			findings.push({ severity: "high", check: "seguimiento", campaign: e.name, detail: `La cuenta usa {_${agKeys.join("}, {_")}} y estos grupos activos no lo definen: ${e.groups.join(", ")}.` });
		}
	});

	await run("negativas_vs_keywords", async () => {
		const negs = await client.searchAll(
			cid,
			"SELECT campaign.id, campaign.name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign.status = 'ENABLED' AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE",
		);
		if (!negs.length) return;
		const pos = await client.searchAll(
			cid,
			"SELECT campaign.id, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM keyword_view WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_criterion.status = 'ENABLED' AND ad_group_criterion.negative != TRUE",
		);
		const posByCampaign = new Map<string, Json[]>();
		for (const p of pos) {
			const k = String(p.campaign.id);
			posByCampaign.set(k, [...(posByCampaign.get(k) ?? []), p]);
		}
		for (const n of negs) {
			const kw = n.campaignCriterion.keyword ?? {};
			for (const p of posByCampaign.get(String(n.campaign.id)) ?? []) {
				if (negativeBlocks(String(kw.text ?? ""), kw.matchType, String(p.adGroupCriterion.keyword?.text ?? ""))) {
					findings.push({
						severity: "high",
						check: "negativas_vs_keywords",
						campaign: n.campaign.name,
						detail: `La negativa "${kw.text}" (${kw.matchType}) bloquea la keyword activa "${p.adGroupCriterion.keyword.text}" (${p.adGroupCriterion.keyword.matchType}) del grupo "${p.adGroup.name}".`,
					});
				}
			}
		}
	});

	await run("objetivos_de_conversion", async () => {
		const goals = await client.searchAll(cid, "SELECT customer_conversion_goal.category, customer_conversion_goal.origin, customer_conversion_goal.biddable FROM customer_conversion_goal");
		const soft = goals.filter((g) => g.customerConversionGoal.biddable === true && SOFT_GOALS.has(g.customerConversionGoal.category));
		if (soft.length) {
			findings.push({
				severity: "medium",
				check: "objetivos_de_conversion",
				detail: `Objetivos de cuenta "biddable" que no son leads ni ventas: ${soft.map((g) => `${g.customerConversionGoal.category}/${g.customerConversionGoal.origin}`).join(", ")}. Toda campaña que use los objetivos de cuenta optimiza también hacia ellos.`,
			});
		}
	});

	await run("estado_de_campanas", async () => {
		const rows = await client.searchAll(cid, "SELECT campaign.name, campaign.primary_status, campaign.primary_status_reasons FROM campaign WHERE campaign.status = 'ENABLED'");
		for (const r of rows) {
			const st = r.campaign.primaryStatus;
			if (!st || st === "ELIGIBLE") continue;
			const sev = st === "NOT_ELIGIBLE" || st === "MISCONFIGURED" ? "high" : st === "LIMITED" ? "medium" : "info";
			findings.push({ severity: sev, check: "estado_de_campanas", campaign: r.campaign.name, detail: `Estado ${st}${r.campaign.primaryStatusReasons?.length ? `: ${r.campaign.primaryStatusReasons.join(", ")}` : ""}.` });
		}
	});

	await run("anuncios_rechazados", async () => {
		const rows = await client.searchAll(
			cid,
			"SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED' AND ad_group_ad.policy_summary.approval_status IN ('DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY')",
		);
		for (const r of rows) {
			const st = r.adGroupAd.policySummary?.approvalStatus;
			findings.push({ severity: st === "DISAPPROVED" ? "high" : "medium", check: "anuncios_rechazados", campaign: r.campaign.name, detail: `Anuncio ${r.adGroupAd.ad?.id} del grupo "${r.adGroup.name}": ${st}.` });
		}
	});

	await run("segmentacion_optimizada_demand_gen", async () => {
		const rows = await client.searchAll(
			cid,
			"SELECT campaign.name, ad_group.name FROM ad_group WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.advertising_channel_type = 'DEMAND_GEN' AND ad_group.optimized_targeting_enabled = TRUE",
		);
		for (const r of rows) findings.push({ severity: "info", check: "segmentacion_optimizada_demand_gen", campaign: r.campaign.name, detail: `Grupo "${r.adGroup.name}" con segmentación optimizada activada (Google amplía más allá de las audiencias).` });
	});

	const order = { high: 0, medium: 1, info: 2 } as const;
	findings.sort((a, b) => order[a.severity] - order[b.severity]);
	return {
		customer_id: cid,
		resumen: { alta: findings.filter((f) => f.severity === "high").length, media: findings.filter((f) => f.severity === "medium").length, info: findings.filter((f) => f.severity === "info").length },
		comprobaciones: checks,
		hallazgos: findings,
		no_cubierto: "Listas de negativas compartidas y negativas a nivel de grupo no se cruzan con las keywords; solo campañas activas.",
	};
}
