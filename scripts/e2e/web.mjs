import { connect } from "./cdp.mjs";
const URL_ = "http://localhost:4177/tongue-and-groove/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok  = (n, d="") => { console.log(`  PASS  ${n}${d?"  — "+d:""}`); pass++; };
const bad = (n, d="") => { console.log(`  FAIL  ${n}${d?"  — "+d:""}`); fail++; };
const check = (n, cond, d="") => cond ? ok(n, d) : bad(n, d);

const c = await connect();
const click = (t) => c.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim().toUpperCase()===${JSON.stringify(t)}.toUpperCase());if(!b)return false;b.click();return true;})()`);

// clean slate so we exercise first-run too
await c.goto(URL_);
await c.eval("localStorage.clear()");
await c.goto(URL_);
await wait(1400);

console.log("\n### 1. boot");
check("root is populated", (await c.eval("document.getElementById('root').children.length")) > 0);
const errs = c.logs.filter((l) => l.level === "exception" || l.level === "error");
check("no console errors or exceptions", errs.length === 0, errs.map(e=>e.text).join(" | ").slice(0,200));

console.log("\n### 2. fonts are local, not fetched from Google");
await c.eval("document.fonts.ready");
check("Atkinson Hyperlegible loaded",  await c.eval("document.fonts.check(\"16px 'Atkinson Hyperlegible'\")"));
check("Bricolage Grotesque loaded",    await c.eval("document.fonts.check(\"700 20px 'Bricolage Grotesque'\")"));
const res = await c.eval("JSON.stringify(performance.getEntriesByType('resource').map(r=>r.name))");
const names = JSON.parse(res);
check("zero requests to fonts.googleapis.com", !names.some(n=>n.includes("googleapis")));
check("zero requests to fonts.gstatic.com",    !names.some(n=>n.includes("gstatic")));
const woff = names.filter(n=>n.endsWith(".woff2"));
check("woff2 served from this origin", woff.length>0 && woff.every(n=>n.startsWith("http://localhost:4177/")), `${woff.length} files`);

console.log("\n### 3. first-run onboarding still works");
check("landing screen has START", await c.eval("!![...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='START')"));
await click("START"); await wait(500);
const condText = await c.eval("document.body.innerText");
check("condition screen reached", condText.includes("What brings you here?"));
await click("Stroke"); await wait(600);
check("moved past condition picker", !(await c.eval("document.body.innerText")).includes("What brings you here?"));

console.log("\n### 4. state persists across a reload (the storage rewrite)");
await c.eval("localStorage.getItem('tg-state-v1')");
const before = await c.eval("localStorage.getItem('tg-state-v1')");
check("state written to localStorage", !!before && before.length > 20, `${before?before.length:0} bytes`);
await c.goto(URL_); await wait(1200);
const after = await c.eval("localStorage.getItem('tg-state-v1')");
check("state survives reload", !!after && JSON.parse(after).condition === "stroke", `condition=${after?JSON.parse(after).condition:"none"}`);
check("no re-onboarding after reload", !(await c.eval("document.body.innerText")).includes("What brings you here?"));

console.log("\n### 5. Settings — disclaimer present, reminder correctly absent on web");
await click("Settings"); await wait(700);
const setTxt = await c.eval("document.body.innerText");
check("Settings screen reached", setTxt.includes("Settings"));
check("disclaimer: 'not a medical device'", setTxt.includes("not a medical device"));
check("disclaimer: no diagnose/treat claim", setTxt.includes("does not diagnose or treat"));
check("disclaimer: mentions SLP",            setTxt.includes("speech-language pathologist"));
check("disclaimer: on-device privacy",       setTxt.includes("stays on this device"));
check("reminder row hidden on web build",   !setTxt.includes("Daily practice reminder"));
check("'Check for update' present on web",   setTxt.includes("Check for update"));
check("build stamp rendered",                /Version \d{4}-\d{2}-\d{2}/.test(setTxt), (setTxt.match(/Version [^\n]*/)||[""])[0]);

console.log("\n### 6. service worker (web build only)");
check("service worker registered", await c.eval("navigator.serviceWorker.getRegistrations().then(r=>r.length>0)"));

await c.shot(new URL("./shots/shot-settings.png", import.meta.url).pathname);
const errs2 = c.logs.filter((l) => l.level === "exception");
check("no exceptions across whole run", errs2.length === 0, errs2.map(e=>e.text).join(" | ").slice(0,200));

console.log(`\n======== ${pass} passed, ${fail} failed ========`);
c.close();
process.exit(fail ? 1 : 0);
