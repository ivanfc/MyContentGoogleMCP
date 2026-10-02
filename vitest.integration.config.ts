import { defineConfig } from "vitest/config";

// Pruebas contra la cuenta REAL. Solo lectura y validateOnly: nunca llaman a apply_plan.
export default defineConfig({ test: { include: ["integration/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000, reporters: ["verbose"] } });
