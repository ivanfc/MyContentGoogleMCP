/**
 * Versión de la Google Ads API. Única fuente de verdad.
 * v25 es la última versión publicada en el discovery doc oficial
 * (https://googleads.googleapis.com/$discovery/rest?version=v25, revisión 20260929).
 */
export const GOOGLE_ADS_API_VERSION = "v25";
export const GOOGLE_ADS_BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

/**
 * Caducidad de los planes de cambio (segundos). 24 h: la aprobación humana ("respóndeme OK") puede llegar
 * horas después. Lo que protege de aplicar sobre un estado distinto es el hash de estado,
 * no la caducidad.
 */
export const PLAN_TTL_SECONDS = 24 * 60 * 60;
export const PLAN_TTL_LABEL = "24 h";

/** Límite por defecto de filas devueltas por gaql_search. */
export const DEFAULT_MAX_ROWS = 1000;
export const HARD_MAX_ROWS = 10000;

/** Variables que necesita el núcleo de Google Ads (subset de Env). */
export interface AdsEnv {
	/** Opcional. Desde el 09-09-2026 el acceso lo da el proyecto de Google Cloud del cliente OAuth. */
	GOOGLE_ADS_DEVELOPER_TOKEN?: string;
	GOOGLE_ADS_CLIENT_ID: string;
	GOOGLE_ADS_CLIENT_SECRET: string;
	GOOGLE_ADS_REFRESH_TOKEN: string;
	GOOGLE_ADS_LOGIN_CUSTOMER_ID: string;
	ALLOWED_CUSTOMER_IDS: string;
	MAX_DAILY_BUDGET?: string;
	MAX_BUDGET_INCREASE_PCT?: string;
	STATE_KV: KVNamespace;
}

export interface Limits {
	/**
	 * Modo "mcc" (propietario): credenciales del Worker y una MCC fija (GOOGLE_ADS_LOGIN_CUSTOMER_ID).
	 * Modo "user" (cualquier otro usuario): su propio token de Google; solo ve las cuentas a las que su usuario
	 * de Google tiene acceso (directas o a través de sus MCC). loginCustomerId queda vacío.
	 */
	mode: "mcc" | "user";
	/** Clave de caché/aislamiento de cuentas (MCC o usuario). */
	scopeKey: string;
	loginCustomerId: string;
	allowedCustomerIds: Set<string>;
	/** ALLOWED_CUSTOMER_IDS="*": cualquier cuenta de la jerarquía de la MCC (se verifica contra la API antes de escribir). */
	allowAllUnderMcc: boolean;
	maxDailyBudget: number;
	maxBudgetIncreasePct: number;
}

/**
 * ¿Se puede escribir en esta cuenta? Con "*" la pertenencia a la MCC la verifica el servidor contra la API
 * (customer_client) antes de construir el plan; aquí solo se comprueba la configuración.
 */
export function isWriteAllowed(limits: Limits, customerId: string): boolean {
	return limits.allowAllUnderMcc || limits.allowedCustomerIds.has(customerId);
}

export function normalizeCustomerId(id: string | number): string {
	const clean = String(id).replace(/[^0-9]/g, "");
	if (!/^\d{10}$/.test(clean)) {
		throw new Error(`customer_id inválido: "${id}". Debe tener 10 dígitos (con o sin guiones).`);
	}
	return clean;
}

export function parseList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function parsePositiveNumber(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined || value.trim() === "") return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} inválido: "${value}"`);
	return n;
}

export function getLimits(env: Pick<AdsEnv, "GOOGLE_ADS_LOGIN_CUSTOMER_ID" | "ALLOWED_CUSTOMER_IDS" | "MAX_DAILY_BUDGET" | "MAX_BUDGET_INCREASE_PCT">): Limits {
	const ids = parseList(env.ALLOWED_CUSTOMER_IDS);
	return {
		mode: "mcc",
		scopeKey: `mcc:${normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID)}`,
		loginCustomerId: normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
		allowedCustomerIds: new Set(ids.filter((x) => x !== "*").map(normalizeCustomerId)),
		allowAllUnderMcc: ids.includes("*"),
		maxDailyBudget: parsePositiveNumber(env.MAX_DAILY_BUDGET, 60, "MAX_DAILY_BUDGET"),
		maxBudgetIncreasePct: parsePositiveNumber(env.MAX_BUDGET_INCREASE_PCT, 100, "MAX_BUDGET_INCREASE_PCT"),
	};
}

/** Lista de secretos obligatorios. Devuelve los que faltan (sin imprimir valores). */
export function missingSecrets(env: Record<string, unknown>): string[] {
	const required = [
		"GOOGLE_ADS_CLIENT_ID",
		"GOOGLE_ADS_CLIENT_SECRET",
		"GOOGLE_ADS_REFRESH_TOKEN",
	];
	return required.filter((k) => typeof env[k] !== "string" || (env[k] as string).length === 0);
}

/** Importe en moneda de la cuenta → micros, redondeado a la unidad mínima facturable (0,01). */
export function toMicros(amount: number): number {
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new Error(`Importe inválido: ${amount}. Debe ser un número > 0 en la moneda de la cuenta (no micros).`);
	}
	return Math.round(amount * 100) * 10_000;
}

export function fromMicros(micros: number | string | undefined | null): number {
	if (micros === undefined || micros === null || micros === "") return 0;
	return Number(micros) / 1_000_000;
}

/** Límites de un usuario que entra con su propia cuenta de Google: puede escribir en las cuentas a las que tiene acceso. */
export function userLimits(env: Pick<AdsEnv, "MAX_DAILY_BUDGET" | "MAX_BUDGET_INCREASE_PCT">, email: string): Limits {
	return {
		mode: "user",
		scopeKey: `user:${email.toLowerCase()}`,
		loginCustomerId: "",
		allowedCustomerIds: new Set(),
		allowAllUnderMcc: true,
		maxDailyBudget: parsePositiveNumber(env.MAX_DAILY_BUDGET, 60, "MAX_DAILY_BUDGET"),
		maxBudgetIncreasePct: parsePositiveNumber(env.MAX_BUDGET_INCREASE_PCT, 100, "MAX_BUDGET_INCREASE_PCT"),
	};
}
