import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Runtime requires, not bundled: the native SQLite driver, and lzma (dynamic require of its worker).
  serverExternalPackages: ["better-sqlite3", "lzma"],
  // Allow phones/tablets on the home network to use the DEV server by LAN IP.
  // (For daily use on devices prefer `npm run build && npm run start:lan`.)
  // Private ranges: 192.168/16, 10/8, 172.16/12 (listed per label — partial wildcards aren't supported).
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*.*`), "*.local"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
