import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/*.unit.test.ts", "tests/planner.test.ts", "tests/match-gap-time.test.ts", "tests/validate.test.ts"] } });
