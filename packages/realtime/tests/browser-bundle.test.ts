/**
 * Proves the export boundary: `@wezesha/realtime/client` must bundle for the
 * browser with zero server dependencies, while the package root (which carries
 * the ioredis publisher) must not. esbuild with platform=browser errors on any
 * node builtin, so a green build here is the isolation proof.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const entry = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

describe("browser bundle safety", () => {
  it("the /client entry bundles for the browser without ioredis or node builtins", async () => {
    const result = await build({
      entryPoints: [entry("../src/client.ts")],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile.inputs).map((p) => p.replace(/\\/g, "/"));
    expect(inputs.some((p) => p.includes("ioredis"))).toBe(false);
    expect(inputs.some((p) => p.includes("src/publish.ts"))).toBe(false);
    // Only the client and the shared contract may be reachable.
    expect(inputs.every((p) => p.endsWith("src/client.ts") || p.endsWith("src/events.ts"))).toBe(
      true
    );
  });

  it("the package root reaches server code (control: the subpath boundary matters)", async () => {
    // Today the root happens to bundle because publish.ts imports ioredis
    // type-only; the moment it (or any future server helper) gains a runtime
    // server dependency, root importers break. This control pins the fact the
    // root pulls in server modules, so browser code must use /client.
    const result = await build({
      entryPoints: [entry("../src/index.ts")],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs).map((p) => p.replace(/\\/g, "/"));
    expect(inputs.some((p) => p.endsWith("src/publish.ts"))).toBe(true);
  });
});
