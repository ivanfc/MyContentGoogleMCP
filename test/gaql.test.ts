import { describe, expect, it } from "vitest";
import { addMissingSelectFields, omittedFields, selectedFields } from "../src/ads/gaql";

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

describe("addMissingSelectFields", () => {
	const err = [{ errorCode: "queryError.EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE", message: "The following field must be present in SELECT clause: 'campaign.status'." }];
	it("añade al SELECT el campo que Google exige y nada más", () => {
		const q = "SELECT campaign.name, campaign_asset.status FROM campaign_asset WHERE campaign.status = 'ENABLED'";
		expect(addMissingSelectFields(q, err)).toEqual({
			query: "SELECT campaign.status, campaign.name, campaign_asset.status FROM campaign_asset WHERE campaign.status = 'ENABLED'",
			added: ["campaign.status"],
		});
	});
	it("no toca otros errores ni campos ya presentes", () => {
		expect(addMissingSelectFields("SELECT campaign.status FROM campaign", err)).toBeUndefined();
		expect(addMissingSelectFields("SELECT campaign.name FROM campaign", [{ errorCode: "queryError.BAD_ENUM_CONSTANT", message: "'x.y'" }])).toBeUndefined();
	});
});
