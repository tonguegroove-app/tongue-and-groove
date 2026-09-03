// Platform bridge — the seam between the web build and the packaged native build.
//
// Everything here degrades to a no-op on the web, so the PWA behaves exactly as
// it did before this file existed. Native capabilities are reached through
// `window.Capacitor.Plugins` rather than an `import`, deliberately: Capacitor
// plugins register themselves on that registry at runtime, so this file needs
// no build-time dependency on packages that are only installed in the native
// project. Nothing to stub on web, nothing to alias in vite.config.

// Injected by vite.config.js. False for the GitHub Pages build.
export const NATIVE = typeof __NATIVE__ !== "undefined" && __NATIVE__;

const plug = (name) => {
  try {
    return (typeof window !== "undefined" && window.Capacitor?.Plugins?.[name]) || null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Durable key/value — survives WKWebView storage eviction.
//
// iOS treats WKWebView localStorage as evictable cache and will clear it under
// storage pressure, silently. On the web that is a rare annoyance; in a packaged
// app it means a patient's streak and progress disappear one morning with no
// warning. Capacitor Preferences writes to native UserDefaults/SharedPreferences,
// which is real app data and is not evicted.
// ---------------------------------------------------------------------------

export async function durableGet(key) {
  const p = plug("Preferences");
  if (!p) return null;
  try {
    const { value } = await p.get({ key });
    return value ?? null;
  } catch {
    return null;
  }
}

export async function durableSet(key, value) {
  const p = plug("Preferences");
  if (!p) return false;
  try {
    await p.set({ key, value });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Keep the screen awake during a paced drill.
//
// navigator.wakeLock does not exist in WKWebView, so on iOS the native build
// would silently let the screen sleep mid-drill — the one moment the user has
// both hands busy and is looking at the screen. Prefer the native plugin, fall
// back to the web API, and no-op if neither is available.
// ---------------------------------------------------------------------------

let webLock = null;

export async function keepAwake() {
  const p = plug("KeepAwake");
  if (p) {
    try { await p.keepAwake(); return; } catch { /* fall through to web API */ }
  }
  if (typeof navigator !== "undefined" && "wakeLock" in navigator) {
    try { webLock = await navigator.wakeLock.request("screen"); } catch { /* denied — not fatal */ }
  }
}

export async function allowSleep() {
  const p = plug("KeepAwake");
  if (p) {
    try { await p.allowSleep(); } catch { /* ignore */ }
  }
  if (webLock) {
    try { await webLock.release(); } catch { /* ignore */ }
    webLock = null;
  }
}

// ---------------------------------------------------------------------------
// Pacing haptic.
//
// Fires alongside the metronome tick, gated by the same Tick toggle — one
// control meaning "give me pacing feedback", rather than a second switch on a
// UI that was deliberately trimmed for elderly users. The haptic is the reason
// the cue still lands with the volume off, with hearing loss, or in a room
// where a clicking phone would be rude, which is also what makes the packaged
// build meaningfully more than the web page (App Store guideline 4.2).
//
// iOS Safari does not implement navigator.vibrate, so on the web this is a
// no-op there and a real pulse on Android. Native gets the Taptic Engine.
// ---------------------------------------------------------------------------

export function tickHaptic() {
  const p = plug("Haptics");
  if (p) {
    try { p.impact({ style: "LIGHT" }); return; } catch { /* fall through */ }
  }
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(12);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Daily practice reminder — native only.
//
// There is no honest web equivalent: a browser cannot reliably fire a
// scheduled local notification while closed. This is the clearest native-only
// capability in the app, and it fits a tool whose whole model is a daily habit
// (the app already tracks streaks and milestones).
// ---------------------------------------------------------------------------

const REMINDER_ID = 1;

export const remindersAvailable = () => NATIVE && !!plug("LocalNotifications");

export async function requestReminderPermission() {
  const p = plug("LocalNotifications");
  if (!p) return false;
  try {
    const r = await p.requestPermissions();
    return r?.display === "granted";
  } catch {
    return false;
  }
}

export async function scheduleDailyReminder(hour, minute) {
  const p = plug("LocalNotifications");
  if (!p) return false;
  try {
    await p.cancel({ notifications: [{ id: REMINDER_ID }] });
    await p.schedule({
      notifications: [{
        id: REMINDER_ID,
        title: "Tongue & Groove",
        body: "Time for today's practice.",
        // `repeats` with an `on` spec is a daily recurrence at that wall time;
        // allowWhileIdle keeps it firing through Android's doze.
        schedule: { on: { hour, minute }, repeats: true, allowWhileIdle: true },
      }],
    });
    return true;
  } catch {
    return false;
  }
}

export async function cancelDailyReminder() {
  const p = plug("LocalNotifications");
  if (!p) return;
  try { await p.cancel({ notifications: [{ id: REMINDER_ID }] }); } catch { /* ignore */ }
}
