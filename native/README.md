# Native shell notes

Everything here applies **after** `npx cap add ios` / `npx cap add android`.
Until then the JS side is already prepared — see `src/platform.js`, which reaches
plugins through `window.Capacitor.Plugins` and no-ops when they are absent.

## Build the payload

```
npm run build:native     # → dist-native/
npx cap sync
```

Point `webDir` at `dist-native` in `capacitor.config.json`.

## Plugins the app looks for

| Plugin | Package | Used by |
|---|---|---|
| `Preferences` | `@capacitor/preferences` | durable state mirror (`src/storage.js`) |
| `Haptics` | `@capacitor/haptics` | pacing haptic on each tick |
| `LocalNotifications` | `@capacitor/local-notifications` | daily practice reminder |
| `KeepAwake` | `@capacitor-community/keep-awake` | screen stays on during a drill |

Each is optional at runtime: a missing plugin degrades to a no-op, it does not throw.

## iOS audio session — MUST be set in the native project

This one **cannot** be done from JavaScript. Without it the metronome tick will
stop the user's music or podcast the moment a drill starts, because the default
session category is not a mixing one.

In `ios/App/App/AppDelegate.swift`, inside
`application(_:didFinishLaunchingWithOptions:)`:

```swift
import AVFoundation

// Let the pacing tick play over whatever the user is already listening to
// rather than interrupting it. `.ambient` also means the tick respects the
// hardware mute switch, which is the behaviour people expect from a metronome.
try? AVAudioSession.sharedInstance().setCategory(.ambient, options: [.mixWithOthers])
try? AVAudioSession.sharedInstance().setActive(true)
```

If you would rather the tick ignore the mute switch, use `.playback` instead of
`.ambient` — but `.ambient` is the safer default for a clinical setting.

## App Store submission decisions (agreed 2026-09-03)

- **Category: Education**, not Health & Fitness — avoids the health-claims review lane.
- **Privacy label: "Data Not Collected"** — truthful; there is no backend, no analytics, no accounts.
- **Listing copy describes what the app does, never what it fixes.** Name the
  conditions as the audience it was designed for, never as an outcome it delivers.
- **No donations in this build.** A tip jar would have to go through In-App
  Purchase (a plain Stripe/Ko-fi link is a 3.1.1 rejection). Deferred, not dropped.
