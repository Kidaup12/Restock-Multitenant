import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The framework's dev badge sits in the bottom-left corner, which is where the
  // rail's own account control lives — it covers a real button while reviewing
  // the shell locally. Development-only chrome, so switching it off costs
  // nothing and stops it being mistaken for ours.
  devIndicators: false,
  // Loaded by Node at runtime instead of being bundled: the package resolves
  // the Prisma query engine relative to its own generated-client directory,
  // which bundling would break.
  serverExternalPackages: ["@wezesha/db"],
  // Monorepo: build and trace from the workspace root so the db package is in
  // scope.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // The client now generates to its default place inside node_modules, which is
  // where Prisma looks for the engine and where hosting platforms already know
  // to copy it from. Generating to a path of our own put the engine somewhere
  // only our own build understood, and every deployed request failed on it.
  outputFileTracingIncludes: {
    "/**": ["node_modules/.prisma/client/**"],
  },
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
  // Standalone output only when the Docker image build asks for it (see
  // apps/web/Dockerfile); host `next build` + `next start` keep the default.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
};

export default nextConfig;
