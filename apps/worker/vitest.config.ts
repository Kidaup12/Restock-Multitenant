import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The queue suites share one Redis and one queue name — no parallel files.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
