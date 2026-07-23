import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output only when the Docker image build asks for it (see
  // apps/web/Dockerfile); host `next build` + `next start` keep the default.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
};

export default nextConfig;
