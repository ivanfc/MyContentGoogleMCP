import { type Limits, fromMicros } from "./config";
import type { Json } from "./ads/client";

export class GuardError extends Error {
	constructor(public violations: string[]) {
		super(`Bloqueado por las barreras de seguridad:\n- ${violations.join("\n- ")}`);
		this.name = "GuardError";
	}
}

/** Operaciones prohibidas explícitamente (mensaje claro aunque lleguen por el mutate genérico). */
export const FORBIDDEN_OPERATIONS: Record<string, string> = {
	conversionActionOperation: "acciones de conversión",
	conversionCustomVariableOperation: "variables personalizadas de conversión",
	conversionValueRuleOperation: "reglas de valor de conversión",
	conversionValueRuleSetOperation: "conjuntos de reglas de valor de conversión",
	customConversionGoalOperation: "objetivos de conversión personalizados",
	customerConversionGoalOperation: "objetivos de conversión a nivel de cuenta",
	conversionGoalCampaignConfigOperation: "configuración de objetivos de conversión",
	customerOperation: "configuración de la cuenta",
	biddingStrategyOperation: "estrategias de puja de cartera compartidas",
	biddingDataExclusionOperation: "exclusiones de datos de puja",
	biddingSeasonalityAdjustmentOperation: "ajustes de estacionalidad de puja",
	userListOperation: "listas de usuarios",
	remarketingActionOperation: "etiquetas de remarketing",
	experimentOperation: "experimentos",
	experimentArmOperation: "experimentos",
	campaignDraftOperation: "borradores de campaña",
	bookCampaignsOperation: "reservas",
	quoteCampaignsOperation: "reservas",
	smartCampaignSettingOperation: "campañas inteligentes",
};

/**
 * Operaciones permitidas (allowlist). Cualquier otra se rechaza.
 * Facturación, accesos de usuario y vínculos de cuenta no existen en GoogleAdsService.Mutate
 * (tienen servicios propios que este servidor nunca llama).
 */
export const ALLOWED_OPERATIONS = new Set([
	"campaignOperation",
	"campaignBudgetOperation",
	"campaignCriterionOperation",
	"campaignAssetOperation",
	"campaignSharedSetOperation",
	"campaignLabelOperation",
	"campaignBidModifierOperation",
	"campaignConversionGoalOperation",
	"adGroupOperation",
	"adGroupAdOperation",
	"adGroupCriterionOperation",
	"adGroupAssetOperation",
	"adGroupLabelOperation",
	"adGroupAdLabelOperation",
	"adGroupBidModifierOperation",
	"adOperation",
	"assetOperation",
	"assetGroupOperation",
	"assetGroupAssetOperation",
	"assetGroupSignalOperation",
	"customAudienceOperation",
	"audienceOperation",
	"customerNegativeCriterionOperation",
	"sharedSetOperation",
	"sharedCriterionOperation",
	"labelOperation",
	"customerAssetOperation",
]);

/** Únicas operaciones sobre las que se permite `remove`: criterios. */
export const REMOVABLE_OPERATIONS = new Set([
	"campaignCriterionOperation",
	"adGroupCriterionOperation",
	"customerNegativeCriterionOperation",
	"sharedCriterionOperation",
]);

export interface BudgetInfo {
	amountMicros: number;
	explicitlyShared: boolean;
	referenceCount: number;
}

export interface GuardContext {
	customerId: string;
	limits: Limits;
	/** Lee el presupuesto actual (para validar subidas). */
	getBudget: (resourceName: string) => Promise<BudgetInfo | undefined>;
	/** true solo en plan_update_campaign_status (activar campañas es un plan explícito). */
	allowCampaignEnable?: boolean;
	/** true solo si el usuario pasó el flag explícito para presupuestos compartidos. */
	allowSharedBudget?: boolean;
}

function maskFields(op: Json): string[] {
	const m = op.updateMask;
	if (!m) return [];
	return String(m)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function collectResourceNames(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") {
		if (value.startsWith("customers/")) out.push(value);
	} else if (Array.isArray(value)) {
		for (const v of value) collectResourceNames(v, out);
	} else if (value && typeof value === "object") {
		for (const v of Object.values(value)) collectResourceNames(v, out);
	}
	return out;
}

/**
 * Aplica todas las barreras a un conjunto de MutateOperation (formato REST, camelCase).
 * Lanza GuardError con TODAS las violaciones encontradas.
 */
export async function enforceGuards(operations: Json[], ctx: GuardContext): Promise<void> {
	const v: string[] = [];
	const { limits, customerId } = ctx;

	if (!limits.allowedCustomerIds.has(customerId)) {
		throw new GuardError([
			`La cuenta ${customerId} no está en ALLOWED_CUSTOMER_IDS (${[...limits.allowedCustomerIds].join(", ") || "vacía"}). No se permite escribir en ella.`,
		]);
	}
	if (!Array.isArray(operations) || operations.length === 0) {
		throw new GuardError(["No hay operaciones."]);
	}

	const maxMicros = Math.round(limits.maxDailyBudget * 1_000_000);

	for (const [i, wrapper] of operations.entries()) {
		const tag = `operación #${i}`;
		if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) {
			v.push(`${tag}: formato inválido (se espera un MutateOperation, p. ej. {"campaignOperation": {...}}).`);
			continue;
		}
		const keys = Object.keys(wrapper);
		if (keys.length !== 1) {
			v.push(`${tag}: cada MutateOperation debe tener exactamente una clave, tiene ${keys.length} (${keys.join(", ")}).`);
			continue;
		}
		const kind = keys[0];
		const op = wrapper[kind] as Json;
		if (FORBIDDEN_OPERATIONS[kind]) {
			v.push(`${tag}: ${kind} prohibido (${FORBIDDEN_OPERATIONS[kind]}).`);
			continue;
		}
		if (!ALLOWED_OPERATIONS.has(kind)) {
			v.push(`${tag}: ${kind} no está en la lista de operaciones permitidas.`);
			continue;
		}
		const actions = ["create", "update", "remove"].filter((a) => op?.[a] !== undefined);
		if (actions.length !== 1) {
			v.push(`${tag}: debe contener exactamente una acción create/update/remove.`);
			continue;
		}
		const action = actions[0];

		// Ningún resource name puede apuntar a otra cuenta.
		for (const rn of collectResourceNames(op)) {
			if (!rn.startsWith(`customers/${customerId}/`)) {
				v.push(`${tag}: referencia a otra cuenta (${rn}). Solo se permite customers/${customerId}/...`);
			}
		}

		if (action === "remove") {
			if (!REMOVABLE_OPERATIONS.has(kind)) {
				v.push(`${tag}: remove no permitido en ${kind}. Para retirar algo, páusalo. Solo se pueden eliminar criterios.`);
			}
			continue;
		}

		const body = op[action] as Json;
		const fields = maskFields(op);

		if (kind === "campaignOperation") {
			if (body.biddingStrategy !== undefined || fields.includes("bidding_strategy")) {
				v.push(`${tag}: no se permite asignar/modificar estrategias de puja de cartera compartidas (bidding_strategy).`);
			}
			if (action === "create" && body.status !== "PAUSED") {
				v.push(`${tag}: las campañas nuevas deben crearse en PAUSED (recibido ${body.status ?? "sin status → ENABLED por defecto"}).`);
			}
			if (action === "update" && body.status === "ENABLED") {
				if (!ctx.allowCampaignEnable) {
					v.push(`${tag}: activar campañas solo se permite con plan_update_campaign_status.`);
				}
			}
		}

		if (body?.status === "REMOVED") {
			v.push(`${tag}: status REMOVED equivale a borrar. Usa PAUSED.`);
		}

		if (kind === "campaignBudgetOperation") {
			const touchesAmount = body.amountMicros !== undefined || fields.includes("amount_micros");
			if (body.totalAmountMicros !== undefined) v.push(`${tag}: presupuestos totales (total_amount_micros) no soportados por este servidor.`);
			if (action === "create") {
				const amt = Number(body.amountMicros);
				if (!Number.isFinite(amt) || amt <= 0) v.push(`${tag}: presupuesto sin amountMicros válido.`);
				else if (amt > maxMicros) v.push(`${tag}: presupuesto diario ${fromMicros(amt)} supera MAX_DAILY_BUDGET (${limits.maxDailyBudget}).`);
				if (body.explicitlyShared === true) v.push(`${tag}: no se permite crear presupuestos compartidos.`);
			} else if (touchesAmount) {
				const amt = Number(body.amountMicros);
				if (!Number.isFinite(amt) || amt <= 0) {
					v.push(`${tag}: amountMicros inválido.`);
				} else {
					if (amt > maxMicros) v.push(`${tag}: presupuesto diario ${fromMicros(amt)} supera MAX_DAILY_BUDGET (${limits.maxDailyBudget}).`);
					const current = await ctx.getBudget(body.resourceName);
					if (!current) {
						v.push(`${tag}: no se pudo leer el presupuesto actual ${body.resourceName}; no se puede validar la subida.`);
					} else {
						const maxAllowed = current.amountMicros * (1 + limits.maxBudgetIncreasePct / 100);
						if (amt > current.amountMicros && amt > maxAllowed + 1) {
							v.push(
								`${tag}: subida de ${fromMicros(current.amountMicros)} a ${fromMicros(amt)} (+${(((amt - current.amountMicros) / current.amountMicros) * 100).toFixed(1)}%) supera MAX_BUDGET_INCREASE_PCT (${limits.maxBudgetIncreasePct}%).`,
							);
						}
						if ((current.explicitlyShared || current.referenceCount > 1) && !ctx.allowSharedBudget) {
							v.push(`${tag}: el presupuesto es compartido (${current.referenceCount} campañas). Requiere el flag explícito allow_shared_budget=true.`);
						}
					}
				}
			}
			if (fields.some((f) => f !== "amount_micros" && f !== "name" && f !== "delivery_method")) {
				v.push(`${tag}: en presupuestos solo se permite modificar amount_micros, name y delivery_method.`);
			}
		}

		// Ningún campo de puja de cartera por la puerta de atrás en otros recursos.
		for (const f of fields) {
			if (f.startsWith("bidding_strategy") && kind !== "campaignOperation") v.push(`${tag}: campo ${f} no permitido.`);
		}
	}

	if (v.length) throw new GuardError([...new Set(v)]);
}
