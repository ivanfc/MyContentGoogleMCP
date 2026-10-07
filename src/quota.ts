import { DurableObject } from "cloudflare:workers";
import { type QuotaConfig, type QuotaState, decide } from "./quota-policy";

export type { QuotaConfig, QuotaState } from "./quota-policy";

export class UsageQuota extends DurableObject<Env> {
	async consume(user: string, owner: boolean, n: number, cfg: QuotaConfig): Promise<{ ok: boolean; reason?: string; used: number }> {
		const today = new Date().toISOString().slice(0, 10);
		const prev = await this.ctx.storage.get<QuotaState>("state");
		const d = decide(prev, today, user, owner, n, cfg);
		if (d.ok || !prev || prev.day !== today) await this.ctx.storage.put("state", d.state);
		return { ok: d.ok, reason: d.ok ? undefined : d.reason, used: d.state.users[user] ?? 0 };
	}

	async usage(): Promise<QuotaState | undefined> {
		return this.ctx.storage.get<QuotaState>("state");
	}
}

