import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native SQLite driver must stay a runtime require, not bundled.
  serverExternalPackages: ["better-sqlite3"],
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
