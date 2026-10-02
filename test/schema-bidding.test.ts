import { describe, expect, it } from "vitest";
import { describeOperation, listOperations } from "../src/ads/schema";
import { biddingVariants } from "../src/plans/bidding";

const P = "GoogleAdsGoogleadsV25";
const discovery = {
	schemas: {
		[`${P}Services__MutateOperation`]: { properties: { campaignOperation: { $ref: `${P}Services__CampaignOperation` }, conversionActionOperation: { $ref: "x" }, keywordPlanOperation: { $ref: "y" } } },
		[`${P}Services__CampaignOperation`]: { properties: { create: { $ref: `${P}Resources__Campaign` }, update: { $ref: `${P}Resources__Campaign` }, remove: { type: "string" }, updateMask: { type: "string" } } },
		[`${P}Resources__Campaign`]: {
			description: "A campaign.",
			properties: {
				id: { type: "string", description: "Output only. ID." },
				name: { type: "string", description: "Name of the campaign." },
				advertisingChannelType: { type: "string", description: "Immutable. Channel.", enum: ["UNSPECIFIED", "UNKNOWN", "SEARCH", "DISPLAY"] },
				networkSettings: { $ref: `${P}Resources_Campaign_NetworkSettings`, description: "Network settings." },
			},
		},
		[`${P}Resources_Campaign_NetworkSettings`]: { properties: { targetSearchNetwork: { type: "boolean", description: "Search partners." } } },
	},
};

describe("describe_mutate_operation", () => {
	it("lista operaciones con su estado en las barreras", () => {
		const l = listOperations(discovery);
		expect(l.find((x) => x.operation === "campaignOperation")?.guards).toMatch(/^permitida/);
		expect(l.find((x) => x.operation === "conversionActionOperation")?.guards).toMatch(/confirmación reforzada/);
		expect(l.find((x) => x.operation === "keywordPlanOperation")?.guards).toMatch(/^permitida/);
	});
	it("devuelve campos modificables (sin output only), anidados, enums limpios e inmutables marcados", () => {
		const d = describeOperation(discovery, "campaignOperation", 2);
		const paths = d.fields.map((f) => f.path);
		expect(paths).toEqual(["name", "advertisingChannelType", "networkSettings", "networkSettings.targetSearchNetwork"]);
		expect(d.fields[1]).toMatchObject({ flags: ["inmutable (solo en create)"], enum: ["SEARCH", "DISPLAY"] });
		expect(d.actions).toEqual(["create", "update", "remove"]);
		expect(describeOperation(discovery, "campaignOperation", 2, "network").fields).toHaveLength(2);
		expect(() => describeOperation(discovery, "nope", 2)).toThrow(/desconocida/);
	});
});

describe("estrategias de puja", () => {
	it("tCPA: prueba maximize_conversions y luego target_cpa, en micros", () => {
		const v = biddingVariants({ strategy: "MAXIMIZE_CONVERSIONS", target_cpa: 45 });
		expect(v.map((x) => x.updateMask)).toEqual(["maximize_conversions.target_cpa_micros", "target_cpa.target_cpa_micros"]);
		expect(v[0].update).toEqual({ maximizeConversions: { targetCpaMicros: "45000000" } });
	});
	it("tROAS como ratio; max clicks con techo de CPC; manual CPC", () => {
		expect(biddingVariants({ strategy: "MAXIMIZE_CONVERSION_VALUE", target_roas: 4 })[0].update).toEqual({ maximizeConversionValue: { targetRoas: 4 } });
		expect(biddingVariants({ strategy: "MAXIMIZE_CLICKS", max_cpc: 2 })[0].update).toEqual({ targetSpend: { cpcBidCeilingMicros: "2000000" } });
		expect(biddingVariants({ strategy: "MANUAL_CPC" })[0].updateMask).toBe("manual_cpc.enhanced_cpc_enabled");
	});
});
