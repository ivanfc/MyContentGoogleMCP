import { type FetchLike, type GoogleAdsClient, type Json, assertDate, gaqlString } from "../ads/client";
import { toMicros } from "../config";
import { getCampaignAssets } from "./assets";
import { assertCustomAudienceNameFree, customAudienceBody, customAudienceStateQuery, getCurrency, resolveCountries, resolveLanguages } from "./builders";
import type { PlanDraft } from "./engine";

export const DG_CHANNELS = ["DISCOVER", "GMAIL", "DISPLAY", "YOUTUBE_IN_FEED", "YOUTUBE_IN_STREAM", "YOUTUBE_SHORTS", "MAPS"] as const;
export type DgChannel = (typeof DG_CHANNELS)[number];

/** Nombres exactos de DemandGenAdGroupSettings.DemandGenChannelControls.DemandGenSelectedChannels (v25). */
const CHANNEL_FIELD: Record<DgChannel, string> = {
	DISCOVER: "discover",
	GMAIL: "gmail",
	DISPLAY: "display",
	YOUTUBE_IN_FEED: "youtubeInFeed",
	YOUTUBE_IN_STREAM: "youtubeInStream",
	YOUTUBE_SHORTS: "youtubeShorts",
	MAPS: "maps",
};

export type ImageKind = "MARKETING" | "SQUARE" | "PORTRAIT" | "TALL_PORTRAIT" | "LOGO";

export interface DgAdInput {
	name?: string;
	final_url: string;
	headlines?: string[];
	descriptions?: string[];
	business_name?: string;
	call_to_action?: string;
	logo_assets?: string[];
	marketing_image_assets?: string[];
	square_marketing_image_assets?: string[];
	portrait_marketing_image_assets?: string[];
	tall_portrait_marketing_image_assets?: string[];
	image_urls?: { url: string; kind: ImageKind }[];
}

export interface DgAdGroupInput {
	name: string;
	country_codes?: string[];
	language_codes?: string[];
	custom_audience_keys?: string[];
	custom_audience_resource_names?: string[];
	user_list_resource_names?: string[];
	ads: DgAdInput[];
}

export interface DemandGenInput {
	name: string;
	daily_budget: number;
	bidding_strategy: "MAXIMIZE_CONVERSIONS" | "MAXIMIZE_CLICKS";
	target_cpa?: number;
	conversion_goal_category?: string;
	restrict_to_conversion_goal?: boolean;
	country_codes: string[];
	geo_target_type: "PRESENCE" | "PRESENCE_OR_INTEREST";
	language_codes?: string[];
	channels: DgChannel[];
	start_date?: string;
	end_date?: string;
	reuse_assets_from_campaign_id?: string;
	new_custom_audiences?: { key: string; name: string; search_terms: string[]; urls?: string[] }[];
	ad_groups: DgAdGroupInput[];
}

export type AudienceMode = "CUSTOM_AUDIENCE_CRITERION" | "AUDIENCE_RESOURCE";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

async function downloadImage(fetchImpl: FetchLike, url: string): Promise<string> {
	if (!/^https:\/\//.test(url)) throw new Error(`La URL de imagen debe ser https: ${url}`);
	const res = await fetchImpl(url);
	if (!res.ok) throw new Error(`No se pudo descargar la imagen ${url}: HTTP ${res.status}`);
	const buf = new Uint8Array(await res.arrayBuffer());
	if (buf.length > MAX_IMAGE_BYTES) throw new Error(`La imagen ${url} pesa ${buf.length} bytes (máx. 5 MB).`);
	return toBase64(buf);
}

/** Valida y construye el plan completo de Demand Gen en un único mutate atómico con IDs temporales. */
export async function buildDemandGenPlan(
	client: GoogleAdsClient,
	cid: string,
	input: DemandGenInput,
	mode: AudienceMode,
	fetchImpl: FetchLike = (u, i) => fetch(u, i),
): Promise<PlanDraft> {
	// ---------- validaciones locales
	if (!input.name?.trim()) throw new Error("Falta el nombre de la campaña.");
	if (!input.channels?.length) throw new Error("Indica al menos un canal (p. ej. DISCOVER, GMAIL).");
	for (const ch of input.channels) if (!DG_CHANNELS.includes(ch)) throw new Error(`Canal desconocido: ${ch}. Válidos: ${DG_CHANNELS.join(", ")}`);
	if (!input.ad_groups?.length) throw new Error("Hace falta al menos un grupo de anuncios.");
	if (input.start_date) assertDate(input.start_date, "start_date");
	if (input.end_date) assertDate(input.end_date, "end_date");
	if (input.target_cpa !== undefined && input.bidding_strategy !== "MAXIMIZE_CONVERSIONS") throw new Error("target_cpa solo aplica con MAXIMIZE_CONVERSIONS.");

	const currency = await getCurrency(client, cid);
	const summary: string[] = [];
	const warnings: string[] = [];
	const stateQueries: string[] = [];
	const ops: Json[] = [];
	let tmp = 0;
	const nextTmp = () => --tmp;
	const rn = (collection: string, id: number) => `customers/${cid}/${collection}/${id}`;

	// ---------- unicidad del nombre
	const nameQuery = `SELECT campaign.resource_name, campaign.name FROM campaign WHERE campaign.name = ${gaqlString(input.name)} AND campaign.status != 'REMOVED'`;
	if ((await client.searchAll(cid, nameQuery)).length) throw new Error(`Ya existe una campaña llamada "${input.name}".`);
	stateQueries.push(nameQuery);

	// ---------- objetivo de conversión (solo lectura; nunca se crean acciones de conversión)
	const goalCategory = input.conversion_goal_category ?? (input.bidding_strategy === "MAXIMIZE_CONVERSIONS" ? "SUBMIT_LEAD_FORM" : undefined);
	const goalQuery = "SELECT customer_conversion_goal.category, customer_conversion_goal.origin, customer_conversion_goal.biddable FROM customer_conversion_goal";
	const goals = (await client.searchAll(cid, goalQuery)).map((r) => r.customerConversionGoal as Json);
	if (goalCategory) {
		const matching = goals.filter((g) => g.category === goalCategory);
		if (!matching.length) {
			throw new Error(`La cuenta no tiene ningún objetivo de conversión de categoría ${goalCategory}. Categorías existentes: ${[...new Set(goals.map((g) => g.category))].join(", ")}.`);
		}
		const biddable = goals.filter((g) => g.biddable).map((g) => `${g.category}/${g.origin}`);
		if (!matching.some((g) => g.biddable) && !input.restrict_to_conversion_goal) {
			throw new Error(
				`El objetivo ${goalCategory} existe pero no es "biddable" (objetivo de cuenta por defecto). Objetivos de cuenta actuales: ${biddable.join(", ") || "ninguno"}. Activa restrict_to_conversion_goal=true o cambia el objetivo por defecto en la UI.`,
			);
		}
		stateQueries.push(goalQuery);
		if (input.restrict_to_conversion_goal) {
			summary.push(`Objetivo de conversión de campaña: SOLO ${goalCategory} (experimental: campaignConversionGoal con ID temporal)`);
		} else {
			summary.push(`Objetivo de conversión: objetivos por defecto de la cuenta (${biddable.join(", ")}). Incluye ${goalCategory}.`);
			const others = biddable.filter((b) => !b.startsWith(`${goalCategory}/`));
			if (others.length) warnings.push(`La campaña también optimizará hacia otros objetivos de cuenta biddable: ${others.join(", ")}. Si quieres solo ${goalCategory}, usa restrict_to_conversion_goal=true.`);
		}
	}

	// ---------- geo e idiomas (se resuelven por API)
	const campaignCountries = await resolveCountries(client, cid, input.country_codes ?? []);
	const campaignLangs = await resolveLanguages(client, cid, input.language_codes ?? []);

	// ---------- assets reutilizados
	const reuse = input.reuse_assets_from_campaign_id ? await getCampaignAssets(client, cid, input.reuse_assets_from_campaign_id) : undefined;
	if (reuse) summary.push(`Assets reutilizados de "${reuse.campaign.name}" (${reuse.campaign.id}, ${reuse.campaign.type})`);
	const pick = (ft: string, n: number, filter: (a: Json) => boolean = () => true) => (reuse?.byFieldType[ft] ?? []).filter(filter).slice(0, n);

	// ---------- presupuesto
	const budgetMicros = toMicros(input.daily_budget);
	const budgetRn = rn("campaignBudgets", nextTmp());
	ops.push({
		campaignBudgetOperation: {
			create: { resourceName: budgetRn, name: `${input.name} budget`, amountMicros: String(budgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false },
		},
	});

	// ---------- campaña
	const campaignRn = rn("campaigns", nextTmp());
	const bidding: Json =
		input.bidding_strategy === "MAXIMIZE_CLICKS"
			? { targetSpend: {} }
			: { maximizeConversions: input.target_cpa ? { targetCpaMicros: String(toMicros(input.target_cpa)) } : {} };
	ops.push({
		campaignOperation: {
			create: {
				resourceName: campaignRn,
				name: input.name,
				status: "PAUSED",
				advertisingChannelType: "DEMAND_GEN",
				campaignBudget: budgetRn,
				...bidding,
				geoTargetTypeSetting: { positiveGeoTargetType: input.geo_target_type, negativeGeoTargetType: "PRESENCE" },
				containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
				// upgradedTargeting=true: ubicación e idioma a nivel de grupo de anuncios (permite países distintos por grupo).
				demandGenCampaignSettings: { upgradedTargeting: true },
				...(input.start_date ? { startDateTime: `${input.start_date} 00:00:00` } : {}),
				...(input.end_date ? { endDateTime: `${input.end_date} 23:59:59` } : {}),
			},
		},
	});
	summary.push(
		`(no existe) → Campaña Demand Gen "${input.name}" en PAUSED`,
		`  Presupuesto diario: ${(budgetMicros / 1e6).toFixed(2)} ${currency} | Puja: ${input.bidding_strategy}${input.target_cpa ? ` (CPA objetivo ${input.target_cpa} ${currency})` : ""}`,
		`  Opción de ubicación: ${input.geo_target_type} | Canales: ${input.channels.join(", ")} (resto desactivados)`,
	);

	if (goalCategory && input.restrict_to_conversion_goal) {
		const campaignTmpId = campaignRn.split("/").pop();
		for (const g of goals) {
			ops.push({
				campaignConversionGoalOperation: {
					update: { resourceName: `customers/${cid}/campaignConversionGoals/${campaignTmpId}~${g.category}~${g.origin}`, biddable: g.category === goalCategory },
					updateMask: "biddable",
				},
			});
		}
	}

	// ---------- segmentos personalizados nuevos
	const audienceByKey = new Map<string, string>();
	for (const ca of input.new_custom_audiences ?? []) {
		await assertCustomAudienceNameFree(client, cid, ca.name);
		const caRn = rn("customAudiences", nextTmp());
		const body = customAudienceBody(ca.name, ca.search_terms, ca.urls ?? [], caRn);
		ops.push({ customAudienceOperation: { create: body } });
		audienceByKey.set(ca.key, caRn);
		stateQueries.push(customAudienceStateQuery(ca.name));
		summary.push(`(no existe) → Segmento personalizado "${ca.name}" (${body.type}): ${body.members.map((m: Json) => m.keyword ?? m.url).join(" | ")}`);
	}

	const selectedChannels: Json = {};
	for (const ch of DG_CHANNELS) selectedChannels[CHANNEL_FIELD[ch]] = input.channels.includes(ch);

	// ---------- grupos de anuncios
	for (const ag of input.ad_groups) {
		if (!ag.name?.trim()) throw new Error("Cada grupo de anuncios necesita nombre.");
		if (!ag.ads?.length) throw new Error(`El grupo "${ag.name}" no tiene anuncios.`);
		const agRn = rn("adGroups", nextTmp());
		ops.push({
			adGroupOperation: {
				create: {
					resourceName: agRn,
					campaign: campaignRn,
					name: ag.name,
					status: "ENABLED",
					demandGenAdGroupSettings: { channelControls: { selectedChannels } },
				},
			},
		});
		const countries = ag.country_codes?.length ? await resolveCountries(client, cid, ag.country_codes) : campaignCountries;
		const langs = ag.language_codes?.length ? await resolveLanguages(client, cid, ag.language_codes) : campaignLangs;
		if (!countries.length) warnings.push(`El grupo "${ag.name}" no tiene países: se segmentará a todo el mundo.`);
		for (const g of countries) ops.push({ adGroupCriterionOperation: { create: { adGroup: agRn, status: "ENABLED", location: { geoTargetConstant: g.resourceName } } } });
		for (const l of langs) ops.push({ adGroupCriterionOperation: { create: { adGroup: agRn, status: "ENABLED", language: { languageConstant: l.resourceName } } } });

		const caRns = [
			...(ag.custom_audience_resource_names ?? []),
			...(ag.custom_audience_keys ?? []).map((k) => {
				const r = audienceByKey.get(k);
				if (!r) throw new Error(`custom_audience_key "${k}" no está definido en new_custom_audiences.`);
				return r;
			}),
		];
		const userLists = ag.user_list_resource_names ?? [];
		if (caRns.length || userLists.length) {
			if (mode === "CUSTOM_AUDIENCE_CRITERION") {
				for (const r of caRns) ops.push({ adGroupCriterionOperation: { create: { adGroup: agRn, status: "ENABLED", customAudience: { customAudience: r } } } });
				for (const r of userLists) ops.push({ adGroupCriterionOperation: { create: { adGroup: agRn, status: "ENABLED", userList: { userList: r } } } });
			} else {
				const audRn = rn("audiences", nextTmp());
				ops.push({
					audienceOperation: {
						create: {
							resourceName: audRn,
							name: `${input.name} | ${ag.name}`,
							dimensions: [
								{ audienceSegments: { segments: [...caRns.map((r) => ({ customAudience: { customAudience: r } })), ...userLists.map((r) => ({ userList: { userList: r } }))] } },
							],
						},
					},
				});
				ops.push({ adGroupCriterionOperation: { create: { adGroup: agRn, status: "ENABLED", audience: { audience: audRn } } } });
			}
		}
		summary.push(
			`  Grupo "${ag.name}": países ${countries.map((c) => c.countryCode).join(", ") || "todos"} | idiomas ${langs.map((l) => l.code).join(", ") || "todos"} | audiencias ${caRns.length + userLists.length} (${mode})`,
		);

		// ---------- anuncios
		for (const [i, ad] of ag.ads.entries()) {
			if (!/^https:\/\//.test(ad.final_url ?? "")) throw new Error(`Anuncio ${i + 1} de "${ag.name}": final_url debe empezar por https://`);
			const headlines = ad.headlines?.length ? ad.headlines : pick("HEADLINE", 5, (a) => (a.text ?? "").length <= 30).map((a) => a.text!);
			const descriptions = ad.descriptions?.length ? ad.descriptions : pick("DESCRIPTION", 5, (a) => (a.text ?? "").length <= 90).map((a) => a.text!);
			const businessName = ad.business_name ?? pick("BUSINESS_NAME", 1)[0]?.text;
			const imgs: Record<ImageKind, string[]> = {
				LOGO: ad.logo_assets?.length ? ad.logo_assets : pick("LOGO", 5).map((a) => a.resourceName),
				MARKETING: ad.marketing_image_assets?.length ? ad.marketing_image_assets : pick("MARKETING_IMAGE", 5).map((a) => a.resourceName),
				SQUARE: ad.square_marketing_image_assets?.length ? ad.square_marketing_image_assets : pick("SQUARE_MARKETING_IMAGE", 5).map((a) => a.resourceName),
				PORTRAIT: ad.portrait_marketing_image_assets?.length ? ad.portrait_marketing_image_assets : pick("PORTRAIT_MARKETING_IMAGE", 5).map((a) => a.resourceName),
				TALL_PORTRAIT: ad.tall_portrait_marketing_image_assets?.length
					? ad.tall_portrait_marketing_image_assets
					: pick("TALL_PORTRAIT_MARKETING_IMAGE", 5).map((a) => a.resourceName),
			};
			for (const img of ad.image_urls ?? []) {
				const assetRn = rn("assets", nextTmp());
				const data = await downloadImage(fetchImpl, img.url);
				ops.push({ assetOperation: { create: { resourceName: assetRn, name: `${input.name} ${img.kind} ${Math.abs(tmp)}`, imageAsset: { data } } } });
				imgs[img.kind].push(assetRn);
				summary.push(`  (no existe) → Asset de imagen ${img.kind} desde ${img.url}`);
			}

			const problems: string[] = [];
			if (headlines.length < 1 || headlines.length > 5) problems.push(`titulares: ${headlines.length} (1-5)`);
			if (descriptions.length < 1 || descriptions.length > 5) problems.push(`descripciones: ${descriptions.length} (1-5)`);
			if (!businessName) problems.push("falta business_name");
			if (imgs.LOGO.length < 1 || imgs.LOGO.length > 5) problems.push(`logos: ${imgs.LOGO.length} (1-5)`);
			if (!imgs.MARKETING.length && !imgs.SQUARE.length) problems.push("hace falta al menos una imagen MARKETING (1.91:1) o SQUARE (1:1)");
			const totalImgs = imgs.MARKETING.length + imgs.SQUARE.length + imgs.PORTRAIT.length + imgs.TALL_PORTRAIT.length;
			if (totalImgs > 20) problems.push(`imágenes: ${totalImgs} (máx. 20 en total)`);
			if (problems.length) throw new Error(`Anuncio ${i + 1} de "${ag.name}" incompleto: ${problems.join("; ")}.`);

			const asImg = (l: string[]) => l.map((asset) => ({ asset }));
			ops.push({
				adGroupAdOperation: {
					create: {
						adGroup: agRn,
						status: "ENABLED",
						ad: {
							name: ad.name ?? `${ag.name} - multi-asset ${i + 1}`,
							finalUrls: [ad.final_url],
							demandGenMultiAssetAd: {
								headlines: headlines.map((text) => ({ text })),
								descriptions: descriptions.map((text) => ({ text })),
								businessName,
								logoImages: asImg(imgs.LOGO),
								...(imgs.MARKETING.length ? { marketingImages: asImg(imgs.MARKETING) } : {}),
								...(imgs.SQUARE.length ? { squareMarketingImages: asImg(imgs.SQUARE) } : {}),
								...(imgs.PORTRAIT.length ? { portraitMarketingImages: asImg(imgs.PORTRAIT) } : {}),
								...(imgs.TALL_PORTRAIT.length ? { tallPortraitMarketingImages: asImg(imgs.TALL_PORTRAIT) } : {}),
								...(ad.call_to_action ? { callToActionText: ad.call_to_action } : {}),
							},
						},
					},
				},
			});
			summary.push(
				`    Anuncio multi-imagen ${i + 1}: ${headlines.length} titulares, ${descriptions.length} descripciones, ${imgs.LOGO.length} logos, ${totalImgs} imágenes, negocio "${businessName}", URL ${ad.final_url}${ad.call_to_action ? `, CTA "${ad.call_to_action}"` : ""}`,
				`      Titulares: ${headlines.join(" | ")}`,
			);
		}
	}

	return { kind: "create_demand_gen_campaign", customerId: cid, summary, warnings, operations: ops, stateQueries };
}
