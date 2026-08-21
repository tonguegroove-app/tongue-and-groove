import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "child_process";

// Build stamp, shown at the bottom of Settings. This app is an installed PWA,
// so a phone can keep running an old bundle after a fix ships — twice now a bug
// has been re-reported that was already fixed and deployed. The stamp makes
// "which version is actually on the phone" a thing you can read, not guess.
const stamp = (() => {
  try {
    const sha = execSync("git rev-parse --short HEAD").toString().trim();
    // Quote the date format — the space in it splits into a second argument
    // otherwise and git treats it as a pathspec.
    const d = execSync('git log -1 --format=%cd --date=format:"%Y-%m-%d %H:%M"').toString().trim();
    return `${d} · ${sha}`;
  } catch { return "dev"; }
})();

export default defineConfig({
  base: "/tongue-and-groove/",
  define: { __BUILD__: JSON.stringify(stamp) },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/apple-touch-icon.png"],
      manifest: {
        name: "Tongue & Groove",
        short_name: "Tongue & Groove",
        description: "Speech practice — paced word drills",
        theme_color: "#012169",
        background_color: "#F3ECDC",
        display: "standalone",
        orientation: "any",
        start_url: ".",
        scope: ".",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-css" }
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-files",
              expiration: { maxEntries: 20, maxAgeSeconds: 31536000 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ]
});
