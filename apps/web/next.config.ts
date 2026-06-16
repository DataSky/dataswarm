import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["dataswarm-dev.metad.ai"],
  serverExternalPackages: ["node:sqlite"],
};

export default nextConfig;
