// End-to-end suite: builds both targets, serves them, and drives real Chrome
// over the DevTools Protocol. No test framework and no browser driver package —
// Chrome is already on the machine and node has WebSocket built in.
//
//   npm run test:e2e
//
// Covers the things that are invisible until the app actually runs: fonts
// resolving locally, state surviving an iOS-style storage eviction, the native
// build hiding web-only UI, and the pacing haptic starting and stopping with
// the drill.
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TYPES = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css",
                ".woff2":"font/woff2", ".png":"image/png", ".svg":"image/svg+xml",
                ".json":"application/json", ".webmanifest":"application/manifest+json", ".ico":"image/x-icon" };

function serve(dir, port, prefix = "") {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
      if (!p || p === "/") p = "/index.html";
      const file = join(dir, normalize(p).replace(/^(\.\.[/\\])+/, ""));
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end("not found"); }
  });
  return new Promise((r) => s.listen(port, () => r(s)));
}

const run = (f) => new Promise((res) => {
  const p = spawn(process.execPath, [new URL(f, import.meta.url).pathname], { stdio: "inherit" });
  p.on("exit", (code) => res(code ?? 1));
});

console.log("building both targets…");
execSync("npm run build && npm run build:native", { stdio: "ignore" });

const servers = [
  await serve("dist", 4177, "/tongue-and-groove"),
  await serve("dist-native", 4178),
];
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9222",
  "--user-data-dir=" + join(process.env.TMPDIR || "/tmp", "tg-e2e-profile"),
  "--no-first-run", "--no-default-browser-check", "--window-size=430,932", "about:blank"],
  { stdio: "ignore" });

let failed = 0;
try {
  for (const f of ["./web.mjs", "./native.mjs", "./drill.mjs"]) failed += await run(f);
} finally {
  chrome.kill();
  servers.forEach((s) => s.close());
}
console.log(failed ? `\nE2E FAILED (${failed} suite(s))` : "\nE2E PASSED — all suites green");
process.exit(failed ? 1 : 0);
