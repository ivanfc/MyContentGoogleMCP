import { describe, expect, it } from "vitest";
import { GoogleAdsApiError } from "../src/ads/client";
import { describeGaqlFields, gaqlHint } from "../src/ads/fields";
import { customAudienceBody } from "../src/plans/builders";
import { buildGenericPlan } from "../src/plans/generic";
import { CID, MemoryKV, setup } from "./helpers";

const apiErr = (code: string, message: string) => new GoogleAdsApiError(400, "INVALID_ARGUMENT", "bad", "r1", [{ errorCode: code, message }]);

describe("pistas de GAQL", () => {
	it("UNRECOGNIZED_FIELD sugiere campos parecidos del mismo recurso", async () => {
		const { ads, client } = setup();
		ads.onFields(/WHERE name IN/, [{ name: "ad_group_ad.status" }]);
		ads.onFields(/LIKE 'ad_group_ad\.%'/, [{ name: "ad_group_ad.policy_summary.approval_status" }, { name: "ad_group_ad.status" }, { name: "ad_group_ad.ad.id" }]);
		const q = "SELECT ad_group_ad.approval_status, ad_group_ad.status FROM ad_group_ad";
		const h = await gaqlHint(client, undefined, q, apiErr("queryError.UNRECOGNIZED_FIELD", "Unrecognized field in the query: 'ad_group_ad.approval_status'."));
		expect(h).toMatch(/"ad_group_ad.approval_status" no existe\. Parecidos: ad_group_ad\.policy_summary\.approval_status/);
	});

	it("BAD_ENUM_CONSTANT lista los valores válidos", async () => {
		const { ads, client } = setup();
		ads.onFields(/WHERE name IN/, [{ name: "campaign.advertising_channel_type", dataType: "ENUM", enumValues: ["SEARCH", "DEMAND_GEN", "UNSPECIFIED"] }]);
		const q = "SELECT campaign.id FROM campaign WHERE campaign.advertising_channel_type = 'DISCOVERY'";
		const h = await gaqlHint(client, undefined, q, apiErr("queryError.BAD_ENUM_CONSTANT", "Invalid enum value."));
		expect(h).toMatch(/campaign\.advertising_channel_type: DISCOVERY no es válido\. Valores: SEARCH, DEMAND_GEN\./);
	});

	it("campos incompatibles con el FROM", async () => {
		const { ads, client } = setup();
		ads.onFields(/WHERE name IN \('keyword_view'\)/, [{ name: "keyword_view", selectableWith: ["ad_group", "campaign", "metrics.clicks", "segments.date"] }]);
		const q = "SELECT keyword_view.resource_name, asset.name, metrics.clicks, metrics.video_views FROM keyword_view";
		const h = await gaqlHint(client, undefined, q, apiErr("queryError.PROHIBITED_FIELD_IN_SELECT_CLAUSE", "x"));
		expect(h).toMatch(/Con FROM keyword_view no se pueden pedir: asset\.name, metrics\.video_views/);
	});

	it("los metadatos se cachean en KV (una sola llamada a la API)", async () => {
		const { ads, client } = setup();
		const kv = new MemoryKV() as unknown as KVNamespace;
		ads.onFields(/WHERE name IN \('campaign'\)/, [{ name: "campaign", selectableWith: ["segments.date", "metrics.clicks"] }]);
		ads.onFields(/LIKE 'campaign\.%'/, [{ name: "campaign.status" }, { name: "campaign.name" }]);
		const a = await describeGaqlFields(client, kv, "campaign");
		await describeGaqlFields(client, kv, "campaign");
		expect(a.attributes).toEqual(["campaign.status", "campaign.name"]);
		expect(a.segments).toEqual(["segments.date"]);
		expect(ads.fieldQueries).toHaveLength(2);
	});
});

describe("plan genérico: lectura de estado agrupada", () => {
	it("3 updates del mismo recurso y campos → 1 consulta con IN", async () => {
		const { ads, client } = setup();
		const C = (n: number) => `customers/${CID}/campaigns/${n}`;
		ads.on(/FROM campaign WHERE campaign.resource_name IN/, [1, 2, 3].map((n) => ({ campaign: { resourceName: C(n), status: "ENABLED" } })));
		const ops = [1, 2, 3].map((n) => ({ campaignOperation: { update: { resourceName: C(n), status: "PAUSED" }, updateMask: "status" } }));
		const d = await buildGenericPlan(client, CID, ops);
		expect(ads.queries.filter((q) => q.includes("FROM campaign"))).toHaveLength(1);
		expect(d.stateQueries).toHaveLength(1);
		expect(d.summary.join("\n")).toMatch(/#2 campaignOperation UPDATE .*campaigns\/3: status: "ENABLED" → "PAUSED"/);
	});
});

describe("segmentos personalizados", () => {
	it("acepta un dominio suelto como https://", () => {
		const b = customAudienceBody("x", [], ["aparcand.com"]);
		expect(b.members[0].url).toBe("https://aparcand.com");
	});
});
