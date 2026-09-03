import { connect } from "./cdp.mjs";
const U = "http://localhost:4178/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, d="") => { c ? (console.log(`  PASS  ${n}${d?"  — "+d:""}`), pass++) : (console.log(`  FAIL  ${n}${d?"  — "+d:""}`), fail++); };

const c = await connect();

// The stub is re-installed before every load, seeded with whatever the native
// key/value store is supposed to already contain. That models UserDefaults
// honestly: it lives outside the webview and is NOT cleared when localStorage is.
let scriptId = null;
async function installStub(prefs) {
  if (scriptId) await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
  const src = `
    window.__prefs = ${JSON.stringify(prefs)};
    window.__spy = { haptics:0, scheduled:[], cancelled:0, permAsked:0, prefSets:0, prefGets:0 };
    window.Capacitor = { Plugins: {
      Preferences: {
        get:    async ({key})       => { window.__spy.prefGets++; return { value: window.__prefs[key] ?? null }; },
        set:    async ({key,value}) => { window.__prefs[key]=value; window.__spy.prefSets++; },
        remove: async ({key})       => { delete window.__prefs[key]; },
      },
      Haptics: { impact: async () => { window.__spy.haptics++; } },
      LocalNotifications: {
        requestPermissions: async () => { window.__spy.permAsked++; return { display:"granted" }; },
        schedule: async ({notifications}) => { window.__spy.scheduled.push(notifications[0].schedule.on); },
        cancel:   async () => { window.__spy.cancelled++; },
      },
      KeepAwake: { keepAwake: async()=>{}, allowSleep: async()=>{} },
    }};`;
  scriptId = (await c.send("Page.addScriptToEvaluateOnNewDocument", { source: src })).identifier;
}
const wipeLocalStorage = () => c.send("Storage.clearDataForOrigin", { origin: "http://localhost:4178", storageTypes: "local_storage" });
const click = (t) => c.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim().toUpperCase()===${JSON.stringify(t)}.toUpperCase());if(!b)return false;b.click();return true;})()`);

console.log("\n### 1. native build boots clean");
await installStub({}); await wipeLocalStorage();
await c.goto(U); await wait(1500);
check("root populated", (await c.eval("document.getElementById('root').children.length")) > 0);
check("no exceptions", c.logs.filter(l=>l.level==="exception").length === 0, c.logs.filter(l=>l.level==="exception").map(e=>e.text).join("|").slice(0,160));
check("no service worker registered", !(await c.eval("navigator.serviceWorker.getRegistrations().then(r=>r.length>0)")));
check("first run shows the landing screen", await c.eval("!![...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='START')"));

console.log("\n### 2. onboarding writes through to the durable mirror");
check("START clicked", await click("START")); await wait(700);
check("condition screen reached", (await c.eval("document.body.innerText")).includes("What brings you here?"));
check("Stroke clicked", await click("Stroke")); await wait(1200);
check("Preferences received writes", (await c.eval("window.__spy.prefSets")) > 0, `${await c.eval("window.__spy.prefSets")} writes`);
const mirrored = JSON.parse(await c.eval("JSON.stringify(window.__prefs)"));
check("mirror holds condition=stroke", JSON.parse(mirrored["tg-state-v1"]||"{}").condition === "stroke");
check("mirror matches localStorage exactly", await c.eval("window.__prefs['tg-state-v1'] === localStorage.getItem('tg-state-v1')"));

console.log("\n### 3. THE EVICTION TEST — iOS wipes localStorage, UserDefaults survives");
await installStub(mirrored);          // native store persists...
await wipeLocalStorage();             // ...webview storage does not
await c.goto(U); await wait(1600);
check("Preferences was read at boot", (await c.eval("window.__spy.prefGets")) > 0, `${await c.eval("window.__spy.prefGets")} reads`);
const restored = await c.eval("localStorage.getItem('tg-state-v1')");
check("localStorage restored from mirror", !!restored, `${restored?restored.length:0} bytes`);
check("condition survived", !!restored && JSON.parse(restored).condition === "stroke", `condition=${restored?JSON.parse(restored).condition:"LOST"}`);
check("user NOT sent back to onboarding", !(await c.eval("document.body.innerText")).includes("What brings you here?"));
check("user NOT sent back to landing", !(await c.eval("!![...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='START')")));

console.log("\n### 4. control: WITHOUT the mirror, the same eviction loses everything");
await installStub({});                // empty native store
await wipeLocalStorage();
await c.goto(U); await wait(1500);
check("state is genuinely gone (proves test 3 wasn't a false pass)",
      (await c.eval("JSON.parse(localStorage.getItem('tg-state-v1')||'{}').condition")) == null);
check("and onboarding reappears", await c.eval("!![...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='START')"));

console.log("\n### 5. Settings — native variant");
await installStub(mirrored); await wipeLocalStorage();
await c.goto(U); await wait(1600);
check("Settings reached", await click("Settings")); await wait(800);
const t = await c.eval("document.body.innerText");
check("reminder row IS shown on native", t.includes("Daily practice reminder"));
check("'Check for update' hidden on native", !t.includes("Check for update"));
check("disclaimer present", t.includes("not a medical device") && t.includes("speech-language pathologist"));

console.log("\n### 6. reminder scheduling reaches the plugin");
await c.eval(`document.querySelector('button[aria-label="Daily practice reminder"]').click()`);
await wait(900);
check("permission requested", (await c.eval("window.__spy.permAsked")) > 0);
check("notification scheduled", (await c.eval("window.__spy.scheduled.length")) > 0);
check("scheduled at default 09:00", (await c.eval("JSON.stringify(window.__spy.scheduled[0])")) === '{"hour":9,"minute":0}', await c.eval("JSON.stringify(window.__spy.scheduled[0])"));
check("time input appears once enabled", await c.eval("!!document.querySelector('input[type=time]')"));

await c.shot(new URL("./shots/shot-native-settings.png", import.meta.url).pathname);
check("no exceptions across whole run", c.logs.filter(l=>l.level==="exception").length === 0, c.logs.filter(l=>l.level==="exception").map(e=>e.text).join("|").slice(0,200));
console.log(`\n======== ${pass} passed, ${fail} failed ========`);
c.close(); process.exit(fail?1:0);
