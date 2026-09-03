import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "child_process";
import { fileURLToPath } from "node:url";

// Two build targets from one source tree:
//   npm run build         → GitHub Pages PWA, unchanged from before
//   npm run build:native  → asset payload for the Capacitor iOS/Android shell
// TG_NATIVE=1 is the only switch. Everything conditional on it is below.
const NATIVE = process.env.TG_NATIVE === "1";

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
  // A native build is loaded from the app bundle over capacitor://, where an
  // absolute "/tongue-and-groove/" prefix resolves to nothing.
  base: NATIVE ? "./" : "/tongue-and-groove/",
  define: {
    __BUILD__: JSON.stringify(stamp),
    __NATIVE__: JSON.stringify(NATIVE),
  },
  resolve: {
    alias: NATIVE
      ? [{
          find: "virtual:pwa-register",
          replacement: fileURLToPath(new URL("./src/pwa-stub.js", import.meta.url)),
        }]
      : [],
  },
  build: { outDir: NATIVE ? "dist-native" : "dist" },
  plugins: [
    react(),
    // The service worker is web-only. Inside the native shell the App Store is
    // the update mechanism, and a second cache layer there causes exactly the
    // stale-bundle problem the build stamp exists to diagnose.
    ...(NATIVE ? [] : [VitePWA({
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
        // woff2 added: the fonts are bundled now, so they must be precached
        // alongside the rest of the app or an offline cold start has no type.
        globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2}"]
      }
    })])
  ]
});
