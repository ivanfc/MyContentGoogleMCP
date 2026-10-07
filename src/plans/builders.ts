import { type GoogleAdsClient, type Json, assertId, gaqlString } from "../ads/client";
import { fromMicros, toMicros } from "../config";
import type { PlanDraft } from "./engine";

/* ------------------------------------------------------------------ helpers */

export async function getCurrency(client: GoogleAdsClient, cid: string): Promise<string> {
	const rows = await client.searchAll(cid, "SELECT customer.currency_code FROM customer");
	const c = rows[0]?.customer?.currencyCode;
	if (!c) throw new Error(`No se pudo leer customer.currency_code de ${cid}.`);
	return c;
}

export interface CampaignInfo {
	resourceName: string;
	id: string;
	name: string;
	status: string;
	channelType: string;
	budgetResourceName?: string;
	positiveGeoTargetType?: string;
	negativeGeoTargetType?: string;
}

export async function getCampaign(client: GoogleAdsClient, cid: string, campaignId: string): Promise<CampaignInfo> {
	const id = assertId(campaignId, "campaign_id");
	const rows = await client.searchAll(
		cid,
		`SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.campaign_budget, campaign.geo_target_type_setting.positive_geo_target_type, campaign.geo_target_type_setting.negative_geo_target_type FROM campaign WHERE campaign.id = ${id}`,
	);
	const c = rows[0]?.campaign;
	if (!c) throw new Error(`La campaña ${id} no existe en la cuenta ${cid}.`);
	return {
		resourceName: c.resourceName,
		id: String(c.id),
		name: c.name,
		status: c.status,
		channelType: c.advertisingChannelType,
		budgetResourceName: c.campaignBudget,
		positiveGeoTargetType: c.geoTargetTypeSetting?.positiveGeoTargetType,
		negativeGeoTargetType: c.geoTargetTypeSetting?.negativeGeoTargetType,
	};
}

export interface GeoConstant {
	resourceName: string;
	countryCode: string;
	name: string;
}

/** Resuelve códigos ISO de país a geoTargetConstants mediante la API (no hay tabla local). */
export async function resolveCountries(client: GoogleAdsClient, cid: string, codes: string[]): Promise<GeoConstant[]> {
	const wanted = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
	if (!wanted.length) return [];
	for (const c of wanted) if (!/^[A-Z]{2}$/.test(c)) throw new Error(`Código de país inválido: "${c}" (usa ISO 3166-1 alfa-2, p. ej. AE, SG).`);
	const rows = await client.searchAll(
		cid,
		`SELECT geo_target_constant.resource_name, geo_target_constant.country_code, geo_target_constant.name, geo_target_constant.target_type, geo_target_constant.status FROM geo_target_constant WHERE geo_target_constant.country_code IN (${wanted.map(gaqlString).join(", ")}) AND geo_target_constant.target_type = 'Country' AND geo_target_constant.status = 'ENABLED'`,
	);
	const found = new Map<string, GeoConstant>();
	for (const r of rows) {
		const g = r.geoTargetConstant;
		found.set(g.countryCode, { resourceName: g.resourceName, countryCode: g.countryCode, name: g.name });
	}
	const missing = wanted.filter((c) => !found.has(c));
	if (missing.length) throw new Error(`La API no devuelve geoTargetConstant de tipo Country para: ${missing.join(", ")}.`);
	return wanted.map((c) => found.get(c)!);
}

export async function resolveLanguages(client: GoogleAdsClient, cid: string, codes: string[]): Promise<{ resourceName: string; code: string; name: string }[]> {
	const wanted = [...new Set(codes.map((c) => c.trim().toLowerCase()).filter(Boolean))];
	if (!wanted.length) return [];
	const rows = await client.searchAll(
		cid,
		`SELECT language_constant.resource_name, language_constant.code, language_constant.name FROM language_constant WHERE language_constant.code IN (${wanted.map(gaqlString).join(", ")})`,
	);
	const found = new Map<string, any>();
	for (const r of rows) found.set(r.languageConstant.code, r.languageConstant);
	const missing = wanted.filter((c) => !found.has(c));
	if (missing.length) throw new Error(`Idiomas no encontrados en language_constant: ${missing.join(", ")}.`);
	return wanted.map((c) => ({ resourceName: found.get(c).resourceName, code: c, name: found.get(c).name }));
}

function pct(from: number, to: number): string {
	if (!from) return "n/a";
	const p = ((to - from) / from) * 100;
	return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

/* ------------------------------------------------------- status */

export async function buildCampaignStatusPlan(client: GoogleAdsClient, cid: string, campaignId: string, status: "ENABLED" | "PAUSED"): Promise<PlanDraft> {
	const c = await getCampaign(client, cid, campaignId);
	if (c.status === status) throw new Error(`La campaña "${c.name}" ya está en ${status}. No hay nada que cambiar.`);
	if (c.status === "REMOVED") throw new Error(`La campaña "${c.name}" está eliminada; no se puede cambiar.`);
	const warnings: string[] = [];
	if (status === "ENABLED") {
		warnings.push("ACTIVACIÓN: la campaña empezará a gastar en cuanto se aplique el plan.");
		warnings.push(...(await trackingParamGaps(client, cid, c.id, c.channelType)));
	}
	return {
		kind: "update_campaign_status",
		customerId: cid,
		summary: [`Campaña "${c.name}" (${c.id}, ${c.channelType}): status ${c.status} → ${status}`],
		warnings,
		operations: [{ campaignOperation: { update: { resourceName: c.resourceName, status }, updateMask: "status" } }],
		stateQueries: [`SELECT campaign.resource_name, campaign.status FROM campaign WHERE campaign.id = ${c.id}`],
		guardFlags: { allowCampaignEnable: status === "ENABLED" },
	};
}

/**
 * Parámetros {_clave} que usan la plantilla de seguimiento o el sufijo de URL de la cuenta y que la campaña
 * (o alguno de sus grupos activos) no define: ese dato llegaría vacío a la analítica o al CRM.
 * {_adgroupname} se busca en los grupos; Performance Max no tiene grupos de anuncios y se omite.
 */
export async function trackingParamGaps(client: GoogleAdsClient, cid: string, campaignId: string, channelType: string): Promise<string[]> {
	const tpl = ((await client.searchAll(cid, "SELECT customer.tracking_url_template, customer.final_url_suffix FROM customer"))[0]?.customer ?? {}) as Json;
	const keys = [...new Set([...`${tpl.trackingUrlTemplate ?? ""} ${tpl.finalUrlSuffix ?? ""}`.matchAll(/\{_([A-Za-z0-9]+)\}/g)].map((m) => m[1]))];
	if (!keys.length) return [];
	const params = (list: Json[] | undefined) => new Set((list ?? []).map((p) => String(p.key)));
	const camp = (await client.searchAll(cid, `SELECT campaign.url_custom_parameters FROM campaign WHERE campaign.id = ${campaignId}`))[0]?.campaign;
	const campKeys = params(camp?.urlCustomParameters);
	const out: string[] = [];
	const agKeys = keys.filter((k) => /^ad_?group_?name$/i.test(k));
	const missingCamp = keys.filter((k) => !agKeys.includes(k) && !campKeys.has(k));
	if (missingCamp.length) out.push(`SEGUIMIENTO: la cuenta usa {_${missingCamp.join("}, {_")}} y la campaña no lo define: llegará vacío.`);
	if (agKeys.length && channelType !== "PERFORMANCE_MAX") {
		const groups = await client.searchAll(
			cid,
			`SELECT ad_group.name, ad_group.url_custom_parameters FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.status = 'ENABLED'`,
		);
		const missing = groups.filter((g) => agKeys.some((k) => !params(g.adGroup?.urlCustomParameters).has(k) && !campKeys.has(k))).map((g) => g.adGroup?.name);
		if (missing.length) out.push(`SEGUIMIENTO: la cuenta usa {_${agKeys.join("}, {_")}} y estos grupos no lo definen: ${missing.join(", ")}. Llegará vacío.`);
	}
	return out;
}

/* ------------------------------------------------------- budget */

export async function buildCampaignBudgetPlan(
	client: GoogleAdsClient,
	cid: string,
	campaignId: string,
	newDailyAmount: number,
	allowSharedBudget = false,
): Promise<PlanDraft> {
	const id = assertId(campaignId, "campaign_id");
	const currency = await getCurrency(client, cid);
	const rows = await client.searchAll(
		cid,
		`SELECT campaign.id, campaign.name, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count, campaign_budget.name FROM campaign WHERE campaign.id = ${id}`,
	);
	const row = rows[0];
	if (!row) throw new Error(`La campaña ${id} no existe en ${cid}.`);
	const b = row.campaignBudget;
	const current = Number(b.amountMicros);
	const next = toMicros(newDailyAmount);
	const shared = Boolean(b.explicitlyShared) || Number(b.referenceCount ?? 1) > 1;
	if (shared && !allowSharedBudget) {
		throw new Error(
			`El presupuesto "${b.name}" es COMPARTIDO (${b.referenceCount} campañas). Cambiarlo afecta a todas. No se ha creado plan. Repite con allow_shared_budget=true si es intencionado.`,
		);
	}
	if (current === next) throw new Error(`El presupuesto ya es ${fromMicros(current).toFixed(2)} ${currency}.`);
	const warnings: string[] = [];
	if (shared) warnings.push(`Presupuesto compartido por ${b.referenceCount} campañas: el cambio les afecta a todas.`);
	return {
		kind: "update_campaign_budget",
		customerId: cid,
		summary: [
			`Campaña "${row.campaign.name}" (${row.campaign.id})`,
			`Presupuesto diario (${b.resourceName}): ${fromMicros(current).toFixed(2)} ${currency} → ${fromMicros(next).toFixed(2)} ${currency} (${pct(current, next)})`,
		],
		warnings,
		operations: [{ campaignBudgetOperation: { update: { resourceName: b.resourceName, amountMicros: String(next) }, updateMask: "amount_micros" } }],
		stateQueries: [
			`SELECT campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign_budget WHERE campaign_budget.resource_name = '${b.resourceName}'`,
			// Si la campaña cambia de presupuesto entre el plan y el apply, no se toca el presupuesto antiguo.
			`SELECT campaign.resource_name, campaign.campaign_budget FROM campaign WHERE campaign.id = ${row.campaign.id}`,
		],
		guardFlags: { allowSharedBudget },
	};
}

/* ------------------------------------------------------- geo */

export async function buildGeoTargetingPlan(
	client: GoogleAdsClient,
	cid: string,
	campaignId: string,
	params: { include_country_codes?: string[]; exclude_country_codes?: string[]; geo_target_type?: "PRESENCE" | "PRESENCE_OR_INTEREST"; replace_includes?: boolean },
): Promise<PlanDraft> {
	const c = await getCampaign(client, cid, campaignId);
	const include = await resolveCountries(client, cid, params.include_country_codes ?? []);
	const exclude = await resolveCountries(client, cid, params.exclude_country_codes ?? []);
	if (c.channelType === "DEMAND_GEN" && (include.length || exclude.length)) {
		const dg = await client.searchAll(cid, `SELECT campaign.demand_gen_campaign_settings.upgraded_targeting FROM campaign WHERE campaign.id = ${c.id}`);
		if (dg[0]?.campaign?.demandGenCampaignSettings?.upgradedTargeting) {
			// Verificado contra la API (Neurored, 02-10-2026): el criterio de ubicación de campaña falla con requestError.UNKNOWN.
			throw new Error(
				`La campaña Demand Gen "${c.name}" segmenta países e idiomas por grupo de anuncios (upgraded targeting): no admite ubicaciones a nivel de campaña. Usa plan_generic_mutate con adGroupCriterionOperation {create:{adGroup, location:{geoTargetConstant}}} en cada grupo. La opción de ubicación (geo_target_type) sí se puede cambiar aquí, sin países.`,
			);
		}
	}
	const overlap = include.filter((i) => exclude.some((e) => e.resourceName === i.resourceName));
	if (overlap.length) throw new Error(`Un país no puede estar incluido y excluido a la vez: ${overlap.map((o) => o.countryCode).join(", ")}.`);

	const critQuery = `SELECT campaign_criterion.resource_name, campaign_criterion.negative, campaign_criterion.location.geo_target_constant FROM campaign_criterion WHERE campaign.id = ${c.id} AND campaign_criterion.type = 'LOCATION' AND campaign_criterion.status != 'REMOVED'`;
	const existing = (await client.searchAll(cid, critQuery)).map((r) => ({
		resourceName: r.campaignCriterion.resourceName as string,
		negative: Boolean(r.campaignCriterion.negative),
		geo: r.campaignCriterion.location?.geoTargetConstant as string,
	}));
	const byGeo = new Map(existing.map((e) => [e.geo, e]));

	const removes: Json[] = [];
	const creates: Json[] = [];
	const summary: string[] = [`Campaña "${c.name}" (${c.id}, ${c.channelType})`];
	const warnings: string[] = [];
	const removed = new Set<string>();

	const before = {
		inc: existing.filter((e) => !e.negative).map((e) => e.geo),
		exc: existing.filter((e) => e.negative).map((e) => e.geo),
	};

	for (const g of include) {
		const ex = byGeo.get(g.resourceName);
		if (ex && !ex.negative) continue;
		if (ex && ex.negative) {
			removes.push({ campaignCriterionOperation: { remove: ex.resourceName } });
			removed.add(ex.resourceName);
			summary.push(`- Quitar exclusión de ${g.name} (${g.countryCode})`);
		}
		creates.push({ campaignCriterionOperation: { create: { campaign: c.resourceName, negative: false, location: { geoTargetConstant: g.resourceName } } } });
		summary.push(`+ Incluir ${g.name} (${g.countryCode})`);
	}
	for (const g of exclude) {
		const ex = byGeo.get(g.resourceName);
		if (ex && ex.negative) continue;
		if (ex && !ex.negative) {
			removes.push({ campaignCriterionOperation: { remove: ex.resourceName } });
			removed.add(ex.resourceName);
			summary.push(`- Quitar inclusión de ${g.name} (${g.countryCode})`);
		}
		creates.push({ campaignCriterionOperation: { create: { campaign: c.resourceName, negative: true, location: { geoTargetConstant: g.resourceName } } } });
		summary.push(`+ Excluir ${g.name} (${g.countryCode})`);
	}
	if (params.replace_includes) {
		const keep = new Set(include.map((i) => i.resourceName));
		for (const e of existing) {
			if (!e.negative && !keep.has(e.geo) && !removed.has(e.resourceName)) {
				removes.push({ campaignCriterionOperation: { remove: e.resourceName } });
				summary.push(`- Quitar inclusión de ${e.geo}`);
			}
		}
		if (!include.length) warnings.push("replace_includes sin países incluidos: la campaña quedaría con segmentación a todo el mundo.");
	}

	const ops: Json[] = [...removes, ...creates];
	if (params.geo_target_type && params.geo_target_type !== c.positiveGeoTargetType) {
		ops.push({
			campaignOperation: {
				update: { resourceName: c.resourceName, geoTargetTypeSetting: { positiveGeoTargetType: params.geo_target_type } },
				updateMask: "geo_target_type_setting.positive_geo_target_type",
			},
		});
		summary.push(`Opción de ubicación (positive_geo_target_type): ${c.positiveGeoTargetType ?? "?"} → ${params.geo_target_type}`);
	}
	if (!ops.length) throw new Error("No hay cambios: la segmentación ya coincide con lo pedido.");

	const afterInc = new Set(before.inc);
	const afterExc = new Set(before.exc);
	for (const g of include) {
		afterInc.add(g.resourceName);
		afterExc.delete(g.resourceName);
	}
	for (const g of exclude) {
		afterExc.add(g.resourceName);
		afterInc.delete(g.resourceName);
	}
	if (params.replace_includes) for (const g of [...afterInc]) if (!include.some((i) => i.resourceName === g)) afterInc.delete(g);
	summary.push(`ANTES  incluidos: ${before.inc.length ? before.inc.join(", ") : "(todo el mundo)"} | excluidos: ${before.exc.join(", ") || "(ninguno)"}`);
	summary.push(`DESPUÉS incluidos: ${[...afterInc].join(", ") || "(todo el mundo)"} | excluidos: ${[...afterExc].join(", ") || "(ninguno)"}`);

	return {
		kind: "set_geo_targeting",
		customerId: cid,
		summary,
		warnings,
		operations: ops,
		stateQueries: [
			critQuery,
			`SELECT campaign.resource_name, campaign.geo_target_type_setting.positive_geo_target_type FROM campaign WHERE campaign.id = ${c.id}`,
		],
	};
}

/* ------------------------------------------------------- negative keywords */

export async function buildNegativeKeywordsPlan(
	client: GoogleAdsClient,
	cid: string,
	campaignId: string,
	keywords: string[],
	matchType: "EXACT" | "PHRASE" | "BROAD",
): Promise<PlanDraft> {
	const c = await getCampaign(client, cid, campaignId);
	const q = `SELECT campaign_criterion.resource_name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign.id = ${c.id} AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE`;
	const existing = new Set((await client.searchAll(cid, q)).map((r) => `${r.campaignCriterion.keyword.text.toLowerCase()}|${r.campaignCriterion.keyword.matchType}`));
	const clean = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))];
	const toAdd = clean.filter((k) => !existing.has(`${k.toLowerCase()}|${matchType}`));
	if (!toAdd.length) throw new Error("Todas las keywords negativas ya existen en la campaña.");
	const skipped = clean.filter((k) => !toAdd.includes(k));

	// ¿La negativa bloquea keywords positivas activas de la propia campaña? (visto en real: 3 exactas bloqueadas)
	const posQ = `SELECT ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM keyword_view WHERE campaign.id = ${c.id} AND ad_group_criterion.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_criterion.negative != TRUE`;
	const positives = (await client.searchAll(cid, posQ)).map((r) => ({
		adGroup: String(r.adGroup?.name ?? ""),
		text: String(r.adGroupCriterion?.keyword?.text ?? ""),
		matchType: String(r.adGroupCriterion?.keyword?.matchType ?? ""),
	}));
	const conflicts: string[] = [];
	for (const neg of toAdd) {
		const hits = positives.filter((p) => negativeBlocks(neg, matchType, p.text));
		for (const h of hits) conflicts.push(`"${neg}" (${matchType}) bloquea la keyword activa "${h.text}" (${h.matchType}) del grupo "${h.adGroup}"`);
	}
	return {
		kind: "add_negative_keywords",
		customerId: cid,
		summary: [`Campaña "${c.name}" (${c.id})`, ...toAdd.map((k) => `+ Negativa ${matchType}: ${k}`)],
		warnings: skipped.length ? [`Ya existían (se omiten): ${skipped.join(", ")}`] : [],
		elevated: conflicts.length ? [`Negativas que bloquean keywords positivas activas de la campaña (si lo que quieres es dejar de pujar por ellas, pausarlas es más limpio): ${conflicts.join("; ")}`] : [],
		operations: toAdd.map((text) => ({ campaignCriterionOperation: { create: { campaign: c.resourceName, negative: true, keyword: { text, matchType } } } })),
		stateQueries: [q],
	};
}

const words = (s: string) => s.toLowerCase().replace(/[+"[\]]/g, " ").split(/\s+/).filter(Boolean);

/** ¿La negativa (texto + concordancia) impide que la búsqueda igual al texto de la keyword positiva active anuncios? */
export function negativeBlocks(negative: string, matchType: "EXACT" | "PHRASE" | "BROAD", positiveText: string): boolean {
	const n = words(negative);
	const p = words(positiveText);
	if (!n.length || !p.length) return false;
	if (matchType === "EXACT") return n.join(" ") === p.join(" ");
	if (matchType === "PHRASE") return ` ${p.join(" ")} `.includes(` ${n.join(" ")} `);
	return n.every((w) => p.includes(w));
}

/* ------------------------------------------------------- placements */

export function parsePlacement(p: string): Json {
	const s = p.trim();
	const ch = s.match(/youtube\.com\/channel\/(UC[\w-]{22})/i);
	if (ch) return { youtubeChannel: { channelId: ch[1] } };
	const vid = s.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/i);
	if (vid) return { youtubeVideo: { videoId: vid[1] } };
	if (!/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(s.replace(/^https?:\/\//, ""))) {
		throw new Error(`Placement no reconocido: "${p}". Usa un dominio (ejemplo.com), una URL de canal (youtube.com/channel/UC...) o de vídeo de YouTube.`);
	}
	return { placement: { url: s.replace(/^https?:\/\//, "").replace(/\/$/, "") } };
}

function placementKey(c: Json): string {
	if (c.youtubeChannel) return `yc:${c.youtubeChannel.channelId}`;
	if (c.youtubeVideo) return `yv:${c.youtubeVideo.videoId}`;
	return `pl:${String(c.placement?.url ?? "").toLowerCase()}`;
}

export async function buildExcludePlacementsPlan(
	client: GoogleAdsClient,
	cid: string,
	scope: "campaign" | "account",
	placements: string[],
	campaignId?: string,
): Promise<PlanDraft> {
	const parsed = [...new Map(placements.map((p) => parsePlacement(p)).map((c) => [placementKey(c), c])).values()];
	if (!parsed.length) throw new Error("No hay placements.");
	if (scope === "campaign") {
		if (!campaignId) throw new Error("scope=campaign requiere campaign_id.");
		const c = await getCampaign(client, cid, campaignId);
		if (c.channelType === "PERFORMANCE_MAX") {
			// Verificado contra la API: OPERATION_NOT_PERMITTED_FOR_CONTEXT en campaign_criterion.placement para PMax.
			throw new Error("Performance Max no admite exclusiones de placement a nivel de campaña. Usa scope=\"account\" (se aplican también a PMax).");
		}
		const q = `SELECT campaign_criterion.resource_name, campaign_criterion.placement.url, campaign_criterion.youtube_channel.channel_id, campaign_criterion.youtube_video.video_id FROM campaign_criterion WHERE campaign.id = ${c.id} AND campaign_criterion.negative = TRUE AND campaign_criterion.type IN ('PLACEMENT', 'YOUTUBE_CHANNEL', 'YOUTUBE_VIDEO')`;
		const existing = new Set((await client.searchAll(cid, q)).map((r) => placementKey(r.campaignCriterion)));
		const toAdd = parsed.filter((p) => !existing.has(placementKey(p)));
		if (!toAdd.length) throw new Error("Todos los placements ya están excluidos en la campaña.");
		return {
			kind: "exclude_placements",
			customerId: cid,
			summary: [`Campaña "${c.name}" (${c.id})`, ...toAdd.map((p) => `+ Excluir ${JSON.stringify(p)}`)],
			operations: toAdd.map((p) => ({ campaignCriterionOperation: { create: { campaign: c.resourceName, negative: true, ...p } } })),
			stateQueries: [q],
		};
	}
	const q = `SELECT customer_negative_criterion.resource_name, customer_negative_criterion.placement.url, customer_negative_criterion.youtube_channel.channel_id, customer_negative_criterion.youtube_video.video_id FROM customer_negative_criterion`;
	const existing = new Set((await client.searchAll(cid, q)).map((r) => placementKey(r.customerNegativeCriterion)));
	const toAdd = parsed.filter((p) => !existing.has(placementKey(p)));
	if (!toAdd.length) throw new Error("Todos los placements ya están excluidos a nivel de cuenta.");
	return {
		kind: "exclude_placements",
		customerId: cid,
		summary: [`Cuenta ${cid} (exclusión a nivel de cuenta)`, ...toAdd.map((p) => `+ Excluir ${JSON.stringify(p)}`)],
		operations: toAdd.map((p) => ({ customerNegativeCriterionOperation: { create: { ...p } } })),
		stateQueries: [q],
	};
}

/* ------------------------------------------------------- custom audience */

export function customAudienceBody(name: string, searchTerms: string[], urls: string[] = []): Json {
	const terms = [...new Set(searchTerms.map((s) => s.trim()).filter(Boolean))];
	// Un dominio suelto ("aparcand.com") se acepta como https://aparcand.com (visto en uso real).
	const cleanUrls = [...new Set(urls.map((s) => s.trim()).filter(Boolean).map((u) => (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(u) ? `https://${u}` : u)))];
	if (!terms.length && !cleanUrls.length) throw new Error("El segmento personalizado necesita al menos una búsqueda o una URL.");
	for (const t of terms) if (t.length > 80 || t.split(/\s+/).length > 10) throw new Error(`Término demasiado largo (máx. 10 palabras / 80 caracteres): "${t}"`);
	for (const u of cleanUrls) if (!/^https?:\/\//.test(u)) throw new Error(`URL sin protocolo: "${u}" (usa https://...)`);
	return {
		name,
		// SEARCH = "personas que han buscado cualquiera de estos términos en Google". Con URLs se usa AUTO.
		type: cleanUrls.length ? "AUTO" : "SEARCH",
		description: "Creado por mycontent-google-ads-mcp",
		members: [...terms.map((keyword) => ({ memberType: "KEYWORD", keyword })), ...cleanUrls.map((url) => ({ memberType: "URL", url }))],
	};
}

export function customAudienceStateQuery(name: string) {
	return `SELECT custom_audience.resource_name, custom_audience.name, custom_audience.status FROM custom_audience WHERE custom_audience.name = ${gaqlString(name)}`;
}

export async function assertCustomAudienceNameFree(client: GoogleAdsClient, cid: string, name: string) {
	const rows = await client.searchAll(cid, customAudienceStateQuery(name));
	if (rows.length) throw new Error(`Ya existe un segmento personalizado llamado "${name}" (${rows[0].customAudience.resourceName}). Usa otro nombre o reutiliza ese resource name.`);
}

export async function buildCustomAudiencePlan(client: GoogleAdsClient, cid: string, name: string, searchTerms: string[], urls: string[] = []): Promise<PlanDraft> {
	await assertCustomAudienceNameFree(client, cid, name);
	const body = customAudienceBody(name, searchTerms, urls);
	return {
		kind: "create_custom_audience",
		customerId: cid,
		summary: [
			`(no existe) → Segmento personalizado "${name}" tipo ${body.type}`,
			...body.members.map((m: Json) => `  · ${m.memberType}: ${m.keyword ?? m.url}`),
		],
		// CustomAudienceService va por su propio endpoint (customAudiences:mutate), no por GoogleAdsService.Mutate.
		preSteps: [{ service: "customAudiences", placeholder: `customers/${cid}/customAudiences/-1`, operation: { create: body } }],
		operations: [],
		stateQueries: [customAudienceStateQuery(name)],
	};
}
