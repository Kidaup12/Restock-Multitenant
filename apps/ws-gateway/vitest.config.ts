import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/setup-env.ts"],
    globalSetup: ["tests/require-infra.ts"],
    // Gateway tests bind real ports — keep files sequential.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
