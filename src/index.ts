import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GoogleAdsClient, GoogleAdsApiError } from "./ads/client";
import { type Props, GoogleHandler, isEmailAllowed } from "./auth/google-handler";
import { DEFAULT_MAX_ROWS, GOOGLE_ADS_API_VERSION, HARD_MAX_ROWS, getLimits, missingSecrets, normalizeCustomerId } from "./config";
import { describeOperation, listOperations, loadDiscovery } from "./ads/schema";
import { getCampaignAssets } from "./plans/assets";
import { BIDDING_STRATEGIES, buildBiddingPlans } from "./plans/bidding";
import {
	buildCampaignBudgetPlan,
	buildCampaignStatusPlan,
	buildCustomAudiencePlan,
	buildExcludePlacementsPlan,
	buildGeoTargetingPlan,
	buildNegativeKeywordsPlan,
} from "./plans/builders";
import { DG_CHANNELS, type DemandGenInput, buildDemandGenPlan } from "./plans/demandgen";
import { type Deps, type PlanDraft, applyPlan, cancelPlan, createPlan, getAuditLog } from "./plans/engine";
import { buildGenericPlan } from "./plans/generic";
import { assertReadable, campaignDetail, campaignOverview, changeHistory, listAccessibleCustomers, networkBreakdown } from "./tools/read";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
	content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
	// Un plan rechazado (barreras/validación) o un apply fallido se marcan como error para el modelo.
	...((data as { ok?: boolean })?.ok === false ? { isError: true } : {}),
});
const fail = (e: unknown): ToolResult => ({
	isError: true,
	content: [{ type: "text", text: e instanceof GoogleAdsApiError ? `${e.message}\n\n${JSON.stringify(e.toJSON(), null, 2)}` : e instanceof Error ? e.message : String(e) }],
});

const customerId = z.string().describe('ID de cuenta de Google Ads, 10 dígitos, con o sin guiones. Ej: "8460514008"');
const campaignId = z.string().describe('ID numérico de campaña. Ej: "22714600993"');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha YYYY-MM-DD (zona horaria de la cuenta)");

const PLAN_NOTE =
	"NO aplica nada: lee el estado actual, construye las operaciones, las valida con validateOnly y devuelve plan_id + resumen ANTES → DESPUÉS. Para ejecutar, enseña el resumen al usuario y, solo con su aprobación explícita, llama a apply_plan(plan_id, confirm: \"APPLY <plan_id>\"). El plan caduca en 30 minutos.";

export class GoogleAdsMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({ name: "MyContent Google Ads MCP", version: "0.1.0" });

	private services() {
		const missing = missingSecrets(this.env as unknown as Record<string, unknown>);
		if (missing.length) throw new Error(`Faltan secretos del Worker: ${missing.join(", ")}. Configúralos con "wrangler secret put".`);
		if (!isEmailAllowed(this.props?.email, this.env.ALLOWED_EMAILS)) {
			throw new Error(`403: ${this.props?.email ?? "usuario desconocido"} ya no está en ALLOWED_EMAILS.`);
		}
		const limits = getLimits(this.env);
		const client = new GoogleAdsClient(this.env);
		const deps: Deps = { client, kv: this.env.STATE_KV, limits, userEmail: this.props!.email };
		return { limits, client, deps };
	}

	private writable(cid: string) {
		const { limits } = this.services();
		const id = normalizeCustomerId(cid);
		if (!limits.allowedCustomerIds.has(id)) {
			throw new Error(`La cuenta ${id} no está en ALLOWED_CUSTOMER_IDS (${[...limits.allowedCustomerIds].join(", ")}). Escritura denegada.`);
		}
		return id;
	}

	private tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
		// biome-ignore lint: el SDK tipa el shape de forma genérica
		(this.server as any).registerTool(name, { description, inputSchema: shape }, async (args: any) => {
			try {
				return ok(await handler(args));
			} catch (e) {
				return fail(e);
			}
		});
	}

	private async plan(draftFn: () => Promise<PlanDraft>) {
		const { deps } = this.services();
		return createPlan(deps, await draftFn());
	}

	async init() {
		/* ============================== LECTURA ============================== */

		this.tool(
			"list_accessible_customers",
			`Lista las cuentas bajo la MCC (login-customer-id) con nombre, moneda, zona horaria y si se permite escribir en ellas (ALLOWED_CUSTOMER_IDS). Úsala primero para descubrir customer_id. Google Ads API ${GOOGLE_ADS_API_VERSION}.`,
			{},
			async () => {
				const { client, limits } = this.services();
				return listAccessibleCustomers(client, limits);
			},
		);

		this.tool(
			"gaql_search",
			`Ejecuta una consulta GAQL libre (solo lectura) con paginación automática. Importes en micros (divide entre 1.000.000). Ej: query="SELECT campaign.id, campaign.name, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS". max_rows por defecto ${DEFAULT_MAX_ROWS}, máximo ${HARD_MAX_ROWS}.`,
			{ customer_id: customerId, query: z.string().describe("Consulta GAQL"), max_rows: z.number().int().min(1).max(HARD_MAX_ROWS).optional() },
			async ({ customer_id, query, max_rows }) => {
				const { client, limits } = this.services();
				const cid = await assertReadable(client, limits, customer_id);
				const { rows, truncated } = await client.search(cid, query, max_rows ?? DEFAULT_MAX_ROWS);
				return { row_count: rows.length, truncated, rows };
			},
		);

		this.tool(
			"get_campaign_overview",
			"Campañas (no eliminadas) con estado, tipo, presupuesto diario (moneda de la cuenta), estrategia de puja, opción de ubicación (geo_target_type), gasto, impresiones, clics, conversiones y valor en el rango de fechas. Ej: date_from=2026-09-24, date_to=2026-09-30.",
			{ customer_id: customerId, date_from: date, date_to: date },
			async ({ customer_id, date_from, date_to }) => {
				const { client, limits } = this.services();
				return campaignOverview(client, await assertReadable(client, limits, customer_id), date_from, date_to);
			},
		);

		this.tool(
			"get_campaign_detail",
			"Detalle de una campaña: presupuesto (y si es compartido), puja, ubicaciones incluidas/excluidas, idiomas, listas de marca, keywords negativas, placements excluidos, grupos de anuncios (con canales si es Demand Gen, y su geo/idioma/audiencias) o asset groups si es PMax.",
			{ customer_id: customerId, campaign_id: campaignId },
			async ({ customer_id, campaign_id }) => {
				const { client, limits } = this.services();
				return campaignDetail(client, await assertReadable(client, limits, customer_id), campaign_id);
			},
		);

		this.tool(
			"get_network_breakdown",
			"Gasto, impresiones, clics y conversiones por red (segments.ad_network_type: SEARCH, CONTENT, YOUTUBE, DISCOVER, GMAIL…), total y por campaña. campaign_ids opcional para filtrar.",
			{ customer_id: customerId, date_from: date, date_to: date, campaign_ids: z.array(z.string()).optional() },
			async ({ customer_id, date_from, date_to, campaign_ids }) => {
				const { client, limits } = this.services();
				return networkBreakdown(client, await assertReadable(client, limits, customer_id), date_from, date_to, campaign_ids);
			},
		);

		this.tool(
			"get_change_history",
			"Historial de cambios (change_event) de los últimos N días (máx. 30): quién, cuándo, qué recurso y qué campos.",
			{ customer_id: customerId, days: z.number().int().min(1).max(30) },
			async ({ customer_id, days }) => {
				const { client, limits } = this.services();
				return changeHistory(client, await assertReadable(client, limits, customer_id), days);
			},
		);

		this.tool(
			"get_asset_group_assets",
			"Assets de una campaña Performance Max agrupados por field_type (HEADLINE, DESCRIPTION, MARKETING_IMAGE, SQUARE_MARKETING_IMAGE, PORTRAIT_MARKETING_IMAGE, LOGO, BUSINESS_NAME, YOUTUBE_VIDEO…) con resource names para reutilizarlos. Incluye assets a nivel de campaña (logos y nombre de empresa con Brand Guidelines).",
			{ customer_id: customerId, campaign_id: campaignId },
			async ({ customer_id, campaign_id }) => {
				const { client, limits } = this.services();
				return getCampaignAssets(client, await assertReadable(client, limits, customer_id), campaign_id);
			},
		);

		this.tool(
			"get_audit_log",
			"Registro de auditoría de apply_plan (más reciente primero): fecha UTC, email, cuenta, operaciones exactas, respuesta de la API, resource names y resultado.",
			{ limit: z.number().int().min(1).max(100).default(20) },
			async ({ limit }) => {
				this.services();
				return getAuditLog(this.env.STATE_KV, limit);
			},
		);

		this.tool(
			"describe_mutate_operation",
			`Esquema oficial (discovery doc de la Google Ads API ${GOOGLE_ADS_API_VERSION}) para construir plan_generic_mutate SIN inventar campos. Sin argumentos: lista todas las operaciones de mutate (campaignOperation, adGroupCriterionOperation, assetGroupSignalOperation, campaignBidModifierOperation…) y si las barreras las permiten. Con operation: campos modificables del recurso (ruta, tipo, enums, inmutable/requerido), excluidos los de solo lectura. Usa filter para acotar (p. ej. operation="campaignOperation", filter="bidding" o "network"). Sirve para cualquier tipo de campaña: Search, Performance Max, Demand Gen, Display, Video, Shopping, App…`,
			{
				operation: z.string().optional().describe('Clave de MutateOperation, p. ej. "campaignOperation"'),
				filter: z.string().optional().describe("Texto para filtrar rutas/descripciones"),
				depth: z.number().int().min(1).max(4).default(2),
			},
			async ({ operation, filter, depth }) => {
				this.services();
				const discovery = await loadDiscovery(this.env.STATE_KV);
				return operation ? describeOperation(discovery, operation, depth, filter) : listOperations(discovery);
			},
		);

		/* ============================== ESCRITURA (plan) ============================== */

		this.tool(
			"plan_update_campaign_status",
			`Plan para pausar (PAUSED) o activar (ENABLED) una campaña. Activar una campaña siempre requiere este plan explícito. ${PLAN_NOTE} Ej: {customer_id:"8460514008", campaign_id:"22714600993", status:"PAUSED"}`,
			{ customer_id: customerId, campaign_id: campaignId, status: z.enum(["ENABLED", "PAUSED"]) },
			async ({ customer_id, campaign_id, status }) => {
				const cid = this.writable(customer_id);
				return this.plan(() => buildCampaignStatusPlan(this.services().client, cid, campaign_id, status));
			},
		);

		this.tool(
			"plan_update_campaign_budget",
			`Plan para cambiar el presupuesto diario de una campaña. new_daily_amount en la MONEDA DE LA CUENTA (no micros), p. ej. 10 = 10,00 EUR/día. Límites: máx. MAX_DAILY_BUDGET y subida máx. MAX_BUDGET_INCREASE_PCT por plan; las bajadas siempre se permiten. Si el presupuesto es compartido, se niega salvo allow_shared_budget=true. ${PLAN_NOTE}`,
			{ customer_id: customerId, campaign_id: campaignId, new_daily_amount: z.number().positive(), allow_shared_budget: z.boolean().default(false) },
			async ({ customer_id, campaign_id, new_daily_amount, allow_shared_budget }) => {
				const cid = this.writable(customer_id);
				return this.plan(() => buildCampaignBudgetPlan(this.services().client, cid, campaign_id, new_daily_amount, allow_shared_budget));
			},
		);

		this.tool(
			"plan_update_bidding_strategy",
			`Plan para cambiar la estrategia de puja ESTÁNDAR de una campaña (Search, PMax, Display, Demand Gen…): MAXIMIZE_CONVERSIONS (target_cpa opcional, en moneda de la cuenta), MAXIMIZE_CONVERSION_VALUE (target_roas opcional como ratio: 4 = 400 %), MAXIMIZE_CLICKS (max_cpc opcional) o MANUAL_CPC. Prueba con validateOnly las representaciones que admite la API para ese tipo de campaña y guarda la válida. Se niega si la campaña usa una estrategia de cartera compartida. Ej: {campaign_id:"22714600993", strategy:"MAXIMIZE_CONVERSIONS", target_cpa:45}. ${PLAN_NOTE}`,
			{
				customer_id: customerId,
				campaign_id: campaignId,
				strategy: z.enum(BIDDING_STRATEGIES),
				target_cpa: z.number().positive().optional(),
				target_roas: z.number().positive().optional(),
				max_cpc: z.number().positive().optional(),
			},
			async ({ customer_id, campaign_id, ...input }) => {
				const cid = this.writable(customer_id);
				const { client, deps } = this.services();
				const drafts = await buildBiddingPlans(client, cid, campaign_id, input);
				const attempts: unknown[] = [];
				for (const d of drafts) {
					const r = await createPlan(deps, d);
					if (r.ok || r.stage !== "validation") return attempts.length ? { ...r, rejected_representations: attempts } : r;
					attempts.push({ representation: d.operations[0].campaignOperation.updateMask, errors: r.errors });
				}
				return { ok: false, message: "Ninguna representación de la estrategia ha validado para esta campaña.", attempts };
			},
		);

		this.tool(
			"plan_set_geo_targeting",
			`Plan para segmentación geográfica a nivel de campaña: añade países incluidos/excluidos (códigos ISO alfa-2, resueltos por la API a geoTargetConstants) y/o cambia la opción de ubicación a PRESENCE ("Presencia") o PRESENCE_OR_INTEREST. Si un país pasa de incluido a excluido (o al revés) se sustituye el criterio. replace_includes=true elimina los incluidos que no estén en la lista. Ej: {exclude_country_codes:["IN","PK"], geo_target_type:"PRESENCE"}. ${PLAN_NOTE}`,
			{
				customer_id: customerId,
				campaign_id: campaignId,
				include_country_codes: z.array(z.string()).default([]),
				exclude_country_codes: z.array(z.string()).default([]),
				geo_target_type: z.enum(["PRESENCE", "PRESENCE_OR_INTEREST"]).optional(),
				replace_includes: z.boolean().default(false),
			},
			async ({ customer_id, campaign_id, ...rest }) => {
				const cid = this.writable(customer_id);
				return this.plan(() => buildGeoTargetingPlan(this.services().client, cid, campaign_id, rest));
			},
		);

		this.tool(
			"plan_add_negative_keywords",
			`Plan para añadir keywords negativas a una campaña (omite las que ya existen). Ej: {keywords:["gratis","curso"], match_type:"PHRASE"}. ${PLAN_NOTE}`,
			{ customer_id: customerId, campaign_id: campaignId, keywords: z.array(z.string()).min(1), match_type: z.enum(["EXACT", "PHRASE", "BROAD"]) },
			async ({ customer_id, campaign_id, keywords, match_type }) => {
				const cid = this.writable(customer_id);
				return this.plan(() => buildNegativeKeywordsPlan(this.services().client, cid, campaign_id, keywords, match_type));
			},
		);

		this.tool(
			"plan_exclude_placements",
			`Plan para excluir placements (dominios, canales o vídeos de YouTube) en una campaña (scope=campaign, requiere campaign_id) o en toda la cuenta (scope=account). Ej: {scope:"account", placements:["example.com","youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx"]}. ${PLAN_NOTE}`,
			{ customer_id: customerId, scope: z.enum(["campaign", "account"]), placements: z.array(z.string()).min(1), campaign_id: z.string().optional() },
			async ({ customer_id, scope, placements, campaign_id }) => {
				const cid = this.writable(customer_id);
				return this.plan(() => buildExcludePlacementsPlan(this.services().client, cid, scope, placements, campaign_id));
			},
		);

		this.tool(
			"plan_create_custom_audience",
			`Plan para crear un segmento personalizado (custom audience). Solo search_terms → tipo SEARCH ("personas que buscaron estos términos en Google"); con urls → tipo AUTO. Ej: {name:"Freight forwarding software searchers", search_terms:["freight forwarding software","tms software"]}. ${PLAN_NOTE}`,
			{ customer_id: customerId, name: z.string().min(1), search_terms: z.array(z.string()).default([]), urls: z.array(z.string()).optional() },
			async ({ customer_id, name, search_terms, urls }) => {
				const cid = this.writable(customer_id);
				return this.plan(() => buildCustomAudiencePlan(this.services().client, cid, name, search_terms, urls ?? []));
			},
		);

		const adSchema = z.object({
			name: z.string().optional(),
			final_url: z.string().describe("https://..."),
			headlines: z.array(z.string()).max(5).optional().describe("1-5. Si se omite y hay reuse_assets_from_campaign_id, se toman del PMax"),
			descriptions: z.array(z.string()).max(5).optional(),
			business_name: z.string().optional(),
			call_to_action: z.string().optional().describe('Texto de CTA, p. ej. "Sign up", "Learn more". Si se omite: automático'),
			logo_assets: z.array(z.string()).optional().describe("Resource names customers/.../assets/..."),
			marketing_image_assets: z.array(z.string()).optional().describe("1.91:1"),
			square_marketing_image_assets: z.array(z.string()).optional().describe("1:1"),
			portrait_marketing_image_assets: z.array(z.string()).optional().describe("4:5"),
			tall_portrait_marketing_image_assets: z.array(z.string()).optional().describe("9:16"),
			image_urls: z.array(z.object({ url: z.string(), kind: z.enum(["MARKETING", "SQUARE", "PORTRAIT", "TALL_PORTRAIT", "LOGO"]) })).optional().describe("Imágenes nuevas a subir como assets"),
		});

		this.tool(
			"plan_create_demand_gen_campaign",
			`Plan para crear una campaña Demand Gen COMPLETA en un mutate atómico (IDs temporales): presupuesto, campaña en PAUSED, segmentos personalizados nuevos (paso previo en CustomAudienceService, se crean justo antes), grupos de anuncios con control de canales (demandGenAdGroupSettings.channelControls.selectedChannels: DISCOVER, GMAIL, DISPLAY, YOUTUBE_IN_FEED, YOUTUBE_IN_STREAM, YOUTUBE_SHORTS, MAPS; los no listados quedan en false), países e idiomas POR GRUPO (upgraded targeting) y anuncios multi-imagen (DemandGenMultiAssetAd). Importes en moneda de la cuenta. Puja: MAXIMIZE_CONVERSIONS (target_cpa opcional) o MAXIMIZE_CLICKS. El objetivo de conversión se lee de los existentes (por defecto SUBMIT_LEAD_FORM); nunca se crean acciones de conversión. Con reuse_assets_from_campaign_id rellena titulares/descripciones/logos/imágenes/nombre de empresa vacíos desde un PMax. Las audiencias se asignan mediante un recurso Audience (lo exige Demand Gen); si no valida, reintenta con el criterio directo. Al reutilizar imágenes del PMax descarta las que no cumplen proporción/tamaño de Demand Gen. Ej: {name:"TEST_MCP_DemandGen_Discover", daily_budget:25, bidding_strategy:"MAXIMIZE_CONVERSIONS", country_codes:["AE","SG"], geo_target_type:"PRESENCE", language_codes:["en"], channels:["DISCOVER","GMAIL"], reuse_assets_from_campaign_id:"24049877221", new_custom_audiences:[{key:"a", name:"...", search_terms:["..."]}], ad_groups:[{name:"UAE", country_codes:["AE"], custom_audience_keys:["a"], ads:[{final_url:"https://..."}]}]}. ${PLAN_NOTE}`,
			{
				customer_id: customerId,
				name: z.string().min(1),
				daily_budget: z.number().positive(),
				bidding_strategy: z.enum(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CLICKS"]),
				target_cpa: z.number().positive().optional(),
				conversion_goal_category: z.string().optional().describe("Categoría de objetivo existente, p. ej. SUBMIT_LEAD_FORM"),
				restrict_to_conversion_goal: z.boolean().default(false).describe("Experimental: hace biddable a nivel de campaña SOLO esa categoría"),
				country_codes: z.array(z.string()).default([]).describe("Países por defecto para grupos sin country_codes propios"),
				geo_target_type: z.enum(["PRESENCE", "PRESENCE_OR_INTEREST"]).default("PRESENCE"),
				language_codes: z.array(z.string()).default([]).describe('Códigos de idioma, p. ej. ["en"]'),
				channels: z.array(z.enum(DG_CHANNELS)).min(1),
				start_date: date.optional(),
				end_date: date.optional(),
				reuse_assets_from_campaign_id: z.string().optional(),
				new_custom_audiences: z
					.array(z.object({ key: z.string(), name: z.string(), search_terms: z.array(z.string()).default([]), urls: z.array(z.string()).optional() }))
					.optional(),
				ad_groups: z
					.array(
						z.object({
							name: z.string(),
							country_codes: z.array(z.string()).optional(),
							language_codes: z.array(z.string()).optional(),
							custom_audience_keys: z.array(z.string()).optional(),
							custom_audience_resource_names: z.array(z.string()).optional(),
							user_list_resource_names: z.array(z.string()).optional(),
							ads: z.array(adSchema).min(1),
						}),
					)
					.min(1),
			},
			async ({ customer_id, ...input }) => {
				const cid = this.writable(customer_id);
				const { client, deps } = this.services();
				const dg = input as DemandGenInput;
				// Verificado contra la API real: Demand Gen exige el recurso Audience (si no, CANNOT_ADD_AUDIENCE_SEGMENT_CRITERION_WHEN_AUDIENCE_GROUPED_IS_SET).
				const first = await createPlan(deps, await buildDemandGenPlan(client, cid, dg, "AUDIENCE_RESOURCE"));
				const hasAudiences = dg.ad_groups.some((g) => g.custom_audience_keys?.length || g.custom_audience_resource_names?.length || g.user_list_resource_names?.length);
				if (first.ok || first.stage !== "validation" || !hasAudiences) return { audience_mode: "AUDIENCE_RESOURCE", ...first };
				const second = await createPlan(deps, await buildDemandGenPlan(client, cid, dg, "CUSTOM_AUDIENCE_CRITERION"));
				return { audience_mode: "CUSTOM_AUDIENCE_CRITERION", first_attempt_errors: first.errors, ...second };
			},
		);

		this.tool(
			"plan_generic_mutate",
			`Vía de escape para operaciones no cubiertas: recibe un array JSON de MutateOperation de GoogleAdsService.Mutate en formato REST camelCase (p. ej. [{"adGroupOperation":{"update":{"resourceName":"customers/8460514008/adGroups/123","status":"PAUSED"},"updateMask":"status"}}]). Pasa por TODAS las barreras: allowlist de cuentas y de tipos de operación, prohibido conversiones/facturación/accesos/vínculos/pujas de cartera, sin remove salvo criterios, límites de presupuesto, campañas nuevas en PAUSED, y no activa campañas (usa plan_update_campaign_status). ${PLAN_NOTE}`,
			{ customer_id: customerId, operations_json: z.string().describe("Array JSON de MutateOperation") },
			async ({ customer_id, operations_json }) => {
				const cid = this.writable(customer_id);
				return this.plan(() => buildGenericPlan(this.services().client, cid, operations_json));
			},
		);

		this.tool(
			"apply_plan",
			'Ejecuta EXACTAMENTE las operaciones de un plan ya validado. Requiere confirm = "APPLY <plan_id>" literal y SOLO debe llamarse cuando el usuario haya aprobado explícitamente el resumen del plan. Si el estado de la cuenta cambió desde el plan, aborta. Deja registro de auditoría.',
			{ plan_id: z.string(), confirm: z.string().describe('Exactamente "APPLY <plan_id>"') },
			async ({ plan_id, confirm }) => applyPlan(this.services().deps, plan_id, confirm),
		);

		this.tool("cancel_plan", "Descarta un plan pendiente sin aplicar nada.", { plan_id: z.string() }, async ({ plan_id }) => cancelPlan(this.services().deps, plan_id));
	}
}

let provider: OAuthProvider<Env> | undefined;

/**
 * El proveedor OAuth se construye en la primera petición porque `resourceMetadata.resource`
 * (audiencia de los tokens) es la URL pública del Worker: PUBLIC_BASE_URL o, si está vacía,
 * el origen de la petición (en workers.dev el host lo fija el enrutado de Cloudflare).
 */
export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		provider ??= new OAuthProvider<Env>({
			apiHandlers: {
				"/mcp": GoogleAdsMCP.serve("/mcp", { binding: "MCP_OBJECT" }) as any,
				"/sse": GoogleAdsMCP.serveSSE("/sse", { binding: "MCP_OBJECT" }) as any,
			},
			authorizeEndpoint: "/authorize",
			clientRegistrationEndpoint: "/register",
			defaultHandler: GoogleHandler as any,
			tokenEndpoint: "/token",
			resourceMetadata: {
				resource: (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, "").toLowerCase(),
				resource_name: "MyContent Google Ads MCP",
			},
		});
		return provider.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
