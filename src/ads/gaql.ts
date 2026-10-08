import type { Json } from "./client";

export const OMITTED_NOTE =
	'La API de Google Ads (JSON) no devuelve los campos con valor por defecto: un booleano ausente es false, un número ausente es 0, un texto ausente es "" y un enum ausente es UNSPECIFIED (o el campo no está definido). No significa "sin dato".';

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Campos del SELECT de una consulta GAQL (rutas snake_case). */
export function selectedFields(query: string): string[] {
	const m = query.match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\s/i);
	if (!m) return [];
	return m[1]
		.split(",")
		.map((f) => f.trim())
		.filter((f) => /^[a-z_][a-z0-9_.]*$/i.test(f));
}

function has(row: Json, path: string[]): boolean {
	let cur: unknown = row;
	for (const p of path) {
		if (!cur || typeof cur !== "object" || !(p in (cur as object))) return false;
		cur = (cur as Json)[p];
	}
	return true;
}

/** Campos pedidos en el SELECT que faltan en alguna fila → número de filas en que faltan. */
export function omittedFields(query: string, rows: Json[]): Record<string, number> {
	const out: Record<string, number> = {};
	if (!rows.length) return out;
	for (const f of selectedFields(query)) {
		const path = f.split(".").map(camel);
		const missing = rows.filter((r) => !has(r, path)).length;
		if (missing) out[f] = missing;
	}
	return out;
}

/**
 * Error de GAQL que se corrige sin cambiar lo que se pide: Google exige que los campos usados en WHERE/ORDER BY
 * estén también en el SELECT y dice exactamente cuáles. Devuelve la consulta con esos campos añadidos, o undefined.
 */
export function addMissingSelectFields(query: string, details: { errorCode?: string; message?: string }[]): { query: string; added: string[] } | undefined {
	const fields = details
		.filter((d) => d.errorCode === "queryError.EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE")
		.flatMap((d) => [...String(d.message ?? "").matchAll(/'([a-z_][a-z0-9_.]*)'/gi)].map((m) => m[1]));
	const have = new Set(selectedFields(query).map((f) => f.toLowerCase()));
	const added = [...new Set(fields)].filter((f) => !have.has(f.toLowerCase()));
	if (!added.length || !/^\s*SELECT\s/i.test(query)) return undefined;
	return { query: query.replace(/^\s*SELECT\s+/i, (s) => `${s}${added.join(", ")}, `), added };
}
