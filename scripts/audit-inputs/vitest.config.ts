import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["scripts/audit-inputs/*.test.ts"] } });
