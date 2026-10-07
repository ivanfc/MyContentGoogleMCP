import { type GoogleAdsClient, type Json, assertDate, assertId } from "../ads/client";
import { type Limits, fromMicros, isWriteAllowed, normalizeCustomerId } from "../config";

interface AccountScope {
	ids: Set<string>;
	logins: Map<string, string>;
	list: AccountInfo[];
	expiresAt: number;
}
interface AccountInfo {
	customer_id: string;
	name: string;
	currency?: string;
	time_zone?: string;
	manager: boolean;
	status?: string;
	level: number;
	via_manager?: string;
	write_allowed: boolean;
}

/** Caché por ámbito (MCC del propietario o usuario): nunca se mezclan cuentas de usuarios distintos. */
const scopes = new Map<string, AccountScope>();
const SCOPE_TTL_MS = 10 * 60_000;
const MAX_ROOTS = 50;

export function _resetChildCache() {
	scopes.clear();
}

const CLIENT_QUERY =
	"SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.status, customer_client.level FROM customer_client";

function toInfo(c: Json, limits: Limits, viaManager?: string): AccountInfo {
	const id = String(c.id);
	return {
		customer_id: id,
		name: c.descriptiveName ?? "",
		currency: c.currencyCode,
		time_zone: c.timeZone,
		manager: Boolean(c.manager),
		status: c.status,
		level: Number(c.level ?? 0),
		...(viaManager ? { via_manager: viaManager } : {}),
		write_allowed: isWriteAllowed(limits, id),
	};
}

async function loadScope(client: GoogleAdsClient, limits: Limits): Promise<AccountScope> {
	const list: AccountInfo[] = [];
	const logins = new Map<string, string>();
	if (limits.mode === "mcc") {
		for (const r of await client.searchAll(limits.loginCustomerId, CLIENT_QUERY)) list.push(toInfo(r.customerClient, limits));
	} else {
		// Cuentas a las que el usuario de Google tiene acceso directo; las MCC aportan además su jerarquía.
		const roots = (await client.listAccessibleCustomers()).map((rn) => rn.split("/").pop()!).slice(0, MAX_ROOTS);
		const seen = new Set<string>();
		for (const root of roots) {
			client.setLogins(new Map([[root, root]]));
			let rows: Json[];
			try {
				rows = await client.searchAll(root, CLIENT_QUERY);
			} catch {
				continue; // cuentas canceladas o sin permiso de lectura: se omiten
			}
			for (const r of rows) {
				const id = String(r.customerClient.id);
				// Acceso directo tiene prioridad; si no, a través de la primera MCC que la contiene.
				if (seen.has(id) && !(roots.includes(id) && id === root)) continue;
				const direct = id === root;
				logins.set(id, direct ? id : root);
				const prev = list.findIndex((a) => a.customer_id === id);
				const info = toInfo(r.customerClient, limits, direct ? undefined : root);
				if (prev >= 0) list[prev] = info;
				else list.push(info);
				seen.add(id);
			}
		}
	}
	return { ids: new Set(list.map((a) => a.customer_id)), logins, list, expiresAt: Date.now() + SCOPE_TTL_MS };
}

async function scopeFor(client: GoogleAdsClient, limits: Limits): Promise<AccountScope> {
	let sc = scopes.get(limits.scopeKey);
	if (!sc || sc.expiresAt < Date.now()) {
		sc = await loadScope(client, limits);
		scopes.set(limits.scopeKey, sc);
	}
	client.setLogins(sc.logins);
	return sc;
}

export async function listAccessibleCustomers(client: GoogleAdsClient, limits: Limits) {
	scopes.delete(limits.scopeKey); // listar fuerza datos frescos
	return (await scopeFor(client, limits)).list;
}

/** Solo se lee o escribe en cuentas del ámbito: la jerarquía de la MCC (propietario) o las del propio usuario. */
export async function assertReadable(client: GoogleAdsClient, limits: Limits, customerId: string): Promise<string> {
	const cid = normalizeCustomerId(customerId);
	if (limits.mode === "mcc" && cid === limits.loginCustomerId) return cid;
	const sc = await scopeFor(client, limits);
	if (!sc.ids.has(cid)) {
		throw new Error(
			limits.mode === "mcc"
				? `La cuenta ${cid} no cuelga de la MCC ${limits.loginCustomerId}. Lectura denegada.`
				: `Tu usuario de Google no tiene acceso a la cuenta ${cid}. Usa list_accessible_customers para ver las tuyas.`,
		);
	}
	return cid;
}

function metricsOut(m: Json = {}) {
	return {
		cost: Number(fromMicros(m.costMicros).toFixed(2)),
		impressions: Number(m.impressions ?? 0),
		clicks: Number(m.clicks ?? 0),
		conversions: Number(Number(m.conversions ?? 0).toFixed(2)),
		conversions_value: Number(Number(m.conversionsValue ?? 0).toFixed(2)),
	};
}

export async function campaignOverview(client: GoogleAdsClient, cid: string, dateFrom: string, dateTo: string) {
	assertDate(dateFrom, "date_from");
	assertDate(dateTo, "date_to");
	const currency = (await client.searchAll(cid, "SELECT customer.currency_code FROM customer"))[0]?.customer?.currencyCode;
	const base = await client.searchAll(
		cid,
		"SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.bidding_strategy, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign.geo_target_type_setting.positive_geo_target_type, campaign.geo_target_type_setting.negative_geo_target_type FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name",
	);
	const metrics = await client.searchAll(
		cid,
		`SELECT campaign.id, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}' AND campaign.status != 'REMOVED'`,
	);
	const byId = new Map(metrics.map((r) => [String(r.campaign.id), r.metrics]));
	return {
		currency,
		date_from: dateFrom,
		date_to: dateTo,
		campaigns: base.map((r) => ({
			id: String(r.campaign.id),
			name: r.campaign.name,
			status: r.campaign.status,
			type: r.campaign.advertisingChannelType,
			bidding: r.campaign.biddingStrategyType,
			portfolio_bidding_strategy: r.campaign.biddingStrategy ?? null,
			daily_budget: fromMicros(r.campaignBudget?.amountMicros),
			budget_shared: Boolean(r.campaignBudget?.explicitlyShared),
			geo_target_type: r.campaign.geoTargetTypeSetting?.positiveGeoTargetType,
			...metricsOut(byId.get(String(r.campaign.id))),
		})),
	};
}

export async function campaignDetail(client: GoogleAdsClient, cid: string, campaignId: string) {
	const id = assertId(campaignId, "campaign_id");
	const camp = await client.searchAll(
		cid,
		`SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.maximize_conversions.target_cpa_micros, campaign.target_cpa.target_cpa_micros, campaign.geo_target_type_setting.positive_geo_target_type, campaign.geo_target_type_setting.negative_geo_target_type, campaign.demand_gen_campaign_settings.upgraded_targeting, campaign.start_date_time, campaign.end_date_time, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign WHERE campaign.id = ${id}`,
	);
	if (!camp.length) throw new Error(`La campaña ${id} no existe en ${cid}.`);
	const c = camp[0];
	const criteria = await client.searchAll(
		cid,
		`SELECT campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant, campaign_criterion.brand_list.shared_set, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign_criterion.placement.url FROM campaign_criterion WHERE campaign.id = ${id} AND campaign_criterion.status != 'REMOVED'`,
	);
	const geoIds = new Set<string>();
	for (const r of criteria) if (r.campaignCriterion.location?.geoTargetConstant) geoIds.add(r.campaignCriterion.location.geoTargetConstant);
	const adGroups = await client.searchAll(
		cid,
		`SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.demand_gen_ad_group_settings.channel_controls.channel_config, ad_group.demand_gen_ad_group_settings.channel_controls.channel_strategy, ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.discover, ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.gmail, ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.display, ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.youtube_in_feed, ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.youtube_in_stream, ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.youtube_shorts, ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.maps FROM ad_group WHERE campaign.id = ${id} AND ad_group.status != 'REMOVED'`,
	);
	const agCriteria = adGroups.length
		? await client.searchAll(
				cid,
				`SELECT ad_group.id, ad_group_criterion.type, ad_group_criterion.negative, ad_group_criterion.location.geo_target_constant, ad_group_criterion.language.language_constant, ad_group_criterion.custom_audience.custom_audience, ad_group_criterion.audience.audience, ad_group_criterion.user_list.user_list FROM ad_group_criterion WHERE campaign.id = ${id} AND ad_group_criterion.status != 'REMOVED' AND ad_group_criterion.type IN ('LOCATION', 'LANGUAGE', 'CUSTOM_AUDIENCE', 'AUDIENCE', 'USER_LIST')`,
			)
		: [];
	for (const r of agCriteria) if (r.adGroupCriterion.location?.geoTargetConstant) geoIds.add(r.adGroupCriterion.location.geoTargetConstant);
	const assetGroups =
		c.campaign.advertisingChannelType === "PERFORMANCE_MAX"
			? await client.searchAll(cid, `SELECT asset_group.id, asset_group.name, asset_group.status, asset_group.final_urls, asset_group.ad_strength FROM asset_group WHERE campaign.id = ${id} AND asset_group.status != 'REMOVED'`)
			: [];
	// Nombres legibles de ubicaciones
	const geoNames = new Map<string, string>();
	if (geoIds.size) {
		const ids = [...geoIds].map((g) => g.split("/").pop()).filter((x) => /^\d+$/.test(x ?? ""));
		if (ids.length) {
			const rows = await client.searchAll(cid, `SELECT geo_target_constant.resource_name, geo_target_constant.name, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.id IN (${ids.join(",")})`);
			for (const r of rows) geoNames.set(r.geoTargetConstant.resourceName, `${r.geoTargetConstant.name} (${r.geoTargetConstant.countryCode})`);
		}
	}
	const named = (g?: string) => (g ? geoNames.get(g) ?? g : undefined);
	const crit = criteria.map((r) => r.campaignCriterion);
	return {
		campaign: {
			id: String(c.campaign.id),
			name: c.campaign.name,
			status: c.campaign.status,
			type: c.campaign.advertisingChannelType,
			sub_type: c.campaign.advertisingChannelSubType,
			bidding: c.campaign.biddingStrategyType,
			portfolio_bidding_strategy: c.campaign.biddingStrategy ?? null,
			target_cpa: fromMicros(c.campaign.maximizeConversions?.targetCpaMicros ?? c.campaign.targetCpa?.targetCpaMicros) || null,
			geo_target_type_setting: c.campaign.geoTargetTypeSetting,
			demand_gen_upgraded_targeting: c.campaign.demandGenCampaignSettings?.upgradedTargeting ?? null,
			start: c.campaign.startDateTime,
			end: c.campaign.endDateTime,
		},
		budget: {
			resource_name: c.campaignBudget?.resourceName,
			daily_amount: fromMicros(c.campaignBudget?.amountMicros),
			shared: Boolean(c.campaignBudget?.explicitlyShared) || Number(c.campaignBudget?.referenceCount ?? 1) > 1,
			reference_count: Number(c.campaignBudget?.referenceCount ?? 1),
		},
		locations_included: crit.filter((x) => x.type === "LOCATION" && !x.negative).map((x) => named(x.location?.geoTargetConstant)),
		locations_excluded: crit.filter((x) => x.type === "LOCATION" && x.negative).map((x) => named(x.location?.geoTargetConstant)),
		languages: crit.filter((x) => x.type === "LANGUAGE").map((x) => x.language?.languageConstant),
		brand_lists: crit.filter((x) => x.type === "BRAND_LIST").map((x) => ({ shared_set: x.brandList?.sharedSet, negative: Boolean(x.negative) })),
		negative_keywords: crit.filter((x) => x.type === "KEYWORD" && x.negative).length,
		excluded_placements: crit.filter((x) => x.type === "PLACEMENT" && x.negative).map((x) => x.placement?.url),
		ad_groups: adGroups.map((r) => {
			const agId = String(r.adGroup.id);
			const cc = r.adGroup.demandGenAdGroupSettings?.channelControls;
			const myCrit = agCriteria.filter((x) => String(x.adGroup.id) === agId).map((x) => x.adGroupCriterion);
			return {
				id: agId,
				name: r.adGroup.name,
				status: r.adGroup.status,
				type: r.adGroup.type,
				...(cc ? { demand_gen_channels: cc } : {}),
				locations: myCrit.filter((x) => x.type === "LOCATION").map((x) => `${x.negative ? "EXCLUIDA " : ""}${named(x.location?.geoTargetConstant)}`),
				languages: myCrit.filter((x) => x.type === "LANGUAGE").map((x) => x.language?.languageConstant),
				audiences: myCrit
					.filter((x) => ["CUSTOM_AUDIENCE", "AUDIENCE", "USER_LIST"].includes(x.type))
					.map((x) => x.customAudience?.customAudience ?? x.audience?.audience ?? x.userList?.userList),
			};
		}),
		asset_groups: assetGroups.map((r) => ({ id: String(r.assetGroup.id), name: r.assetGroup.name, status: r.assetGroup.status, final_urls: r.assetGroup.finalUrls, ad_strength: r.assetGroup.adStrength })),
	};
}

export async function networkBreakdown(client: GoogleAdsClient, cid: string, dateFrom: string, dateTo: string, campaignIds?: string[]) {
	assertDate(dateFrom, "date_from");
	assertDate(dateTo, "date_to");
	const ids = (campaignIds ?? []).map((x) => assertId(x, "campaign_ids"));
	const rows = await client.searchAll(
		cid,
		`SELECT campaign.id, campaign.name, segments.ad_network_type, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'${ids.length ? ` AND campaign.id IN (${ids.join(",")})` : ""}`,
	);
	const totals = new Map<string, ReturnType<typeof metricsOut>>();
	for (const r of rows) {
		const k = r.segments.adNetworkType;
		const m = metricsOut(r.metrics);
		const t = totals.get(k) ?? { cost: 0, impressions: 0, clicks: 0, conversions: 0, conversions_value: 0 };
		totals.set(k, {
			cost: Number((t.cost + m.cost).toFixed(2)),
			impressions: t.impressions + m.impressions,
			clicks: t.clicks + m.clicks,
			conversions: Number((t.conversions + m.conversions).toFixed(2)),
			conversions_value: Number((t.conversions_value + m.conversions_value).toFixed(2)),
		});
	}
	return {
		date_from: dateFrom,
		date_to: dateTo,
		totals_by_network: Object.fromEntries(totals),
		by_campaign: rows.map((r) => ({ campaign_id: String(r.campaign.id), campaign: r.campaign.name, network: r.segments.adNetworkType, ...metricsOut(r.metrics) })),
	};
}

export async function changeHistory(client: GoogleAdsClient, cid: string, days: number) {
	if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("days debe ser un entero entre 1 y 30.");
	const to = new Date();
	// change_event solo admite los últimos 30 días contados en la zona de la cuenta: con days=30 exactos Google
	// devolvía START_DATE_TOO_OLD (visto en uso real). Se acota a 29 días completos + hoy.
	const from = new Date(to.getTime() - Math.min(days, 29) * 86400_000);
	const fmt = (d: Date) => d.toISOString().slice(0, 10);
	const rows = await client.searchAll(
		cid,
		`SELECT change_event.change_date_time, change_event.user_email, change_event.client_type, change_event.change_resource_type, change_event.change_resource_name, change_event.resource_change_operation, change_event.changed_fields, change_event.campaign FROM change_event WHERE change_event.change_date_time >= '${fmt(from)}' AND change_event.change_date_time <= '${fmt(to)} 23:59:59' ORDER BY change_event.change_date_time DESC LIMIT 1000`,
	);
	return rows.map((r) => ({
		when: r.changeEvent.changeDateTime,
		user: r.changeEvent.userEmail,
		client: r.changeEvent.clientType,
		resource_type: r.changeEvent.changeResourceType,
		resource: r.changeEvent.changeResourceName,
		operation: r.changeEvent.resourceChangeOperation,
		changed_fields: r.changeEvent.changedFields,
		campaign: r.changeEvent.campaign,
	}));
}
