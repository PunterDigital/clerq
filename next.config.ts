import type { NextConfig } from "next";

import { SECURITY_HEADERS } from "./lib/security-headers";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (docker-compose
  // self-host is a first-class target).
  output: "standalone",
  // No "X-Powered-By: Next.js" (#5584).
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
