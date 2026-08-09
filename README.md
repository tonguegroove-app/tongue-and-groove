# Tongue & Groove

A speech practice web app for adults with motor speech disorders (dysarthria, apraxia of speech) — paced word drills weighted toward the sound categories the user finds hardest.

**Live app:** https://tonguegroove-app.github.io/tongue-and-groove/
Installable as a PWA (iPhone: **Safari only** → Share → Add to Home Screen; Android: Chrome → Install). Works fully offline after first load. Not a medical device; a practice tool, not therapy.

## Features

- **Words** — adaptive drill over a 1,122-word library of motor-difficult words, in six sound categories (TH, 3-consonant clusters, L-blends, R-blends, S-blends, final clusters), weighted by a one-time 1–5 self-assessment
- **Sound pairs** — minimal-pair drills (shoe/Sue, thin/fin)
- **Sentences** — read-along with the current word highlighted
- **Scenarios** — functional vocabulary packs for real situations (restaurant, doctor visit, work, phone calls, family, shopping)
- Self-paced (tap Next) or auto-paced (10–150 words per minute)
- Progress: daily rings, streak, day/week/month charts — all computed from real practice history
- Dark mode, adjustable text size, 44px+ touch targets, `prefers-reduced-motion` respected

## Adaptive selection

Word lists are ordered by conversational frequency (wordfreq top 1,500, filtered to mechanically demanding words and split into difficulty tiers).

- **Warm-up words** are spread across difficulty tiers (`TIER_MIX`) and weighted within each tier by your 1–5 sound-category ratings
- **A five-level check-in** ("How was that?") is asked at the first warm-up break of the day and at the end of a session — the day's first, then every third session. The answer shifts a persisted difficulty dial (`diffAdj`, −2…+2) that steers both the warm-up tier mix and the sentence ladder
- **Sentence sets** guarantee every scenario pack a slot per set, with Doctor and Restaurant weighted higher (`SCEN_EMPHASIS`)
- **Sentences play 80% faster** per word than the warm-up words (`SENT_PACE`) off the same single pace slider

Hard-word marking (tap the words that were hard → they return 3× as often) is **built but paused** — see "Paused features" in `tongue-and-groove.md`. Flip `HARD_MARKS` in `src/App.jsx` to bring it back.

Tuning constants at the top of `src/App.jsx` (`HARD_MARKS`, `HARD_BOOST`, `RECENT_GAP`, `SENT_PACE`, `DIFF_ASK_EVERY`, `SCEN_EMPHASIS`, `TIER_MIX`).

## Mobile hardening

Wake lock while auto-paced (screen never sleeps mid-drill) · auto-pause when backgrounded (never silently resumes) · `100dvh` + safe-area insets · offline via service worker (app shell, word data, fonts) · illustrated install instructions shown in-browser until installed.

## Stack & structure

Vite + React, no backend. All user data lives in `localStorage` (`tg-state-v1`): ratings, settings, per-word stats, per-day history.

```
src/
  App.jsx        # entire UI + drill/selection logic
  data.js        # pairs, sentences, categories, scenario packs, goals
  words.gen.js   # GENERATED tiered word lists — do not edit by hand
  storage.js     # localStorage + date-key helpers
scripts/
  build_words.py # regenerates words.gen.js from wordfreq (python3, pip install wordfreq)
  make-icons.mjs # regenerates public/icons/ (npm run icons)
```

## Develop & deploy

```bash
npm install
npm run dev      # local dev server
npm run build    # production build to dist/
```

Every push to `main` auto-builds and deploys via GitHub Actions → GitHub Pages (`.github/workflows/deploy.yml`). To regenerate the word library: `python3 scripts/build_words.py`, then commit `src/words.gen.js`.
