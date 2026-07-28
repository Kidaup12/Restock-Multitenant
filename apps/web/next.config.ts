import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Loaded by Node at runtime instead of being bundled: the package resolves
  // the Prisma query engine relative to its own generated-client directory,
  // which bundling would break.
  serverExternalPackages: ["@wezesha/db"],
  // Monorepo: build and trace from the workspace root so the db package is in
  // scope.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // The query engine is opened by path at runtime, not imported, so tracing
  // cannot see it and every deployed request failed on a missing engine while
  // the build reported success. Naming the generated client explicitly puts the
  // engine in the bundle. The tracer's warning about this package was the
  // symptom, not noise.
  outputFileTracingIncludes: {
    "/**": ["packages/db/generated/client/**"],
  },
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
  // Standalone output only when the Docker image build asks for it (see
  // apps/web/Dockerfile); host `next build` + `next start` keep the default.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
};

export default nextConfig;
