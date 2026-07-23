import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Gateway tests bind real ports — keep files sequential.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
