import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { parseList } from "../config";
import {
	OAuthError,
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

/** Datos del usuario autenticado, cifrados dentro del token MCP y expuestos como this.props. */
export type Props = {
	name: string;
	email: string;
};

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

export function isEmailAllowed(email: string | undefined, allowedEmails: string | undefined): boolean {
	if (!email) return false;
	const allowed = parseList(allowedEmails).map((e) => e.toLowerCase());
	return allowed.includes(email.toLowerCase());
}

app.get("/", (c) => c.text("mycontent-google-ads-mcp: endpoint MCP en /mcp (Streamable HTTP) y /sse (legacy)."));

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) return c.text("Invalid request", 400);

	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie } = await bindStateToSession(stateToken);
		return redirectToGoogle(c.req.raw, c.env, stateToken, { "Set-Cookie": setCookie });
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();
	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description: "Conector MCP de MyContent para leer y modificar Google Ads con barreras de seguridad (plan + apply).",
			name: "MyContent Google Ads MCP",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();
		validateCSRFToken(formData, c.req.raw);
		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") return c.text("Missing state in form data", 400);
		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch {
			return c.text("Invalid state data", 400);
		}
		if (!state.oauthReqInfo?.clientId) return c.text("Invalid request", 400);

		const approvedClientCookie = await addApprovedClient(c.req.raw, state.oauthReqInfo.clientId, c.env.COOKIE_ENCRYPTION_KEY);
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);
		return redirectToGoogle(c.req.raw, c.env, stateToken, Object.fromEntries(headers));
	} catch (error: any) {
		if (error instanceof OAuthError) return error.toResponse();
		console.error("POST /authorize error:", error?.message);
		return c.text("Internal server error", 500);
	}
});

function redirectToGoogle(request: Request, env: Env, stateToken: string, headers: Record<string, string> = {}) {
	const upstream = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	upstream.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID);
	upstream.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
	upstream.searchParams.set("scope", "openid email profile");
	upstream.searchParams.set("response_type", "code");
	upstream.searchParams.set("prompt", "select_account");
	upstream.searchParams.set("state", stateToken);
	return new Response(null, { status: 302, headers: { ...headers, location: upstream.href } });
}

app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;
	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) return error.toResponse();
		return c.text("Internal server error", 500);
	}
	if (!oauthReqInfo.clientId) return c.text("Invalid OAuth request data", 400);

	const code = c.req.query("code");
	if (!code) return c.text("Missing code", 400);

	const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: c.env.GOOGLE_OAUTH_CLIENT_ID,
			client_secret: c.env.GOOGLE_OAUTH_CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: new URL("/callback", c.req.url).href,
		}).toString(),
	});
	if (!tokenRes.ok) return c.text("No se pudo completar el login con Google.", 502);
	const { access_token } = (await tokenRes.json()) as { access_token?: string };
	if (!access_token) return c.text("Google no devolvió access token.", 502);

	const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${access_token}` } });
	if (!userRes.ok) return c.text("No se pudo leer el perfil de Google.", 502);
	const user = (await userRes.json()) as { sub: string; email?: string; email_verified?: boolean; name?: string };

	if (!user.email_verified || !isEmailAllowed(user.email, c.env.ALLOWED_EMAILS)) {
		console.warn("Login denegado (email fuera de ALLOWED_EMAILS)", user.email);
		return c.text(`403 Forbidden: ${user.email ?? "este usuario"} no tiene acceso a este conector.`, 403);
	}

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: user.name ?? user.email },
		props: { email: user.email!, name: user.name ?? user.email! } satisfies Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: user.sub,
	});
	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) headers.set("Set-Cookie", clearSessionCookie);
	return new Response(null, { status: 302, headers });
});

export { app as GoogleHandler };
