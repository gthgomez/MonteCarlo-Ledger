import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "MonteCarlo Ledger",
    short_name: "MonteCarlo",
    description: "A local-first workspace for cash, upcoming bills, and financial decisions.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f1f2ee",
    theme_color: "#163a31",
    icons: [
      { src: "/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
