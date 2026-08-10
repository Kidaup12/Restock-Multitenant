import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The SDK's own load is paid once in a beforeAll with its own budget, so a
    // test that overruns this is the wrapper being slow, not the loader.
    testTimeout: 30_000,
  },
});
