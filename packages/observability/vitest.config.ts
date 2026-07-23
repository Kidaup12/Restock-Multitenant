import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // First import of the SDK can be slow on a loaded machine.
    testTimeout: 30_000,
  },
});
