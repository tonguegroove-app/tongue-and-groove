# Tongue & Groove — project instructions

# RULE: Wrong-window check — this is the SPEECH APP, not the options site (non-negotiable)

CB runs two separate projects on this machine: **this one** (Tongue & Groove, a speech-practice PWA) and **OptionsOrchard** (`~/Projects/options-site`, an options-trading education site). They must never mix — separate repos, separate Obsidian vault folders, separate session logs.

If a prompt in this session looks like it's about the options site (covered calls, strikes, premiums, screeners, lessons/quizzes, playbooks, Supabase, the orchard branding), **STOP before doing any work**. Your reply must start with this exact all-caps line:

**HOLD ON — I NOTICED YOU MIGHT BE IN THE WRONG WINDOW.**

Then say what the prompt looks like it's about and ask CB to confirm. Do not touch any file until CB answers. (A global `UserPromptSubmit` hook — `~/.claude/wrong-window-guard.sh`, wired in `~/.claude/settings.json` — auto-flags cross-project prompts by keyword in every project; this rule is the backstop for anything the keyword list misses.)

If CB confirms it IS options work: do it entirely inside `~/Projects/options-site` and log it in the vault's `Business Projects/Options Website/Docs/` — never in Tongue and Groove docs. The reverse rule lives in the options-site repo's `CLAUDE.md`.

---

# Project facts

- **Working copy:** `~/Projects/Tongue-Groove` · deploys automatically on every push to `main` (GitHub Actions → Pages, ~1 min): https://tonguegroove-app.github.io/tongue-and-groove/
- **Session notes live in the vault:** `obsidian-vault/CB_Brain/Business Projects/Tongue and Groove/00-Session Notes.md` (dated `## YYYY-MM-DD — Title` sections, appended chronologically).
- **The working PRD (`tongue-and-groove.md` in the repo root) is a symlink into the vault** — the real file is `.../Tongue and Groove/01-PRD-Requirements/Tongue and Groove Build PRD.md`. Edit it by either path; it's gitignored here because this repo is **public**, and backed up by the vault's (private) git. Keep planning/business docs out of this repo the same way.
- **Word library is generated** — never hand-edit `src/words.gen.js` / `src/sentences.gen.js`. Pipeline: `python3 scripts/build_words.py` → `node scripts/tag_sentences.mjs` → `node scripts/build_library.mjs` (regenerates vault + repo Word Library docs).
- **Word pool is cut at the top 1,500 most-used words** (`TOP_N` in `scripts/build_words.py`). Confirmed 2026-08-05: a 1,000 cut opens content gaps (TH 20→10, S-blends 23→13) — don't lower it without rechecking `vocab-audit.md`.

---

# RULE: When CB reports a bug that was already fixed — check the deployed bytes first

This is an installed PWA. CB tests on his iPhone, so **the code in the repo, the code on GitHub Pages, and the code running on his phone are three different things.** Never assume they match, and never answer a re-reported bug from the source alone.

Before debugging or re-fixing anything CB reports as still broken, in this order:

1. `gh run list --limit 3` — did the deploy actually succeed? (A run has been silently cancelled by the concurrency rule before.)
2. Pull the **live** bundle and grep it for the fix:
   ```
   curl -s https://tonguegroove-app.github.io/tongue-and-groove/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
   curl -s https://tonguegroove-app.github.io/tongue-and-groove/assets/index-XXXX.js | grep -o '`2026-[^`]*`'
   ```
   That last grep returns the build stamp — commit date + short SHA.
3. **Ask CB to read the version line at the bottom of Settings.** If it's older than the live stamp, his device is on a cached bundle and nothing recently fixed is there. Fix: swipe the app fully closed and reopen, or Settings → **Check for update**, or delete and re-add the home-screen icon.

Only once the deployed bytes are confirmed to contain the fix *and* his version matches should you go looking for a real bug.

**Why this rule exists.** It has now cut both ways, which is exactly why guessing is not allowed:
- 2026-08-09 — a "scenarios still missing all but restaurant" report was assumed to be a stale cache. It was a **real regression** shipped in `358d834`, and the assumption cost four rounds of reporting.
- 2026-08-20 — the Bonus Round Start bug was re-reported verbatim after being fixed. Checking the live bundle showed the guard was **already deployed and working**; the phone had a cached copy. The build stamp in Settings exists because of this one.

The rule is the same in both directions: **verify what is actually running before forming any theory.** Don't blame the cache and don't blame the code — go and look.
