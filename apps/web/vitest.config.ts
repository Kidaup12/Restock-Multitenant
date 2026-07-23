import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror the tsconfig "@/*" path alias.
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    setupFiles: ["tests/setup-env.ts"],
    // The auth flow suite signs up real users in one local database; password
    // hashing makes individual steps slow, more so on a loaded machine.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
