import { describe, expect, it } from "vitest";
import { omittedFields, selectedFields } from "../src/ads/gaql";

describe("gaql: campos omitidos por valor por defecto", () => {
	const q = "SELECT ad_group.id, ad_group.name, ad_group.optimized_targeting_enabled, metrics.cost_micros FROM ad_group WHERE campaign.id = 1";
	it("extrae el SELECT", () => {
		expect(selectedFields(q)).toEqual(["ad_group.id", "ad_group.name", "ad_group.optimized_targeting_enabled", "metrics.cost_micros"]);
	});
	it("lista los campos ausentes (false/0 omitidos por la API) con el número de filas", () => {
		const rows = [
			{ adGroup: { id: "1", name: "UAE" } },
			{ adGroup: { id: "2", name: "Rest", optimizedTargetingEnabled: true }, metrics: { costMicros: "10" } },
		];
		expect(omittedFields(q, rows)).toEqual({ "ad_group.optimized_targeting_enabled": 1, "metrics.cost_micros": 1 });
	});
	it("sin filas no informa nada", () => {
		expect(omittedFields(q, [])).toEqual({});
	});
});
