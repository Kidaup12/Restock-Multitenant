import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/setup-env.ts"],
    globalSetup: ["tests/require-infra.ts"],
    // The isolation suite seeds and asserts against one database — no parallel files.
    fileParallelism: false,
    passWithNoTests: true,
  },
});
