import { DurableObject } from "cloudflare:workers";

const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Cerrojo global de planes (una sola instancia, idFromName("global")). KV no es transaccional y cachea lecturas
 * ~60 s, así que dos apply_plan simultáneos del mismo plan podrían ejecutarse los dos. Un Durable Object procesa
 * las peticiones de una en una: get + put sobre su storage es atómico frente a otras llamadas.
 */
export class PlanLock extends DurableObject<Env> {
	/** true si este llamante se queda el plan; false si ya lo reclamó otro. */
	async claim(planId: string): Promise<boolean> {
		const key = `claim:${planId}`;
		if (await this.ctx.storage.get(key)) return false;
		const now = Date.now();
		await this.ctx.storage.put(key, now);
		// Limpieza perezosa: los planes caducan a los 30 min; los claims se guardan 2 h.
		const old = await this.ctx.storage.list<number>({ prefix: "claim:" });
		const expired = [...old].filter(([, t]) => now - t > CLAIM_TTL_MS).map(([k]) => k);
		if (expired.length) await this.ctx.storage.delete(expired);
		return true;
	}
}
