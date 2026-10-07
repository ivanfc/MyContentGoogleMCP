/**
 * Cuota diaria de operaciones de la Google Ads API. Es del proyecto de Google Cloud (Basic: 15.000/día) y la comparten
 * todos los usuarios del MCP. Un Durable Object global la reparte: el propietario tiene reservado todo lo que los
 * demás no pueden gastar, y cada usuario que no es propietario tiene además su propio tope diario.
 * El día es el natural UTC (Google usa una ventana móvil de 24 h; por eso el total queda por debajo de 15.000).
 */
export interface QuotaConfig {
	total: number;
	others: number;
	perUser: number;
}

export interface QuotaState {
	day: string;
	total: number;
	others: number;
	users: Record<string, number>;
}

export type QuotaDecision = { ok: true; state: QuotaState } | { ok: false; reason: string; state: QuotaState };

export function decide(prev: QuotaState | undefined, today: string, user: string, owner: boolean, n: number, cfg: QuotaConfig): QuotaDecision {
	const s: QuotaState = prev && prev.day === today ? { ...prev, users: { ...prev.users } } : { day: today, total: 0, others: 0, users: {} };
	const used = s.users[user] ?? 0;
	if (s.total + n > cfg.total) return { ok: false, state: s, reason: `Cuota diaria del MCP agotada (${s.total}/${cfg.total} operaciones de la API hoy). Se renueva a las 00:00 UTC.` };
	if (!owner && s.others + n > cfg.others) {
		return { ok: false, state: s, reason: `Cuota diaria para usuarios invitados agotada (${s.others}/${cfg.others} operaciones). Se renueva a las 00:00 UTC.` };
	}
	if (!owner && used + n > cfg.perUser) return { ok: false, state: s, reason: `Has agotado tu cuota diaria (${used}/${cfg.perUser} operaciones de la API). Se renueva a las 00:00 UTC.` };
	s.total += n;
	if (!owner) s.others += n;
	s.users[user] = used + n;
	return { ok: true, state: s };
}
