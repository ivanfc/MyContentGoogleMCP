import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleHandler } from "../src/auth/google-handler";
import { bindStateToSession, createOAuthState } from "../src/auth/workers-oauth-utils";
import { MemoryKV } from "./helpers";

/** Simula Google (token + userinfo) y recorre /callback del handler real. */
async function callback(email: string, verified = true) {
	const kv = new MemoryKV();
	const completeAuthorization = vi.fn(async () => ({ redirectTo: "https://claude.ai/api/mcp/auth_callback?code=abc" }));
	const env = {
		OAUTH_KV: kv,
		OAUTH_PROVIDER: { completeAuthorization },
		GOOGLE_OAUTH_CLIENT_ID: "client",
		GOOGLE_OAUTH_CLIENT_SECRET: "secret",
		ALLOWED_EMAILS: "ivan@mycontent.agency",
		COOKIE_ENCRYPTION_KEY: "k",
	};
	const oauthReqInfo = { clientId: "c1", redirectUri: "https://claude.ai/api/mcp/auth_callback", scope: [], state: "s", responseType: "code" };
	const { stateToken } = await createOAuthState(oauthReqInfo as any, kv as any);
	const { setCookie } = await bindStateToSession(stateToken);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "g-token" });
			if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) return Response.json({ sub: "123", email, email_verified: verified, name: "X" });
			return new Response("unexpected", { status: 500 });
		}),
	);
	const res = await GoogleHandler.fetch(
		new Request(`https://mcp.example.com/callback?code=thecode&state=${encodeURIComponent(stateToken)}`, { headers: { Cookie: setCookie.split(";")[0] } }),
		env as any,
	);
	return { res, completeAuthorization };
}

afterEach(() => vi.unstubAllGlobals());

describe("login con Google + ALLOWED_EMAILS", () => {
	it("email permitido: completa la autorización y redirige al cliente MCP", async () => {
		const { res, completeAuthorization } = await callback("ivan@mycontent.agency");
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toContain("claude.ai");
		expect(completeAuthorization).toHaveBeenCalledOnce();
		expect((completeAuthorization.mock.calls[0] as any)[0].props).toEqual({ email: "ivan@mycontent.agency", name: "X" });
	});

	it("email fuera de la lista: 403 y no se emite token", async () => {
		const { res, completeAuthorization } = await callback("intruso@gmail.com");
		expect(res.status).toBe(403);
		expect(await res.text()).toContain("403");
		expect(completeAuthorization).not.toHaveBeenCalled();
	});

	it("email no verificado: 403", async () => {
		const { res } = await callback("ivan@mycontent.agency", false);
		expect(res.status).toBe(403);
	});
});
