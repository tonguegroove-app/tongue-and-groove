// Minimal Chrome DevTools Protocol client — no dependencies.
export async function connect(port = 9222) {
  let targets, tries = 0;
  while (tries++ < 40) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) return await attach(page.webSocketDebuggerUrl);
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("could not reach Chrome CDP");
}

async function attach(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method) {
      listeners.forEach((f) => f(msg));
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

  const logs = [];
  listeners.push((m) => {
    if (m.method === "Runtime.consoleAPICalled")
      logs.push({ level: m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? "").join(" ") });
    if (m.method === "Runtime.exceptionThrown")
      logs.push({ level: "exception", text: m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text });
    if (m.method === "Log.entryAdded")
      logs.push({ level: m.params.entry.level, text: m.params.entry.text });
  });

  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");

  return {
    send, logs, ws,
    async goto(u) {
      const loaded = new Promise((res) => {
        const f = (m) => { if (m.method === "Page.loadEventFired") { listeners.splice(listeners.indexOf(f), 1); res(); } };
        listeners.push(f);
      });
      await send("Page.navigate", { url: u });
      await loaded;
    },
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval threw");
      return r.result.value;
    },
    async shot(path) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, Buffer.from(r.data, "base64"));
    },
    close() { ws.close(); },
  };
}
