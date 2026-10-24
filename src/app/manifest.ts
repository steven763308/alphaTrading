import type { MetadataRoute } from "next";

/** Lets iPhone/iPad/Android "Add to Home Screen" open TradeLab full-screen like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ByteX TradeLab",
    short_name: "TradeLab",
    description: "Paper trading simulator, backtester and trade journal. Simulation only.",
    start_url: "/simulator",
    display: "standalone",
    orientation: "any",
    background_color: "#0b0e13",
    theme_color: "#0b0e13",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
