import { NATIVE, durableGet, durableSet } from "./platform.js";

const KEY = "tg-state-v1";

// localStorage stays the read path, and stays synchronous, because App.jsx
// reads saved state at module scope (`const saved = loadState()`) before React
// mounts. Making that async would mean restructuring the app around a hydration
// gate for no user-visible gain.
//
// Instead, on native, every write is ALSO mirrored to Capacitor Preferences
// (real UserDefaults), and hydrate() below restores localStorage from that
// mirror at boot if iOS has evicted it. localStorage is the cache; Preferences
// is the record.

export function loadState() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || null;
  } catch {
    return null;
  }
}

// The mirror is debounced: saveState runs from an effect that fires on nearly
// every state change, and each native call is a bridge round-trip. localStorage
// is still written immediately — only the durable copy waits.
let mirrorTimer = null;
let pending = null;

function scheduleMirror(raw) {
  pending = raw;
  if (mirrorTimer) return;
  mirrorTimer = setTimeout(() => {
    mirrorTimer = null;
    const v = pending;
    pending = null;
    if (v != null) durableSet(KEY, v);
  }, 400);
}

export function saveState(state) {
  let raw;
  try {
    raw = JSON.stringify(state);
  } catch {
    return; // unserialisable state — nothing to persist
  }
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    // storage full or unavailable — practice still works, just not persisted
  }
  if (NATIVE) scheduleMirror(raw);
}

// Flush the mirror immediately — used when the app is about to background,
// where a pending 400ms debounce would otherwise be lost.
export function flushState() {
  if (!NATIVE) return Promise.resolve();
  if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }
  const v = pending != null ? pending : (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  pending = null;
  return v != null ? durableSet(KEY, v) : Promise.resolve();
}

// Called once before React mounts (see main.jsx). If localStorage is empty but
// the durable mirror has state, iOS evicted the webview storage — restore it.
// Web builds return immediately, so nothing about the PWA's boot changes.
export async function hydrate() {
  if (!NATIVE) return;
  let local = null;
  try {
    local = localStorage.getItem(KEY);
  } catch {
    return;
  }
  if (local) {
    // First native launch after an upgrade: seed the mirror from existing data.
    if (!(await durableGet(KEY))) await durableSet(KEY, local);
    return;
  }
  const durable = await durableGet(KEY);
  if (durable) {
    try {
      localStorage.setItem(KEY, durable);
    } catch {
      // ignore — nothing more we can do
    }
  }
}

// local-date key, e.g. "2026-08-03"
export function dkey(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
