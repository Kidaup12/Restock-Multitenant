import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["tests/require-infra.ts"],
    passWithNoTests: true,
  },
});
