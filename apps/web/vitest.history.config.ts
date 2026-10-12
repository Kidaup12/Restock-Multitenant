import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/product-timeline.test.ts", "tests/period-inventory.test.ts"] } });
