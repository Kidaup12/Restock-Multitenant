import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/owner-report-sections.test.ts", "tests/owner-report-planning.test.ts"] } });
