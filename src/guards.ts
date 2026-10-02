import { type Limits, fromMicros } from "./config";
import type { Json } from "./ads/client";

export class GuardError extends Error {
	constructor(public violations: string[]) {
		super(`Bloqueado por las barreras de seguridad:\n- ${violations.join("\n- ")}`);
		this.name = "GuardError";
	}
}

/**
 * Política: TODO lo que permite la API es posible, en dos niveles.
 * - Bloqueo duro (GuardError): cuenta fuera de ALLOWED_CUSTOMER_IDS, referencias a otra cuenta u operaciones
 *   mal formadas. No hay forma de saltárselo.
 * - Confirmación reforzada (elevated): operaciones sensibles o destructivas. El plan se crea y valida igual,
 *   pero apply_plan exige "APPLY-ELEVATED <plan_id>" y el resumen lista los motivos.
 */
/** Operaciones bloqueadas del todo (bloqueo duro). Vacío por decisión de Iván: todo es posible con confirmación. */
export const HARD_BLOCKED_OPERATIONS: Record<string, string> = {};

export const ELEVATED_OPERATIONS: Record<string, string> = {
	conversionActionOperation: "acciones de conversión",
	conversionCustomVariableOperation: "variables personalizadas de conversión",
	conversionValueRuleOperation: "reglas de valor de conversión",
	conversionValueRuleSetOperation: "conjuntos de reglas de valor de conversión",
	customConversionGoalOperation: "objetivos de conversión personalizados",
	customerConversionGoalOperation: "objetivos de conversión por defecto de la cuenta (afectan a todas las campañas)",
	customerOperation: "configuración de la cuenta",
	biddingStrategyOperation: "estrategias de puja de cartera compartidas",
	biddingDataExclusionOperation: "exclusiones de datos de puja",
	biddingSeasonalityAdjustmentOperation: "ajustes de estacionalidad de puja",
	remarketingActionOperation: "etiquetas de remarketing",
	experimentOperation: "experimentos (reparten tráfico real)",
	experimentArmOperation: "experimentos (reparten tráfico real)",
	campaignDraftOperation: "borradores de campaña",
	bookCampaignsOperation: "reservas (compra de inventario)",
	quoteCampaignsOperation: "reservas",
	smartCampaignSettingOperation: "campañas inteligentes",
	recommendationSubscriptionOperation: "aplicación automática de recomendaciones",
	campaignGroupOperation: "grupos de campañas",
};

/**
 * `remove` sin confirmación reforzada: criterios, vínculos, señales, ajustes y etiquetas. Quitar un vínculo no
 * borra el objeto (el asset, la lista o la campaña siguen existiendo). Cualquier otro remove (campaña, grupo,
 * anuncio, presupuesto, asset group, listas, etiquetas, audiencias…) es elevated.
 */
export const REMOVABLE_OPERATIONS = new Set([
	"campaignCriterionOperation",
	"adGroupCriterionOperation",
	"customerNegativeCriterionOperation",
	"sharedCriterionOperation",
	"campaignAssetOperation",
	"adGroupAssetOperation",
	"assetGroupAssetOperation",
	"customerAssetOperation",
	"assetGroupSignalOperation",
	"assetGroupListingGroupFilterOperation",
	"assetSetAssetOperation",
	"campaignAssetSetOperation",
	"campaignSharedSetOperation",
	"campaignBidModifierOperation",
	"adGroupBidModifierOperation",
	"campaignLabelOperation",
	"adGroupLabelOperation",
	"adGroupAdLabelOperation",
	"adGroupCriterionLabelOperation",
	"customerLabelOperation",
	"campaignCustomizerOperation",
	"adGroupCustomizerOperation",
	"adGroupCriterionCustomizerOperation",
	"customerCustomizerOperation",
	"adParameterOperation",
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

export interface GuardResult {
	/** Motivos por los que el plan exige "APPLY-ELEVATED <plan_id>". Vacío = confirmación normal. */
	elevated: string[];
}

/**
 * Aplica las barreras a un conjunto de MutateOperation (formato REST, camelCase).
 * Lanza GuardError con los bloqueos duros; devuelve los motivos de confirmación reforzada.
 */
export async function enforceGuards(operations: Json[], ctx: GuardContext): Promise<GuardResult> {
	const v: string[] = [];
	const e: string[] = [];
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
		if (HARD_BLOCKED_OPERATIONS[kind]) {
			v.push(`${tag}: ${kind} bloqueado (${HARD_BLOCKED_OPERATIONS[kind]}).`);
			continue;
		}
		if (ELEVATED_OPERATIONS[kind]) e.push(`${tag}: ${kind} (${ELEVATED_OPERATIONS[kind]}).`);
		const actions = ["create", "update", "remove"].filter((a) => op?.[a] !== undefined);
		if (actions.length !== 1) {
			v.push(`${tag}: debe contener exactamente una acción create/update/remove.`);
			continue;
		}
		const action = actions[0];

		// Ningún resource name puede apuntar a otra cuenta.
		for (const rn of collectResourceNames(op)) {
			if (rn !== `customers/${customerId}` && !rn.startsWith(`customers/${customerId}/`)) {
				v.push(`${tag}: referencia a otra cuenta (${rn}). Solo se permite customers/${customerId}/...`);
			}
		}

		if (action === "remove") {
			if (!REMOVABLE_OPERATIONS.has(kind)) {
				e.push(`${tag}: BORRADO irreversible con ${kind} (${op.remove}). Si basta con retirarlo, mejor pausarlo.`);
			}
			continue;
		}

		const body = op[action] as Json;
		const fields = maskFields(op);

		if (kind === "campaignOperation") {
			if (body.biddingStrategy !== undefined || fields.includes("bidding_strategy")) {
				e.push(`${tag}: asigna o cambia una estrategia de puja de cartera compartida (bidding_strategy).`);
			}
			if (action === "create" && body.status !== "PAUSED") {
				e.push(`${tag}: campaña nueva que NO se crea en PAUSED (${body.status ?? "sin status → ENABLED por defecto"}): empezará a gastar al aplicar.`);
			}
			if (action === "update" && body.status === "ENABLED") {
				if (!ctx.allowCampaignEnable) {
					e.push(`${tag}: ACTIVA una campaña (empezará a gastar).`);
				}
			}
		}

		if (body?.status === "REMOVED") {
			e.push(`${tag}: status REMOVED = BORRADO irreversible.`);
		}

		if (kind === "campaignBudgetOperation") {
			const touchesAmount = body.amountMicros !== undefined || fields.includes("amount_micros");
			if (body.totalAmountMicros !== undefined) e.push(`${tag}: presupuesto total de campaña (total_amount_micros).`);
			if (action === "create") {
				const amt = Number(body.amountMicros);
				if (!Number.isFinite(amt) || amt <= 0) e.push(`${tag}: presupuesto sin amountMicros válido.`);
				else if (amt > maxMicros) e.push(`${tag}: presupuesto diario ${fromMicros(amt)} supera MAX_DAILY_BUDGET (${limits.maxDailyBudget}).`);
				if (body.explicitlyShared === true) e.push(`${tag}: crea un presupuesto compartido.`);
			} else if (touchesAmount) {
				const amt = Number(body.amountMicros);
				if (!Number.isFinite(amt) || amt <= 0) {
					e.push(`${tag}: amountMicros inválido.`);
				} else {
					if (amt > maxMicros) e.push(`${tag}: presupuesto diario ${fromMicros(amt)} supera MAX_DAILY_BUDGET (${limits.maxDailyBudget}).`);
					const current = await ctx.getBudget(body.resourceName);
					if (!current) {
						e.push(`${tag}: no se pudo leer el presupuesto actual ${body.resourceName} para comprobar la subida.`);
					} else {
						const maxAllowed = current.amountMicros * (1 + limits.maxBudgetIncreasePct / 100);
						if (amt > current.amountMicros && amt > maxAllowed + 1) {
							e.push(
								`${tag}: subida de ${fromMicros(current.amountMicros)} a ${fromMicros(amt)} (+${(((amt - current.amountMicros) / current.amountMicros) * 100).toFixed(1)}%) supera MAX_BUDGET_INCREASE_PCT (${limits.maxBudgetIncreasePct}%).`,
							);
						}
						if ((current.explicitlyShared || current.referenceCount > 1) && !ctx.allowSharedBudget) {
							e.push(`${tag}: el presupuesto es compartido por ${current.referenceCount} campañas: el cambio afecta a todas.`);
						}
					}
				}
			}
			if (fields.some((f) => f !== "amount_micros" && f !== "name" && f !== "delivery_method")) {
				e.push(`${tag}: modifica campos del presupuesto distintos de importe, nombre o forma de entrega.`);
			}
		}

		// Ningún campo de puja de cartera por la puerta de atrás en otros recursos.
		for (const f of fields) {
			if (f.startsWith("bidding_strategy") && kind !== "campaignOperation") e.push(`${tag}: toca ${f} (estrategias de cartera).`);
		}
	}

	if (v.length) throw new GuardError([...new Set(v)]);
	return { elevated: [...new Set(e)] };
}
