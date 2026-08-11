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
