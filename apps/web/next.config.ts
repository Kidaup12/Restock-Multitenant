import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Loaded by Node at runtime instead of being bundled: the package resolves
  // the Prisma query engine relative to its own generated-client directory,
  // which bundling would break.
  serverExternalPackages: ["@wezesha/db"],
  // Monorepo: build and trace from the workspace root so the db package is in
  // scope. The build still logs one NFT warning — the generated Prisma client
  // carries cwd-relative fallback lookups the tracer flags; harmless, since
  // the package is external and loaded from disk.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

export default nextConfig;
