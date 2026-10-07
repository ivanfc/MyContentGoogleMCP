import { describe, expect, it } from "vitest";
import { buildPath, catalog, findMethod, guardApiCall, listMethods, mutateRedirect, type ApiCall } from "../src/plans/apicall";
import { applyPlan, createPlan, getAuditLog } from "../src/plans/engine";
import { GuardError } from "../src/guards";
import { CID, setup } from "./helpers";

const P = "GoogleAdsGoogleadsV25";
const discovery = {
	schemas: {
		[`${P}Services__MutateOperation`]: { properties: { campaignOperation: { $ref: "x" }, adGroupCriterionOperation: { $ref: "y" } } },
		[`${P}Services__ApplyRecommendationRequest`]: { properties: { operations: { type: "array", items: { type: "object" } } } },
		[`${P}Services__MutateUserListsRequest`]: { properties: { operations: { type: "array", items: { type: "object" } }, validateOnly: { type: "boolean" } } },
		[`${P}Services__GenerateKeywordIdeasRequest`]: { properties: { language: { type: "string", description: "The resource name of the language." } } },
	},
	resources: {
		customers: {
			methods: {
				generateKeywordIdeas: { id: "googleads.customers.generateKeywordIdeas", httpMethod: "POST", path: "v25/customers/{+customerId}:generateKeywordIdeas", request: { $ref: `${P}Services__GenerateKeywordIdeasRequest` }, parameters: { customerId: {} } },
			},
			resources: {
				recommendations: {
					methods: {
						apply: { id: "googleads.customers.recommendations.apply", httpMethod: "POST", path: "v25/customers/{+customerId}/recommendations:apply", request: { $ref: `${P}Services__ApplyRecommendationRequest` }, parameters: { customerId: {} } },
						dismiss: { id: "googleads.customers.recommendations.dismiss", httpMethod: "POST", path: "v25/customers/{+customerId}/recommendations:dismiss", parameters: { customerId: {} } },
					},
				},
				userLists: {
					methods: { mutate: { id: "googleads.customers.userLists.mutate", httpMethod: "POST", path: "v25/customers/{+customerId}/userLists:mutate", request: { $ref: `${P}Services__MutateUserListsRequest` }, parameters: { customerId: {} } } },
				},
				campaigns: {
					methods: { mutate: { id: "googleads.customers.campaigns.mutate", httpMethod: "POST", path: "v25/customers/{+customerId}/campaigns:mutate", parameters: { customerId: {} } } },
				},
				adGroupCriteria: {
					methods: { mutate: { id: "googleads.customers.adGroupCriteria.mutate", httpMethod: "POST", path: "v25/customers/{+customerId}/adGroupCriteria:mutate", parameters: { customerId: {} } } },
				},
			},
		},
	},
};

describe("catálogo de métodos", () => {
	it("clasifica lectura/escritura y detecta validateOnly", () => {
		const c = catalog(discovery);
		expect(c.find((m) => m.id.endsWith("generateKeywordIdeas"))?.kind).toBe("read");
		expect(c.find((m) => m.id.endsWith("recommendations.apply"))?.kind).toBe("write");
		expect(c.find((m) => m.id.endsWith("userLists.mutate"))?.supportsValidateOnly).toBe(true);
		expect(c.find((m) => m.id.endsWith("recommendations.apply"))?.supportsValidateOnly).toBe(false);
		expect(findMethod(discovery, "customers.recommendations.apply").path).toBe("customers/{+customerId}/recommendations:apply");
		expect(() => findMethod(discovery, "customers.nope")).toThrow(/desconocido/);
	});

	it("los :mutate de recursos del mutate general se redirigen a plan_generic_mutate", () => {
		expect(mutateRedirect(discovery, findMethod(discovery, "customers.campaigns.mutate"))).toBe("campaignOperation");
		expect(mutateRedirect(discovery, findMethod(discovery, "customers.adGroupCriteria.mutate"))).toBe("adGroupCriterionOperation");
		expect(mutateRedirect(discovery, findMethod(discovery, "customers.userLists.mutate"))).toBeUndefined();
		expect(listMethods(discovery, "campaigns")[0].tool).toBe("plan_generic_mutate");
	});

	it("resuelve la ruta y valida parámetros", () => {
		const m = findMethod(discovery, "customers.recommendations.apply");
		expect(buildPath(m, { customerId: "846-051-4008" })).toBe(`customers/${CID}/recommendations:apply`);
		expect(() => buildPath(m, {})).toThrow(/customerId/);
	});
});

describe("barreras de plan_api_call", () => {
	const { limits } = setup();
	const call = (methodId: string, path: string, body = {}): ApiCall => ({ methodId, httpMethod: "POST", path, body, supportsValidateOnly: false });

	it("dismiss de recomendaciones: confirmación normal", () => {
		expect(guardApiCall(call("googleads.customers.recommendations.dismiss", `customers/${CID}/recommendations:dismiss`), CID, limits)).toEqual([]);
	});
	it("aplicar recomendaciones y Customer Match: confirmación reforzada con motivo", () => {
		expect(guardApiCall(call("googleads.customers.recommendations.apply", `customers/${CID}/recommendations:apply`), CID, limits)[0]).toMatch(/recomendaciones/);
		expect(guardApiCall(call("googleads.customers.offlineUserDataJobs.create", `customers/${CID}/offlineUserDataJobs:create`), CID, limits)[0]).toMatch(/PII/);
		expect(guardApiCall(call("googleads.customers.billingSetups.mutate", `customers/${CID}/billingSetups:mutate`), CID, limits)[0]).toMatch(/facturación/);
	});
	it("cuenta no permitida u otra cuenta en el body: bloqueo duro", () => {
		expect(() => guardApiCall(call("googleads.customers.recommendations.dismiss", "customers/1111111111/recommendations:dismiss"), "1111111111", limits)).toThrow(GuardError);
		expect(() =>
			guardApiCall(call("googleads.customers.recommendations.dismiss", `customers/${CID}/recommendations:dismiss`, { operations: [{ resourceName: "customers/2222222222/recommendations/x" }] }), CID, limits),
		).toThrow(/otra cuenta/);
	});
});

describe("plan → apply de una llamada a la API", () => {
	it("valida con validateOnly si el método lo admite, exige APPLY-ELEVATED y ejecuta exactamente el body guardado", async () => {
		const { deps } = setup();
		const calls: { url: string; body: any }[] = [];
		(deps.client as any).fetchImpl = async (url: string, init?: RequestInit) => {
			if (url.includes("oauth2")) return Response.json({ access_token: "t", expires_in: 3600 });
			const body = JSON.parse(String(init?.body ?? "{}"));
			calls.push({ url, body });
			return Response.json(body.validateOnly ? {} : { results: [{ resourceName: `customers/${CID}/userLists/77` }] });
		};
		const apiCall: ApiCall = {
			methodId: "googleads.customers.userLists.mutate",
			httpMethod: "POST",
			path: `customers/${CID}/userLists:mutate`,
			body: { operations: [{ create: { name: "Visitantes 30d" } }] },
			supportsValidateOnly: true,
		};
		const r = await createPlan(deps, { kind: "api_call", customerId: CID, summary: ["x"], operations: [], stateQueries: [], apiCall });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(calls[0].body.validateOnly).toBe(true);
		expect(r.confirm_with).toBe(`APPLY-ELEVATED ${r.plan_id}`);
		expect((await applyPlan(deps, r.plan_id, `APPLY ${r.plan_id}`)).ok).toBe(false);
		const a = await applyPlan(deps, r.plan_id, `APPLY-ELEVATED ${r.plan_id}`);
		expect(a.ok).toBe(true);
		expect(calls.at(-1)!.body).toEqual(apiCall.body);
		const [log] = await getAuditLog(deps.kv, 1, deps.userEmail);
		expect(log.outcome).toBe("APPLIED");
		expect(log.resource_names).toContain(`customers/${CID}/userLists/77`);
	});
});
