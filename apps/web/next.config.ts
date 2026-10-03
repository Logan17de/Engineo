import type { NextConfig } from "next";

const apiOrigin = process.env.ENGINEO_API_ORIGIN ?? "http://127.0.0.1:4000";
const parsedOrigin = new URL(apiOrigin);
if (!["http:", "https:"].includes(parsedOrigin.protocol) || parsedOrigin.origin !== apiOrigin) {
  throw new Error(
    "ENGINEO_API_ORIGIN must be a fixed HTTP(S) origin without credentials or a path",
  );
}
const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/:path*` }];
  },
  transpilePackages: ["@engineo/contracts"],
};

export default nextConfig;
