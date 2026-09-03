import { connect } from "./cdp.mjs";
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
const check=(n,c,d="")=>{c?(console.log(`  PASS  ${n}${d?"  — "+d:""}`),pass++):(console.log(`  FAIL  ${n}${d?"  — "+d:""}`),fail++);};
const c = await connect();
// Seed a settled user: onboarded, auto-pace on, tick on. Removes onboarding
// and toggle-order from this test so it measures only the pacing feedback.
const seed = JSON.stringify({ ratings:{th:3,tri:3,lb:3,rb:3,sb:3,fc:3}, condition:"stroke",
  variant:"mixed", paced:true, tickOn:true, wpm:30, setSize:25, totalWords:0, hist:{} });
await c.send("Page.addScriptToEvaluateOnNewDocument",{source:`
  try{localStorage.setItem('tg-state-v1', ${JSON.stringify(seed)});}catch(e){}
  window.__spy={haptics:0,keepAwake:0,allowSleep:0};
  window.Capacitor={Plugins:{
    Haptics:{impact:async()=>{window.__spy.haptics++;}},
    KeepAwake:{keepAwake:async()=>{window.__spy.keepAwake++;},allowSleep:async()=>{window.__spy.allowSleep++;}},
    Preferences:{get:async()=>({value:null}),set:async()=>{},remove:async()=>{}},
  }};`});
await c.goto("http://localhost:4178/"); await wait(1600);
const click=(t)=>c.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim().toUpperCase()===${JSON.stringify(t)}.toUpperCase());if(!b)return false;b.click();return true;})()`);

console.log("\n### paced drill — haptic on the beat, wake lock held");
check("Practice screen reached", await click("Practice")); await wait(1200);
check("Tick is already ON from saved state", await c.eval(`document.querySelector('button[aria-label="Pacing tick sound"]')?.getAttribute('aria-pressed')==='true'`));
const base = await c.eval("window.__spy.haptics");

check("Start pressed", await click("Start")); await wait(900);
check("wake lock acquired for the drill", (await c.eval("window.__spy.keepAwake")) > 0);
check("button now reads Pause", await c.eval(`!![...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Pause')`));
await wait(6500);                                  // 30 wpm ≈ a word every 2s
const during = await c.eval("window.__spy.haptics");
check("haptic fires on the beat", during > base + 1, `${during-base} pulses in ~7s at 30 wpm`);

const sleepBefore = await c.eval("window.__spy.allowSleep");
check("Pause pressed", await click("Pause")); await wait(900);
check("wake lock released on pause", (await c.eval("window.__spy.allowSleep")) > sleepBefore);
const atPause = await c.eval("window.__spy.haptics");
await wait(3000);
const later = await c.eval("window.__spy.haptics");
check("haptic stops when the drill pauses", later === atPause, `${atPause} → ${later}`);
check("no exceptions", c.logs.filter(l=>l.level==="exception").length===0, c.logs.filter(l=>l.level==="exception").map(e=>e.text).join("|").slice(0,200));
await c.shot(new URL("./shots/shot-drill.png", import.meta.url).pathname);
console.log(`\n======== ${pass} passed, ${fail} failed ========`);
c.close(); process.exit(fail?1:0);
