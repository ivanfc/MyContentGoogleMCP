import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GoogleAdsClient, GoogleAdsApiError, type Json } from "./ads/client";
import { describeGaqlFields, gaqlHint } from "./ads/fields";
import { OMITTED_NOTE, omittedFields } from "./ads/gaql";
import { type Props, GoogleHandler, isEmailAllowed, isOwner } from "./auth/google-handler";
import { DEFAULT_MAX_ROWS, GOOGLE_ADS_API_VERSION, HARD_MAX_ROWS, type Limits, getLimits, isWriteAllowed, missingSecrets, normalizeCustomerId, userLimits } from "./config";
import type { UsageQuota } from "./quota";
import { describeOperation, listOperations, loadDiscovery } from "./ads/schema";
import { type ApiCall, buildPath, describeMethod, findMethod, listMethods, mutateRedirect } from "./plans/apicall";
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
import { type Deps, type PlanDraft, applyPlan, cancelPlan, createPlan, getAuditLog, listPendingPlans } from "./plans/engine";
import { buildGenericPlan } from "./plans/generic";
import { accountHealthCheck } from "./tools/health";
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

/** Resumen de error para los logs: código de la API y mensaje corto, sin datos de la cuenta. */
function errorSummary(e: unknown): Record<string, unknown> {
	if (e instanceof GoogleAdsApiError) return { http: e.httpStatus, codes: e.details.map((d) => d.errorCode).slice(0, 5), request_id: e.requestId };
	return { message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
}

const customerId = z.string().describe('ID de cuenta de Google Ads, 10 dígitos, con o sin guiones. Ej: "8460514008"');
const campaignId = z.string().describe('ID numérico de campaña. Ej: "22714600993"');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha YYYY-MM-DD (zona horaria de la cuenta)");

const PLAN_NOTE =
	"Si el plan devuelve elevated (operaciones sensibles o destructivas), la confirmación es \"APPLY-ELEVATED <plan_id>\" y debes enseñar esos motivos al usuario antes de pedirle aprobación. NO aplica nada: lee el estado actual, construye las operaciones, las valida con validateOnly y devuelve plan_id + resumen ANTES → DESPUÉS. Para ejecutar, enseña el resumen al usuario y, solo con su aprobación explícita, llama a apply_plan(plan_id, confirm: \"APPLY <plan_id>\"). El plan caduca en 24 h; si se pierde el plan_id, list_pending_plans lo recupera.";

export { PlanLock } from "./lock";
export { UsageQuota } from "./quota";

/**
 * Contrato de respuesta para cualquier cliente (Claude, Cowork, Codex…): qué es "hecho", qué no, y cómo decirlo.
 * El MCP solo lee y escribe en Google Ads; documentar, reportar o planificar campañas es trabajo del agente.
 */
const SERVER_INSTRUCTIONS = `Google Ads (lectura y escritura) vía la API oficial.
Reglas:
1. Nada está hecho hasta que apply_plan devuelve ok:true. Un plan_* solo valida (validateOnly) y no cambia la cuenta. Las operaciones de un plan se aplican todas o ninguna.
2. Si una petición no se puede hacer, dilo claramente y con el motivo exacto: no existe herramienta u operación para ello, la API no lo permite para ese tipo de campaña (el error lo indica), falta permiso o acceso de la cuenta, o una barrera lo bloquea. No lo presentes como hecho ni lo sustituyas por otra cosa sin decirlo.
3. Si se hizo solo una parte de lo pedido (por ejemplo, un plan que cubre 3 de 4 cambios), enumera lo que NO se hizo y por qué.
4. Antes de aplicar, enseña el resumen del plan y, si tiene elevated, sus motivos; aplica solo con aprobación explícita del usuario usando exactamente confirm_with.
5. La API omite los valores por defecto (false, 0, ""): ausente no significa desconocido (ver omitted_fields en gaql_search).
6. Para construir operaciones no previstas por las herramientas específicas, usa describe_mutate_operation / describe_api_method (esquema oficial), y para consultas GAQL describe_gaql_fields, en lugar de inventar campos.`;

export class GoogleAdsMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({ name: "MyContent Google Ads MCP", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });

	private services() {
		const email = this.props?.email;
		if (!email || !isEmailAllowed(email, this.env.ALLOWED_EMAILS)) {
			throw new Error(`403: ${email ?? "usuario desconocido"} no tiene acceso a este conector.`);
		}
		const owner = isOwner(email, this.env.OWNER_EMAILS);
		let client: GoogleAdsClient;
		let limits: Limits;
		if (owner) {
			// Propietario: credenciales del Worker y su MCC (comportamiento de siempre).
			const missing = missingSecrets(this.env as unknown as Record<string, unknown>);
			if (missing.length) throw new Error(`Faltan secretos del Worker: ${missing.join(", ")}. Configúralos con "wrangler secret put".`);
			client = new GoogleAdsClient(this.env);
			limits = getLimits(this.env);
		} else {
			// Cualquier otro usuario: SU permiso de Google Ads. Solo ve las cuentas a las que su usuario de Google tiene acceso.
			const refresh = this.props?.googleRefreshToken;
			if (!refresh) {
				throw new Error("Tu conexión no tiene permiso de Google Ads. Desconecta el conector, vuelve a conectarlo y acepta el acceso a Google Ads en la pantalla de Google.");
			}
			client = new GoogleAdsClient({
				GOOGLE_ADS_CLIENT_ID: this.env.GOOGLE_OAUTH_CLIENT_ID,
				GOOGLE_ADS_CLIENT_SECRET: this.env.GOOGLE_OAUTH_CLIENT_SECRET,
				GOOGLE_ADS_REFRESH_TOKEN: refresh,
				GOOGLE_ADS_DEVELOPER_TOKEN: this.env.GOOGLE_ADS_DEVELOPER_TOKEN,
			});
			limits = userLimits(this.env, email);
		}
		// Cuota diaria compartida de la API: el propietario tiene reservado lo que los demás no pueden gastar.
		const quota = this.env.USAGE_QUOTA.get(this.env.USAGE_QUOTA.idFromName("global")) as unknown as DurableObjectStub<UsageQuota>;
		const cfg = {
			total: Number(this.env.QUOTA_DAILY_TOTAL || 14000),
			others: Number(this.env.QUOTA_DAILY_OTHERS || 5000),
			perUser: Number(this.env.QUOTA_DAILY_PER_USER || 1000),
		};
		client.beforeRequest = async (n) => {
			let r: { ok: boolean; reason?: string };
			try {
				r = await quota.consume(email.toLowerCase(), owner, n, cfg);
			} catch (e) {
				// Si el contador no responde, el propietario sigue trabajando (Google ya limita); los invitados no.
				console.error(JSON.stringify({ evt: "quota_error", owner, error: (e as Error).message }));
				if (owner) return;
				throw new Error("No se pudo comprobar la cuota diaria. Inténtalo de nuevo en unos segundos.");
			}
			if (!r.ok) throw new Error(r.reason);
		};
		const deps: Deps = {
			client,
			kv: this.env.STATE_KV,
			limits,
			userEmail: this.props!.email,
			claim: (planId) => this.env.PLAN_LOCK.get(this.env.PLAN_LOCK.idFromName("global")).claim(planId),
			assertWritable: async (cid) => {
				await this.writable(cid);
			},
		};
		return { limits, client, deps, owner, quota };
	}

	private async writable(cid: string) {
		const { limits, client } = this.services();
		const id = normalizeCustomerId(cid);
		if (!isWriteAllowed(limits, id)) {
			throw new Error(`La cuenta ${id} no está en ALLOWED_CUSTOMER_IDS (${[...limits.allowedCustomerIds].join(", ")}). Escritura denegada.`);
		}
		// Siempre: la cuenta tiene que estar en el ámbito (jerarquía de la MCC del propietario o cuentas del usuario).
		await assertReadable(client, limits, id);
		return id;
	}

	private tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
		// biome-ignore lint: el SDK tipa el shape de forma genérica
		(this.server as any).registerTool(name, { description, inputSchema: shape }, async (args: any) => {
			const started = Date.now();
			const log = (outcome: "ok" | "rejected" | "error", e?: unknown) =>
				// Una línea JSON por llamada (Workers Logs). Sin argumentos ni resultados: solo herramienta, cuenta, duración y error.
				console.log(
					JSON.stringify({
						evt: "tool_call",
						tool: name,
						customer_id: typeof args?.customer_id === "string" ? args.customer_id.replace(/\D/g, "") : undefined,
						user: this.props?.email,
						outcome,
						ms: Date.now() - started,
						...(e ? { error: errorSummary(e) } : {}),
					}),
				);
			try {
				const data = await handler(args);
				const result = ok(data);
				if (result.isError) {
					const d = data as { stage?: string; message?: string };
					const codes = [...new Set([...(d.message ?? "").matchAll(/\[([A-Za-z]+Error\.[A-Z_]+)\]/g)].map((m) => m[1]))].slice(0, 5);
					log("rejected", new Error(`${d.stage ?? "rejected"}${codes.length ? `: ${codes.join(", ")}` : `: ${(d.message ?? "").slice(0, 160)}`}`));
				} else log("ok");
				return result;
			} catch (e) {
				log("error", e);
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
			`Lista las cuentas de Google Ads a las que tienes acceso (directas y las que cuelgan de tus MCC) con nombre, moneda, zona horaria, a través de qué MCC se accede y si se permite escribir. Úsala primero para descubrir customer_id. Solo se puede leer y modificar estas cuentas. Google Ads API ${GOOGLE_ADS_API_VERSION}.`,
			{},
			async () => {
				const { client, limits } = this.services();
				return listAccessibleCustomers(client, limits);
			},
		);

		this.tool(
			"gaql_search",
			`Ejecuta una consulta GAQL libre (solo lectura) con paginación automática. Importes en micros (divide entre 1.000.000). OJO: la API omite en la respuesta los campos con valor por defecto (false, 0, "", UNSPECIFIED); la respuesta lista en omitted_fields los campos pedidos que faltan (ausente = valor por defecto o no definido, NO "sin dato"). Para filtrar booleanos falsos usa != TRUE (= FALSE puede no devolver filas). change_event exige acotar change_event.change_date_time por los dos lados. Si no conoces con certeza un campo, su compatibilidad con el FROM o los valores de un enum, consulta antes describe_gaql_fields; si la consulta falla, el error incluye una "Pista" con campos parecidos o valores válidos. Ej: query="SELECT campaign.id, campaign.name, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS". max_rows por defecto ${DEFAULT_MAX_ROWS}, máximo ${HARD_MAX_ROWS}.`,
			{ customer_id: customerId, query: z.string().describe("Consulta GAQL"), max_rows: z.number().int().min(1).max(HARD_MAX_ROWS).optional() },
			async ({ customer_id, query, max_rows }) => {
				const { client, limits } = this.services();
				const cid = await assertReadable(client, limits, customer_id);
				let found: { rows: Json[]; truncated: boolean };
				try {
					found = await client.search(cid, query, max_rows ?? DEFAULT_MAX_ROWS);
				} catch (e) {
					// Pista con el esquema real (campos parecidos, compatibilidad con el FROM, valores de enum).
					const hint = await gaqlHint(client, this.env.STATE_KV, query, e);
					if (hint && e instanceof Error) e.message = `${e.message}\n\nPista:\n${hint}`;
					throw e;
				}
				const { rows, truncated } = found;
				const omitted = omittedFields(query, rows);
				return {
					row_count: rows.length,
					truncated,
					...(Object.keys(omitted).length ? { omitted_fields: omitted, omitted_note: OMITTED_NOTE } : {}),
					rows,
				};
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
			"describe_gaql_fields",
			"Esquema GAQL oficial de un recurso (GoogleAdsFieldService): atributos seleccionables, recursos relacionados, segmentos y métricas compatibles con FROM <resource>, y valores de enum de los campos que coinciden con filter. Úsalo ANTES de escribir una consulta con campos que no conozcas con certeza (evita UNRECOGNIZED_FIELD, PROHIBITED_FIELD_IN_SELECT_CLAUSE, BAD_ENUM_CONSTANT). Ej: resource=\"ad_group_ad\", filter=\"policy\".",
			{ resource: z.string().describe("Recurso GAQL del FROM, p. ej. campaign, ad_group_ad, keyword_view, search_term_view"), filter: z.string().optional() },
			async ({ resource, filter }) => {
				const { client } = this.services();
				return describeGaqlFields(client, this.env.STATE_KV, resource, filter);
			},
		);

		this.tool(
			"account_health_check",
			"Diagnóstico de SOLO LECTURA de una cuenta (unas 8 consultas): parámetros {_x} de seguimiento que faltan en campañas o grupos activos, negativas de campaña que bloquean keywords activas, objetivos de conversión de cuenta que no son leads ni ventas, campañas activas que no sirven con normalidad (primary_status y motivos), anuncios rechazados o limitados y grupos Demand Gen con segmentación optimizada. Úsalo antes y después de cambios importantes. Devuelve hallazgos ordenados por gravedad.",
			{ customer_id: customerId },
			async ({ customer_id }) => {
				const { client, limits } = this.services();
				return accountHealthCheck(client, await assertReadable(client, limits, customer_id));
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
				const { deps, owner } = this.services();
				return getAuditLog(this.env.STATE_KV, limit, deps.userEmail, owner);
			},
		);

		this.tool(
			"get_quota_usage",
			"Operaciones de la Google Ads API consumidas hoy (día UTC) por tu usuario y tus límites diarios. Cada consulta GAQL (por página) y cada operación de un mutate o validación cuenta 1.",
			{},
			async () => {
				const { deps, owner, quota } = this.services();
				const st = await quota.usage();
				const today = new Date().toISOString().slice(0, 10);
				const used = st?.day === today ? (st.users[deps.userEmail.toLowerCase()] ?? 0) : 0;
				return {
					day_utc: today,
					used_by_you: used,
					your_daily_limit: owner ? Number(this.env.QUOTA_DAILY_TOTAL || 14000) : Number(this.env.QUOTA_DAILY_PER_USER || 1000),
					...(owner && st?.day === today ? { total_used: st.total, guests_used: st.others, guests_limit: Number(this.env.QUOTA_DAILY_OTHERS || 5000), users_today: Object.keys(st.users).length } : {}),
				};
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

		this.tool(
			"describe_api_method",
			`Catálogo completo de métodos de la Google Ads API ${GOOGLE_ADS_API_VERSION} (175: lectura y escritura) desde el discovery oficial. Sin method: lista (filtrable con filter, p. ej. "recommendation", "experiment", "keyword", "userData") con el tipo, la ruta, si admite validateOnly y qué herramienta usar. Con method: parámetros de ruta y campos del body (rutas, tipos, enums).`,
			{ method: z.string().optional(), filter: z.string().optional(), depth: z.number().int().min(1).max(4).default(2) },
			async ({ method, filter, depth }) => {
				this.services();
				const discovery = await loadDiscovery(this.env.STATE_KV);
				return method ? describeMethod(discovery, method, depth, filter) : listMethods(discovery, filter);
			},
		);

		this.tool(
			"api_read",
			`Ejecuta cualquier método de SOLO LECTURA de la API ${GOOGLE_ADS_API_VERSION} que no sea GAQL: ideas y métricas de keywords (generateKeywordIdeas, generateKeywordHistoricalMetrics, generateKeywordForecastMetrics), previsiones de alcance (generateReachForecast), audience insights, benchmarks, sugerencias de geo/temas, previsualizaciones de anuncios (generateShareablePreviews), generación de textos/imágenes con IA (assetGenerations), facturas… No modifica nada. Ej: method="customers.generateKeywordIdeas", path_params={"customerId":"8460514008"}, body_json='{"language":"languageConstants/1000","geoTargetConstants":["geoTargetConstants/2784"],"keywordSeed":{"keywords":["freight software"]}}'.`,
			{
				method: z.string(),
				path_params: z.record(z.string(), z.string()).default({}),
				body_json: z.string().default("{}"),
			},
			async ({ method, path_params, body_json }) => {
				const { client, limits } = this.services();
				const discovery = await loadDiscovery(this.env.STATE_KV);
				const m = findMethod(discovery, method);
				if (m.kind !== "read") throw new Error(`${m.id} modifica datos: usa plan_api_call (o plan_generic_mutate).`);
				const params = { ...path_params };
				if (params.customerId) params.customerId = await assertReadable(client, limits, params.customerId);
				const body = JSON.parse(body_json || "{}");
				return client.request(m.httpMethod, buildPath(m, params), m.httpMethod === "GET" ? undefined : body);
			},
		);

		/* ============================== ESCRITURA (plan) ============================== */

		this.tool(
			"plan_update_campaign_status",
			`Plan para pausar (PAUSED) o activar (ENABLED) una campaña. Activar una campaña siempre requiere este plan explícito. ${PLAN_NOTE} Ej: {customer_id:"8460514008", campaign_id:"22714600993", status:"PAUSED"}`,
			{ customer_id: customerId, campaign_id: campaignId, status: z.enum(["ENABLED", "PAUSED"]) },
			async ({ customer_id, campaign_id, status }) => {
				const cid = await this.writable(customer_id);
				return this.plan(() => buildCampaignStatusPlan(this.services().client, cid, campaign_id, status));
			},
		);

		this.tool(
			"plan_update_campaign_budget",
			`Plan para cambiar el presupuesto diario de una campaña. new_daily_amount en la MONEDA DE LA CUENTA (no micros), p. ej. 10 = 10,00 EUR/día. Límites: máx. MAX_DAILY_BUDGET y subida máx. MAX_BUDGET_INCREASE_PCT por plan; las bajadas siempre se permiten. Si el presupuesto es compartido, se niega salvo allow_shared_budget=true. ${PLAN_NOTE}`,
			{ customer_id: customerId, campaign_id: campaignId, new_daily_amount: z.number().positive(), allow_shared_budget: z.boolean().default(false) },
			async ({ customer_id, campaign_id, new_daily_amount, allow_shared_budget }) => {
				const cid = await this.writable(customer_id);
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
				const cid = await this.writable(customer_id);
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
				const cid = await this.writable(customer_id);
				return this.plan(() => buildGeoTargetingPlan(this.services().client, cid, campaign_id, rest));
			},
		);

		this.tool(
			"plan_add_negative_keywords",
			`Plan para añadir keywords negativas a una campaña (omite las que ya existen). Ej: {keywords:["gratis","curso"], match_type:"PHRASE"}. ${PLAN_NOTE}`,
			{ customer_id: customerId, campaign_id: campaignId, keywords: z.array(z.string()).min(1), match_type: z.enum(["EXACT", "PHRASE", "BROAD"]) },
			async ({ customer_id, campaign_id, keywords, match_type }) => {
				const cid = await this.writable(customer_id);
				return this.plan(() => buildNegativeKeywordsPlan(this.services().client, cid, campaign_id, keywords, match_type));
			},
		);

		this.tool(
			"plan_exclude_placements",
			`Plan para excluir placements (dominios, canales o vídeos de YouTube) en una campaña (scope=campaign, requiere campaign_id) o en toda la cuenta (scope=account). Ej: {scope:"account", placements:["example.com","youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx"]}. ${PLAN_NOTE}`,
			{ customer_id: customerId, scope: z.enum(["campaign", "account"]), placements: z.array(z.string()).min(1), campaign_id: z.string().optional() },
			async ({ customer_id, scope, placements, campaign_id }) => {
				const cid = await this.writable(customer_id);
				return this.plan(() => buildExcludePlacementsPlan(this.services().client, cid, scope, placements, campaign_id));
			},
		);

		this.tool(
			"plan_create_custom_audience",
			`Plan para crear un segmento personalizado (custom audience). Solo search_terms → tipo SEARCH ("personas que buscaron estos términos en Google"); con urls → tipo AUTO. Ej: {name:"Freight forwarding software searchers", search_terms:["freight forwarding software","tms software"]}. ${PLAN_NOTE}`,
			{ customer_id: customerId, name: z.string().min(1), search_terms: z.array(z.string()).default([]), urls: z.array(z.string()).optional() },
			async ({ customer_id, name, search_terms, urls }) => {
				const cid = await this.writable(customer_id);
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
				restrict_to_conversion_goal: z
					.boolean()
					.default(true)
					.describe("Por defecto true: la campaña solo optimiza hacia esa categoría. false = usa todos los objetivos biddable de la cuenta (pueden incluir interacciones o visualizaciones de YouTube)"),
				optimized_targeting: z.boolean().default(false).describe("Segmentación optimizada de los grupos. Por defecto false (se fija explícitamente)"),
				url_custom_parameters: z
					.record(z.string(), z.string())
					.optional()
					.describe('Parámetros personalizados de URL de la campaña, p. ej. {"campaignname":"..."}. Si las plantillas de la cuenta usan {_campaignname} y no lo pasas, se rellena con el nombre de la campaña; otras claves {_x} son obligatorias'),
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
				const cid = await this.writable(customer_id);
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
			`Cualquier cambio del mutate general de la API (los 64 tipos de operación de GoogleAdsService.Mutate, en cualquier tipo de campaña): array JSON de MutateOperation en formato REST camelCase, p. ej. [{"adGroupOperation":{"update":{"resourceName":"customers/8460514008/adGroups/123","status":"PAUSED"},"updateMask":"status"}}]. Consulta antes los campos con describe_mutate_operation. Admite create/update/remove e IDs temporales negativos (todo o nada). Confirmación reforzada (APPLY-ELEVATED) para: borrados de campañas/grupos/anuncios/presupuestos/listas, status REMOVED, activar campañas, campañas nuevas no pausadas, conversiones, configuración de cuenta, estrategias de cartera, experimentos, presupuestos por encima de MAX_DAILY_BUDGET o subidas > MAX_BUDGET_INCREASE_PCT. Quitar criterios, vínculos de assets, señales, ajustes de puja y etiquetas es confirmación normal. ${PLAN_NOTE}`,
			{ customer_id: customerId, operations_json: z.string().describe("Array JSON de MutateOperation") },
			async ({ customer_id, operations_json }) => {
				const cid = await this.writable(customer_id);
				return this.plan(() => buildGenericPlan(this.services().client, cid, operations_json));
			},
		);

		this.tool(
			"plan_api_call",
			`Cualquier método de ESCRITURA de la Google Ads API ${GOOGLE_ADS_API_VERSION} que no esté en el mutate general: aplicar/descartar recomendaciones, experimentos (programar, terminar, promover), Customer Match (offlineUserDataJobs), subida de conversiones offline, accesos de usuarios, vínculos de cuentas, facturación, crear subcuentas, borrar assets autogenerados de PMax, activar brand guidelines, Local Services… Busca el método y su body con describe_api_method. method = id del catálogo (p. ej. "customers.recommendations.dismiss"); path_params = parámetros de la ruta (customerId, resourceName…); body_json = cuerpo de la petición. Si el método admite validateOnly se valida antes de guardar el plan. Casi todos exigen APPLY-ELEVATED. Los ":mutate" de recursos que ya están en el mutate general se rechazan: usa plan_generic_mutate. ${PLAN_NOTE}`,
			{
				customer_id: customerId,
				method: z.string().describe('Id del método, p. ej. "customers.recommendations.apply"'),
				path_params: z.record(z.string(), z.string()).default({}).describe('Parámetros de ruta, p. ej. {"customerId":"8460514008"}'),
				body_json: z.string().default("{}").describe("Cuerpo JSON de la petición"),
				state_queries: z.array(z.string()).default([]).describe("GAQL opcionales que leen lo que toca la llamada: si cambian entre plan y apply, se aborta"),
			},
			async ({ customer_id, method, path_params, body_json, state_queries }) => {
				const cid = await this.writable(customer_id);
				const discovery = await loadDiscovery(this.env.STATE_KV);
				const m = findMethod(discovery, method);
				if (m.kind === "read") throw new Error(`${m.id} es de lectura: usa api_read.`);
				const redirect = mutateRedirect(discovery, m);
				if (redirect) throw new Error(`${m.id} equivale a ${redirect} del mutate general: usa plan_generic_mutate para que pase por las barreras por operación.`);
				let body: Record<string, unknown>;
				try {
					body = JSON.parse(body_json || "{}");
				} catch (e) {
					throw new Error(`body_json no es JSON válido: ${(e as Error).message}`);
				}
				const params = { customerId: cid, ...path_params };
				const call: ApiCall = { methodId: m.id, httpMethod: m.httpMethod, path: buildPath(m, params), body, supportsValidateOnly: m.supportsValidateOnly };
				return this.plan(async () => ({
					kind: "api_call",
					customerId: cid,
					summary: [`Llamada ${m.httpMethod} ${call.path} (${m.id})`, `Body: ${JSON.stringify(body).slice(0, 1500)}`],
					warnings: state_queries.length ? [] : ["Sin state_queries: no se detectarán cambios de estado entre plan y apply."],
					operations: [],
					stateQueries: state_queries,
					apiCall: call,
				}));
			},
		);

		this.tool(
			"apply_plan",
			'Ejecuta EXACTAMENTE las operaciones de un plan ya validado. confirm debe ser literalmente el confirm_with que devolvió el plan: "APPLY <plan_id>" o, si el plan tiene elevated, "APPLY-ELEVATED <plan_id>". SOLO debe llamarse cuando el usuario haya aprobado explícitamente el resumen (y los motivos elevated, si los hay). Si el estado de la cuenta cambió desde el plan, aborta. Deja registro de auditoría.',
			{ plan_id: z.string(), confirm: z.string().describe('"APPLY <plan_id>" o "APPLY-ELEVATED <plan_id>" según confirm_with') },
			async ({ plan_id, confirm }) => applyPlan(this.services().deps, plan_id, confirm),
		);

		this.tool(
			"list_pending_plans",
			"Planes creados y aún no aplicados ni caducados (24 h), más recientes primero: plan_id, cuenta, quién lo creó, cuándo caduca, confirm_with y resumen. Sirve para retomar una aprobación en otra conversación o si se perdió el plan_id. Antes de aplicar uno antiguo, enseña de nuevo el resumen al usuario.",
			{ customer_id: customerId.optional() },
			async ({ customer_id }) => listPendingPlans(this.services().deps, customer_id ? normalizeCustomerId(customer_id) : undefined),
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
			// Sesiones de los clientes MCP (Claude, Cowork, Codex) sin caducidad, a petición de Iván (07/10/2026):
			// - refresh token y cliente registrado sin caducidad (undefined explícito = nunca caducan);
			// - access token de 30 días: los clientes casi no renuevan, lo que también evita el problema de Codex con la
			//   rotación de refresh tokens entre varias instancias (POST /token → 400 invalid_grant).
			// Para cortar el acceso de alguien: quitarlo de ALLOWED_EMAILS (se comprueba en cada llamada).
			accessTokenTTL: 30 * 24 * 3600,
			refreshTokenTTL: undefined,
			clientRegistrationTTL: undefined,
			resourceMetadata: {
				resource: (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, "").toLowerCase(),
				resource_name: "MyContent Google Ads MCP",
			},
		});
		return provider.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
