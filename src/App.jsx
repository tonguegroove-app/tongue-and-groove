import { useState, useEffect, useRef } from "react";
import { WORDS, WORD_META, PAIRS, SENTENCES, CATS, MILESTONES, GOALS, SCENARIOS, CONDITIONS, PRESETS, SCENARIO_SENTENCES, VARIANTS, COND_VARIANT, targetsOf, topTarget, cleanToken } from "./data.js";
import { SENT_META } from "./sentences.gen.js";
import { loadState, saveState, dkey } from "./storage.js";

const saved = loadState();

// Difficulty check-in — five levels, and the only feedback the app asks for
// now that hard-word marking is paused (see HARD_MARKS below). Two ask points
// (CB 2026-08-09):
//   1. the first warm-up break of the DAY — that answer tunes the three
//      sentence sets that follow, so it has to land before them;
//   2. the end of a finished session — first session of the day, then once
//      every DIFF_ASK_EVERY sessions after it.
// Both gates are day-scoped so a heavy user answering six sessions a day gets
// asked twice on session one and then roughly every third session — a nudge,
// never a nag. Each gate has its own counter so the pair on session one fires.
const DIFF_ASK_EVERY = 3;
// adj sets the warm-up tier mix, the warm-up syllable bias, AND the sentence
// rung mix (-2 … +2). CB 2026-08-19: the LATEST answer sets the dial outright —
// it used to accumulate, so two "Easy" answers on different days pinned it at
// +2 until two hard reads dragged it back. One check-in, one setting.
// "Kind of hard" now sits one notch below Medium (it used to share 0 with it)
// because the two want different sentence sets: see RUNG_MIX.
const DIFF_LEVELS = [
  { id: "veasy", label: "Very easy", adj: 2 },
  { id: "easy", label: "Easy", adj: 1 },
  { id: "medium", label: "Medium", adj: 0 },
  { id: "hard", label: "Kind of hard", adj: -1 },
  { id: "vhard", label: "Really hard", adj: -2 },
];
const DIFF_ACK = {
  veasy: "Then let's stretch you — harder words and busier sentences from here.",
  easy: "Good to know — we'll mix in harder words from here.",
  medium: "Right in the zone. That's where progress lives.",
  hard: "Kind of hard is the sweet spot — that's where the gains are.",
  vhard: "Thanks for the honesty. We'll ease the mix — and a shorter session is always a fine move.",
};

const isIOS = typeof navigator !== "undefined" && /iP(hone|ad|od)/.test(navigator.userAgent);
const isStandalone =
  typeof window !== "undefined" &&
  (window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true);
const isAndroid = typeof navigator !== "undefined" && /Android/.test(navigator.userAgent);

// adaptive word selection tuning
// HARD_MARKS gates the whole "tap the words that were hard" feature — the
// summary chip grid, the 3× repeat boost, and the hard-mark-derived rescore
// suggestions. PAUSED 2026-08-09 (CB): too many hard words were surfacing at
// the end of a session. The code stays wired so it can be switched back on;
// see "Paused features" in tongue-and-groove.md before flipping it.
const HARD_MARKS = false;
const HARD_BOOST = 3;    // hard-marked words appear 3× as often as normal words
const RECENT_GAP = 200;  // an item can't repeat until this many others have shown (~8 sets of 25)
// Weight for one word in a pick: hard-marked words pull HARD_BOOST× while the
// feature is on, and every word weighs the same while it's paused.
const hardWeight = (st) => (HARD_MARKS && st?.h > 0 ? HARD_BOOST : 1);

// §7 pacing — one slider, syllables underneath (CB 2026-08-19). The warm-up
// pool averages 2.60 syllables per word (single-syllable words are deleted at
// build time, so the floor is 2); the words inside sentences average 1.38.
// Holding a sentence by its WORD count is what made short monosyllabic lines
// drag: the old SENT_PACE fudge factor (1.7 → 1.5 → 1.8, all by feel) was
// really that 2.60 / 1.38 = 1.88 density ratio, applied as a single average to
// sentences that run 0.90–2.67 syllables per word. Per sentence it was off by
// up to ±60%.
//   hold = LEAD_IN + syllables / (wpm × WORD_SYL × CONNECTED)
// Calibrated so the AVERAGE sentence still holds ~8.1 s at 30 WPM — the tempo
// CB tuned by hand — and only the spread across sentences changes.
const WORD_SYL = 2.6;      // measured mean syllables of the warm-up word pool
const CONNECTED = 1.0;     // extra per-syllable speed-up for connected speech;
                           // the syllable model absorbs what SENT_PACE faked,
                           // so this is the one honest knob left to turn.
const LEAD_IN_MS = 350;    // breath + onset, once per sentence, doesn't scale
// Ceiling on a single sentence (CB 2026-08-19: cap at 12.6 s). Expressed in
// syllables so it scales with the slider — 16 syllables is 12.65 s at 30 WPM,
// and a slower setting still gets its slower hold.
const SENT_CAP_SYL = 16;
const MIN_HOLD_MS = 700;
// Sentence syllables come from the build-time tag (SENT_META.y). The fallback
// mirrors the vowel-group rule in scripts/build_words.py for anything the bank
// doesn't carry, so nothing can freeze on a missing tag.
const sylFallback = (tok) => {
  const w = cleanToken(tok);
  if (!w) return 0;
  const g = w.match(/[aeiouy]+/g);
  let n = g ? g.length : 0;
  if (w.endsWith("e") && !/(le|ee|ie|oe|ye)$/.test(w) && n > 1) n -= 1;
  return Math.max(1, n);
};
const sentSyl = (s) => SENT_META[s]?.y ?? s.split(/\s+/).reduce((a, t) => a + sylFallback(t), 0);
// How long the item on screen holds in auto-pace. Words hold one beat; a
// sentence holds for the syllables it actually contains.
const holdMs = (it, wpm) => {
  const base = (60 / wpm) * 1000;
  const isSent = it && (it.kind === "bonus" || (it.kind === "couple" && it.beat === 2));
  if (!isSent) return base;
  const syl = Math.min(sentSyl(it.sentence), SENT_CAP_SYL);
  return Math.max(MIN_HOLD_MS, LEAD_IN_MS + (syl / (wpm * WORD_SYL * CONNECTED)) * 60000);
};

// Staged practice session: warm-up words → 3×10 word→sentence couples that
// escalate 1 → 2 → 3+ instances of the target sound (§6 ladder) → optional
// Bonus Round of 6 scenario sentences. Only the warm-up varies by variant.
const COUPLE_SETS = [10, 10, 10];
const BONUS_N = 6;
const buildPlan = (variantId) => {
  const v = VARIANTS.find((x) => x.id === variantId) || VARIANTS[1];
  return [
    ...v.warmup.map((n) => ({ stage: "warmup", n })),
    ...COUPLE_SETS.map((n) => ({ stage: "couples", n })),
    { stage: "bonus", n: BONUS_N },
  ];
};
// Couples bank for Practice mode: every scenario's sentences plus the
// category-loaded drill sentences — mixed, never chosen by the user. A
// scenario session filters to its own bank instead.
const ALL_COUPLE_SENTS = [...Object.values(SCENARIO_SENTENCES).flat(), ...Object.values(SENTENCES).flat()];
// Doctor + Restaurant get extra weight in the Practice couples mix (CB
// 2026-08-06) — but that weight belongs to the PACK, not to each sentence.
// Applied per sentence it compounded with bank depth: dr + rest hold 152 of
// the 415 couple sentences, so a 3× per-sentence weight put 74% of a rung-1
// set on those two and Phone / Family / Work / Shopping drew ~5% each — a
// 10-sentence set usually contained none of them at all. Every pack now gets a
// guaranteed slot per set and emphasis only decides the leftovers.
const SCEN_EMPHASIS = { dr: 3, rest: 3 };
const DRILL = "drill"; // the category-loaded sentences behave as one more pack
const PACK_BANK = { ...SCENARIO_SENTENCES, [DRILL]: Object.values(SENTENCES).flat() };
const PACK_IDS = [...SCENARIOS.map((s) => s.id), DRILL];
// Which pack a sentence came from — the couples queue now picks by rung first
// and uses this to keep the packs spread across the set.
const SENT_PACK = {};
PACK_IDS.forEach((p) => (PACK_BANK[p] || []).forEach((s) => { SENT_PACK[s] ??= p; }));

// §6 ladder rung of a sentence: 1 / 2 / 3 = instances of its target sound
// (from the build-time tags); 0 = no target sound, unusable as a couple.
const rungOf = (s) => { const m = SENT_META[s]; return !m || !m.cat || m.n === 0 ? 0 : Math.min(m.n, 3); };
// §6 ladder, rebuilt 2026-08-19. Each couples set is now a MIX of rungs, not a
// single rung with a fallback — the old version let a thin pack quietly drop a
// set-3 slot down to a 1-instance sentence, which is why set 3 kept reading as
// "normal sentences with one of the sound in them".
// Numbers are sentences per 10 as [1-instance, 2-instance, 3+-instance]:
//   Very easy   — stretch: doubles from set 1, set 3 is all triples
//   Easy        — doubles from set 1, triples arrive in set 2
//   Medium      — set 1 mostly singles, set 3 is ALL doubles and triples
//   Kind of hard— some doubles, no triples anywhere
//   Really hard — singles only, every set
const RUNG_MIX = {
  "2":  { 1: [2, 4, 4],  2: [0, 3, 7],  3: [0, 0, 10] },
  "1":  { 1: [4, 4, 2],  2: [0, 5, 5],  3: [0, 2, 8] },
  "0":  { 1: [8, 2, 0],  2: [1, 7, 2],  3: [0, 3, 7] },
  "-1": { 1: [10, 0, 0], 2: [6, 4, 0],  3: [4, 6, 0] },
  "-2": { 1: [10, 0, 0], 2: [10, 0, 0], 3: [10, 0, 0] },
};
// The n rung targets for one set, scaled from the per-10 mix and shuffled so
// the density is spread through the set instead of stacked at the front.
const rungPlan = (n, pos, adj) => {
  const mix = RUNG_MIX[String(Math.max(-2, Math.min(2, Math.round(adj))))][Math.max(1, Math.min(3, pos))];
  const plan = [];
  mix.forEach((c, i) => { for (let k = 0; k < Math.round((c / 10) * n); k++) plan.push(i + 1); });
  while (plan.length < n) plan.push(mix.indexOf(Math.max(...mix)) + 1);
  plan.length = n;
  for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [plan[i], plan[j]] = [plan[j], plan[i]]; }
  return plan;
};
// Fallback order when a rung's bank is exhausted — always toward MORE loading
// first, so a shortage never silently makes the set easier than asked.
const RUNG_FALLBACK = { 1: [1, 2, 3], 2: [2, 3, 1], 3: [3, 2, 1] };

// §2: a scenario is session-ready when every ladder rung can fill a 10-couple
// set. Thinner scenarios stay listed with an "In progress" badge.
const SCEN_READY = Object.fromEntries(SCENARIOS.map((sc) => {
  const b = { 1: 0, 2: 0, 3: 0 };
  (SCENARIO_SENTENCES[sc.id] || []).forEach((x) => { const r = rungOf(x); if (r) b[r]++; });
  return [sc.id, b[1] >= 10 && b[2] >= 10 && b[3] >= 10];
}));

// §1E warm-up tier spread — 20 / 30 / 30 / 20 across difficulty tiers 2-5,
// so every session mixes words the user can win and words that stretch.
// The check-in answers slide the spread up or down (adj -2 … +2).
const TIER_MIX = {
  "-2": [0.5, 0.3, 0.15, 0.05],
  "-1": [0.35, 0.35, 0.2, 0.1],
  "0":  [0.2, 0.3, 0.3, 0.2],
  "1":  [0.1, 0.2, 0.35, 0.35],
  "2":  [0.05, 0.15, 0.3, 0.5],
};
const tierCounts = (total, adj = 0) => {
  const mix = TIER_MIX[String(Math.max(-2, Math.min(2, Math.round(adj))))];
  const c = { 2: Math.round(total * mix[0]), 3: Math.round(total * mix[1]), 4: Math.round(total * mix[2]) };
  c[5] = total - c[2] - c[3] - c[4];
  return c;
};
// Syllable bias inside each tier band (CB 2026-08-19: "really hard" should also
// decrease the frequency of multi-syllable words). Tier already correlates with
// length, but every band still spans 2–6 syllables, so this leans the draw
// short when practice is too hard and long when it's too easy.
const SYL_PREF = { "-2": (y) => 1 / (y * y), "-1": (y) => 1 / y, "0": () => 1, "1": (y) => y, "2": (y) => y * y };
const sylWeight = (w, adj) => SYL_PREF[String(Math.max(-2, Math.min(2, Math.round(adj))))](WORD_META[w]?.y || 2);

const WORDS_BY_TIER_CAT = {}; // tier -> cat -> [words]
Object.keys(WORDS).forEach((c) => WORDS[c].forEach((w) => {
  const t = WORD_META[w]?.t;
  if (t) ((WORDS_BY_TIER_CAT[t] ??= {})[c] ??= []).push(w);
}));

function pickCat(ratings, keys) {
  const pool = [];
  keys.forEach((k) => {
    const w = ratings[k] || 3;
    for (let i = 0; i < w; i++) pool.push(k);
  });
  return pool[Math.floor(Math.random() * pool.length)];
}

function Badge({ size, color, ring, star }) {
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" aria-hidden="true">
      <path d="M28 44l-7 20 10-6 5 10 6-22" fill={ring} opacity="0.85" />
      <path d="M44 44l7 20-10-6-5 10-6-22" fill={ring} opacity="0.6" />
      <circle cx="36" cy="28" r="23" fill={color} />
      <circle cx="36" cy="28" r="17" fill="none" stroke={star} strokeWidth="2" opacity="0.6" />
      <path d="M36 17l3.6 7.4 8.2 1.1-6 5.8 1.5 8.1-7.3-3.9-7.3 3.9 1.5-8.1-6-5.8 8.2-1.1z" fill={star} />
    </svg>
  );
}

function Ring({ r, sw, frac, color, overColor }) {
  const C = 2 * Math.PI * r;
  const over = frac > 1 ? (frac - 1) % 1 : 0; // second lap past the goal
  return (
    <>
      <circle cx="70" cy="70" r={r} fill="none" stroke={color} strokeOpacity="0.18" strokeWidth={sw} />
      <circle cx="70" cy="70" r={r} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round"
        strokeDasharray={(C * Math.min(frac, 1)) + " " + C} transform="rotate(-90 70 70)" />
      {over > 0 && (
        <circle cx="70" cy="70" r={r} fill="none" stroke={overColor || "#E9B44C"} strokeWidth={sw} strokeLinecap="round"
          strokeDasharray={(C * over) + " " + C} transform="rotate(-90 70 70)" />
      )}
    </>
  );
}

export default function App() {
  const [screen, setScreen] = useState(saved?.ratings ? "progress" : "landing"); // landing | assess | drill | summary | settings | progress | rescore
  const [draft, setDraft] = useState(null); // working copy for the rescore screen
  const [lastRescoreSets, setLastRescoreSets] = useState(saved?.lastRescoreSets ?? 0);
  const [ratings, setRatings] = useState(saved?.ratings ?? { th: 3, tri: 3, lb: 3, rb: 3, sb: 3, fc: 3 });
  const [mode, setMode] = useState("practice"); // practice | pairs | scen
  const [scenario, setScenario] = useState(saved?.scenario ?? null); // selected scenario pack id
  const [condition, setCondition] = useState(saved?.condition ?? null); // stroke | dementia | tbi | parkinsons | other
  const [variant, setVariant] = useState(saved?.variant ?? (saved?.condition ? COND_VARIANT[saved.condition] : "dysarthria")); // warm-up shape
  const [sess, setSess] = useState(null); // staged session: { plan, idx, count, brk, finished, credits, wq, wqi, sents, bonusQ }
  const sessRef = useRef(null);
  const [useRec, setUseRec] = useState(saved?.useRec ?? true); // §8: recommended settings, ON by default
  const [manualRatings, setManualRatings] = useState(saved?.manualRatings ?? null); // kept across toggle flips
  const [paced, setPaced] = useState(saved?.paced ?? false); // false = self-paced (tap Next)
  // 30 WPM is the calibrated default (CB 2026-08-19); a user's own setting is
  // saved and restored, so the slider is only touched once.
  const [wpm, setWpm] = useState(saved?.wpm ?? 30);
  const [tickOn, setTickOn] = useState(saved?.tickOn ?? false); // metronome tick on each auto-paced word
  const [playing, setPlaying] = useState(false);
  const [item, setItem] = useState(null);
  const [setSize, setSetSize] = useState(saved?.setSize ?? 25); // 25–150 in blocks of 25
  const [setItems, setSetItems] = useState([]); // labels shown this set
  const [difficult, setDifficult] = useState({});
  const [totalWords, setTotalWords] = useState(saved?.totalWords ?? 0);
  const [hist, setHist] = useState(saved?.hist ?? {}); // { "YYYY-MM-DD": { w, p, s } }
  const [range, setRange] = useState("d"); // d | w | m
  const [award, setAward] = useState(null); // {set:true} | {milestone:n}
  const [dark, setDark] = useState(saved?.dark ?? false);
  const [fontScale, setFontScale] = useState(saved?.fontScale ?? 1); // 1 | 1.15 | 1.3
  const [feedbackOn, setFeedbackOn] = useState(saved?.feedbackOn ?? true);
  const [iosHintDismissed, setIosHintDismissed] = useState(saved?.iosHintDismissed ?? false);
  const [wordStats, setWordStats] = useState(saved?.wordStats ?? {}); // { word: { s: seen count, h: hard level } }
  const [diffChecks, setDiffChecks] = useState(saved?.diffChecks ?? []); // difficulty check-ins: [{ d, v, sess }]
  const [sessDone, setSessDone] = useState(saved?.sessDone ?? 0); // finished sessions (and pairs sets), all time
  const [warmAskDay, setWarmAskDay] = useState(saved?.warmAskDay ?? ""); // day key of the last warm-up-break check-in
  const [sumAskDay, setSumAskDay] = useState(saved?.sumAskDay ?? ""); // day key of the last end-of-session check-in
  const [sumAskSess, setSumAskSess] = useState(saved?.sumAskSess ?? 0); // sessDone at the last end-of-session check-in
  // This session's check-in state, not persisted. warmAsk/sumAsk latch on when
  // an ask point opens so the card stays put after it closes its own gate;
  // warmAnswer/sumAnswer hold the answer that ask point got.
  const [warmAsk, setWarmAsk] = useState(false);
  const [sumAsk, setSumAsk] = useState(false);
  const [warmAnswer, setWarmAnswer] = useState(null);
  const [sumAnswer, setSumAnswer] = useState(null);
  const [diffAdj, setDiffAdj] = useState(saved?.diffAdj ?? 0); // warm-up tier-mix shift, -2 … +2
  const statsRef = useRef(wordStats);
  useEffect(() => { statsRef.current = wordStats; }, [wordStats]);
  const timerRef = useRef(null);
  const itemRef = useRef(null);
  const doneRef = useRef(0);
  const wakeRef = useRef(null);
  const marksAppliedRef = useRef(true); // false only while a fresh summary awaits its hard-word taps
  const recentRef = useRef(saved?.recent ?? []); // last RECENT_GAP item keys, to space out repeats
  // No-repeat rule (CB 2026-08-19). A SESSION is the warm-up word set plus the
  // three sentence sets; inside it a practice word is never shown twice — not
  // as a warm-up word, not as a couple's target word. Variety of pattern beats
  // repetition of one word. (The Bonus Round sits outside that boundary: its
  // whole design is to bring back a word already practiced today.)
  const sessWordsRef = useRef(new Set());  // practice words used this session
  const sessSentsRef = useRef(new Set());  // sentences used this session
  // Same rule inside Sound pairs: no individual word repeats within a set, even
  // across different pairs (so "thin/fin" rules out "thin/tin").
  const pairWordsRef = useRef(new Set());
  // Item history, so Back can step to the previous item without un-banking any
  // progress. Next replays forward through it before generating anything new.
  const viewRef = useRef({ list: [], pos: -1 });
  const [viewPos, setViewPos] = useState(-1);
  const show = (nx) => {
    const v = viewRef.current;
    v.list = [...v.list.slice(-40), nx];
    v.pos = v.list.length - 1;
    itemRef.current = nx;
    setItem(nx);
    setViewPos(v.pos);
  };
  const showAt = (pos) => {
    const v = viewRef.current;
    v.pos = pos;
    itemRef.current = v.list[pos];
    setItem(v.list[pos]);
    setViewPos(pos);
  };
  const clearHistory = () => { viewRef.current = { list: [], pos: -1 }; setViewPos(-1); };
  const goBack = () => {
    const v = viewRef.current;
    if (v.pos > 0) { setPlaying(false); showAt(v.pos - 1); }
  };

  // Drop items shown within the last RECENT_GAP picks. If that empties the pool
  // (pool smaller than the gap — pairs, scenario packs), fall back to the
  // least-recently-shown third instead of allowing a fresh repeat, so small
  // pools cycle fully before anything comes back.
  const notRecent = (arr, key = (x) => x) => {
    const rec = recentRef.current;
    const idx = new Map();
    rec.forEach((k, i) => idx.set(k, i)); // higher index = more recent
    const fresh = arr.filter((x) => !idx.has(key(x)));
    if (fresh.length) return fresh;
    const sorted = [...arr].sort((a, b) => (idx.get(key(a)) ?? -1) - (idx.get(key(b)) ?? -1));
    return sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 3)));
  };
  const markRecent = (key) => {
    recentRef.current.push(key);
    if (recentRef.current.length > RECENT_GAP) recentRef.current.shift();
  };
  const chartScrollRef = useRef(null);
  const totalDone = totalWords;

  // Pacing tick — a short metronome click on each auto-paced word (rate-control
  // cue, standard in dysarthria therapy). AudioContext must be created/resumed
  // inside a tap handler for iOS, so ensureAudio runs on Start and on the toggle.
  const audioRef = useRef(null);
  const ensureAudio = () => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioRef.current) audioRef.current = new Ctx();
    const ctx = audioRef.current;
    if (ctx.state !== "running") ctx.resume();
    // iOS only unlocks audio if a source starts inside the tap — play a silent sample
    const b = ctx.createBufferSource();
    b.buffer = ctx.createBuffer(1, 1, 22050);
    b.connect(ctx.destination);
    b.start(0);
  };
  const playTick = () => {
    const ctx = audioRef.current;
    if (!ctx) return;
    if (ctx.state !== "running") ctx.resume();
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = 1000;
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.06);
  };

  const todayKey = dkey(new Date());
  const totalSetsAll = Object.values(hist).reduce((a, d) => a + (d.s || 0), 0);
  const rescoreDue = totalSetsAll - lastRescoreSets >= 20;
  const todayEntry = hist[todayKey] || { w: 0, p: 0, s: 0 };
  const todayWords = todayEntry.w;
  const todayPairs = todayEntry.p;
  const todaySets = todayEntry.s;
  // Check-in gates. The warm-up one fires once a day; the end-of-session one
  // fires on the day's first finished session and then every DIFF_ASK_EVERY.
  const warmAskDue = feedbackOn && warmAskDay !== todayKey;
  const sumAskDue = feedbackOn && (sumAskDay !== todayKey || sessDone - sumAskSess >= DIFF_ASK_EVERY);

  const T = dark
    ? { bg:"#141824", card:"#1E2534", ink:"#B9CDF5", mut:"#9BA4B4", line:"#2D3648", blue:"#7FA4E8", onBlue:"#101A30", btn:"#3563C7", onBtn:"#FFFFFF", rust:"#D07A55", amber:"#E9B44C", chip:"#28324A", tex:"none" }
    : { bg:"#F3ECDC", card:"#FFFDF6", ink:"#012169", mut:"#5C647A", line:"#E0D6BD", blue:"#012169", onBlue:"#FFFFFF", btn:"#012169", onBtn:"#FFFFFF", rust:"#B4532A", amber:"#E9B44C", chip:"#ECE3CC", tex:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E")` };
  const S = (px) => Math.round(px * fontScale) + "px";
  // Long words ("congratulations", "responsibility") ran off the screen at the
  // fixed clamp (CB 2026-08-19). The second half of the min() is the largest
  // size the word can be and still fit the viewport, so the text-size buttons
  // scale type up only as far as it fits. `ratio` is the average glyph width in
  // em for that weight of Atkinson Hyperlegible — measured worst case is 0.544
  // bold / 0.506 regular, and these carry a margin for the fallback face.
  const fitFont = (text, { vw, min, max, ratio }) =>
    `calc(min(clamp(${min}px, ${vw}vw, ${max}px) * ${fontScale}, (100vw - 44px) / ${(Math.max(String(text).length, 1) * ratio).toFixed(2)}))`;
  const wordFont = (w) => fitFont(w, { vw: 13, min: 40, max: 76, ratio: 0.58 });
  // A sentence sizes to its longest single word, one size for the whole line.
  const sentFont = (s) =>
    fitFont(s.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), ""), { vw: 10.4, min: 30, max: 61, ratio: 0.54 });

  // persist everything that should survive a close (A8 / M-persist)
  useEffect(() => {
    saveState({ ratings, paced, wpm, tickOn, setSize, dark, fontScale, feedbackOn, totalWords, hist, iosHintDismissed, wordStats, scenario, lastRescoreSets, condition, variant, useRec, manualRatings, diffChecks, sessDone, warmAskDay, sumAskDay, sumAskSess, diffAdj, recent: recentRef.current });
  }, [ratings, paced, wpm, tickOn, setSize, dark, fontScale, feedbackOn, totalWords, hist, iosHintDismissed, wordStats, scenario, lastRescoreSets, condition, variant, useRec, manualRatings, diffChecks, sessDone, warmAskDay, sumAskDay, sumAskSess, diffAdj]);

  // §8 bugfix: whenever "Use recommended" is on, the ratings ARE the current
  // condition's preset — enforced here (not just at screen transitions) so the
  // assess screen always shows the preset values. A test user with the toggle
  // on saw stale default 3s because presets only applied on one path.
  useEffect(() => {
    if (useRec) {
      const p = PRESETS[condition || "other"];
      setRatings({ th: p.th, tri: p.tri, lb: p.lb, rb: p.rb, sb: p.sb, fc: p.fc });
    }
  }, [useRec, condition]);

  const bump = (inc, isPair) => {
    setTotalWords((t) => t + inc);
    setHist((h) => {
      const k = dkey(new Date());
      const d = h[k] || { w: 0, p: 0, s: 0 };
      return { ...h, [k]: { ...d, w: d.w + inc, p: d.p + (isPair ? 1 : 0) } };
    });
  };

  const recordSeen = (w) => {
    setWordStats((s) => ({ ...s, [w]: { s: (s[w]?.s || 0) + 1, h: s[w]?.h || 0 } }));
  };

  // §1E warm-up queue: two separate dials. Difficulty is SPREAD across tiers
  // (6/9/9/6 per 30); category is WEIGHTED by the assessment ratings within
  // each tier band (a 5-rated category ~5× a 1-rated one). Hard-marked words
  // keep their HARD_BOOST inside each slot; the queue shuffles so every
  // warm-up set mixes easy wins with genuine challenge.
  const buildWarmupQueue = (total) => {
    const counts = tierCounts(total, diffAdj);
    const stats = statsRef.current;
    const used = sessWordsRef.current; // session-wide: nothing repeats inside one session
    const pickFrom = (tier) => {
      for (let t = tier; t >= 2; t--) { // thin tiers borrow from the one below
        const avail = Object.keys(WORDS_BY_TIER_CAT[t] || {}).filter((c) => WORDS_BY_TIER_CAT[t][c].some((w) => !used.has(w)));
        if (!avail.length) continue;
        const cat = pickCat(ratings, avail);
        const cand = notRecent(WORDS_BY_TIER_CAT[t][cat].filter((w) => !used.has(w)));
        let tw = 0;
        const ws = cand.map((w) => { const wt = hardWeight(stats[w]) * sylWeight(w, diffAdj); tw += wt; return wt; });
        let r = Math.random() * tw;
        for (let i = 0; i < cand.length; i++) { r -= ws[i]; if (r <= 0) return cand[i]; }
        return cand[cand.length - 1];
      }
      return null;
    };
    const queue = [];
    for (const t of [2, 3, 4, 5]) for (let i = 0; i < counts[t]; i++) {
      const w = pickFrom(t);
      if (w) { queue.push(w); used.add(w); }
    }
    for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; }
    return queue;
  };

  // One couples set, built up front. Rewritten 2026-08-19: the RUNG comes
  // first and the pack spread is what bends around it. The old version handed
  // each pack a slot and then let that pack fall back down the ladder when it
  // ran out of loaded sentences — which is how a set-3 slot ended up holding a
  // 1-instance sentence. Now every slot is filled from ALL packs at its target
  // rung, and pack variety is a tiebreak (fewest-used pack first, Doctor and
  // Restaurant weighted 3× among equals).
  // Nothing already used this session — sentence or target word — can appear.
  const buildCouplesQueue = (n, plan, scenOnly) => {
    const packs = scenOnly ? [scenOnly] : PACK_IDS;
    const bank = packs.flatMap((p) => PACK_BANK[p] || []);
    const usedSents = sessSentsRef.current;
    const usedWords = sessWordsRef.current;
    const packUse = {};
    const queue = [];
    const free = (x, allowWordRepeat) =>
      !usedSents.has(x) && (allowWordRepeat || !usedWords.has(SENT_META[x]?.w));
    plan.forEach((rung) => {
      let cand = [];
      // The RUNG is the point, so it outranks the no-repeat rule: hold the rung
      // and relax the word rule before dropping a slot down the ladder. (Nested
      // the other way round, a small scenario pack whose remaining loaded
      // sentences all reused a target word would quietly serve a 1-instance
      // sentence in set 3 — the exact thing this rewrite exists to stop.)
      for (const r of RUNG_FALLBACK[rung]) {
        for (const strict of [false, true]) {
          cand = bank.filter((x) => rungOf(x) === r && free(x, strict));
          if (cand.length) break;
        }
        if (cand.length) break;
      }
      if (!cand.length) return;
      const list = notRecent(cand);
      const minUse = Math.min(...list.map((x) => packUse[SENT_PACK[x]] || 0));
      const spread = list.filter((x) => (packUse[SENT_PACK[x]] || 0) === minUse);
      let tw = 0;
      const ws = spread.map((x) => { const w = SCEN_EMPHASIS[SENT_PACK[x]] ?? 1; tw += w; return w; });
      let r = Math.random() * tw;
      let sent = spread[spread.length - 1];
      for (let i = 0; i < spread.length; i++) { r -= ws[i]; if (r <= 0) { sent = spread[i]; break; } }
      packUse[SENT_PACK[sent]] = (packUse[SENT_PACK[sent]] || 0) + 1;
      usedSents.add(sent);
      if (SENT_META[sent]?.w) usedWords.add(SENT_META[sent].w);
      queue.push(sent);
    });
    return queue;
  };

  const updSess = (patch) => {
    const s = { ...sessRef.current, ...patch };
    sessRef.current = s;
    setSess(s);
    return s;
  };

  const pickFromPool = (pool) => { // hard-marked words appear HARD_BOOST× as often
    const stats = statsRef.current;
    const fresh = pool.filter((w) => !sessWordsRef.current.has(w)); // no repeats in a session
    const p = notRecent(fresh.length ? fresh : pool);
    let total = 0;
    const ws = p.map((w) => { const wt = hardWeight(stats[w]) * sylWeight(w, diffAdj); total += wt; return wt; });
    let r = Math.random() * total;
    for (let i = 0; i < p.length; i++) { r -= ws[i]; if (r <= 0) return p[i]; }
    return p[p.length - 1];
  };

  // §10 Bonus Round queue: 6 scenario sentences, one per scenario, no repeats
  // of anything shown earlier this session. Prefers sentences carrying a word
  // practiced this session, but one-per-scenario coverage wins. Short scenarios
  // are topped up from Doctor visit and Restaurant.
  const buildBonusQueue = (s) => {
    const sessWords = new Set(setItems.map((x) => cleanToken(x)).filter(Boolean));
    const shown = new Set(s.sents || []);
    const picks = [];
    const taken = (x) => shown.has(x) || picks.some((p) => p.sentence === x);
    const sessWordIn = (sent) => sent.split(/\s+/).map(cleanToken).find((t) => t && sessWords.has(t)) || null;
    for (const sc of SCENARIOS) {
      const bank = (SCENARIO_SENTENCES[sc.id] || []).filter((x) => !taken(x));
      if (!bank.length) continue;
      const pref = bank.filter(sessWordIn);
      const pool = pref.length ? pref : bank;
      const sent = pool[Math.floor(Math.random() * pool.length)];
      picks.push({ sentence: sent, w: sessWordIn(sent) });
    }
    while (picks.length < BONUS_N) {
      const fill = [...(SCENARIO_SENTENCES.dr || []), ...(SCENARIO_SENTENCES.rest || [])].filter((x) => !taken(x));
      if (!fill.length) break;
      const sent = fill[Math.floor(Math.random() * fill.length)];
      picks.push({ sentence: sent, w: sessWordIn(sent) });
    }
    return picks;
  };

  const next = () => {
    // Stepped back? Walk forward through what was already shown before making
    // anything new — replaying never re-banks progress.
    const v = viewRef.current;
    if (v.pos >= 0 && v.pos < v.list.length - 1) { showAt(v.pos + 1); return; }
    if (mode === "pairs") {
      if (doneRef.current >= setSize) return;
      const c = pickCat({ ...ratings, x: 3 }, Object.keys(PAIRS));
      // No individual word twice in a set, across pairs as well as within one.
      // The pair bank is smaller than a 150-pair set, so a full sweep resets it.
      const usedW = pairWordsRef.current;
      const openIn = (cat) => PAIRS[cat].filter((p) => !usedW.has(p[0]) && !usedW.has(p[1]));
      let open = openIn(c);
      if (!open.length) open = Object.keys(PAIRS).flatMap(openIn);
      if (!open.length) { usedW.clear(); open = PAIRS[c]; }
      const list = notRecent(open, (p) => p[0] + "/" + p[1]);
      const nx = { cat: c, pair: list[Math.floor(Math.random() * list.length)] };
      usedW.add(nx.pair[0]);
      usedW.add(nx.pair[1]);
      markRecent(nx.pair[0] + "/" + nx.pair[1]);
      show(nx);
      doneRef.current += 1;
      setSetItems((p) => [...p, nx.pair[0] + " / " + nx.pair[1]]);
      bump(2, true); // a pair counts for 2 words
      return;
    }
    // Staged session — Practice and Scenarios share one shape: warm-up words →
    // 3×10 couples escalating 1 → 2 → 3+ target-sound instances → Bonus Round.
    if (mode === "scen" && !scenario) return;
    let s = sessRef.current;
    if (!s) {
      const totalWarm = (VARIANTS.find((x) => x.id === variant) || VARIANTS[1]).warmup.reduce((a, b) => a + b, 0);
      sessWordsRef.current = new Set(); // a new session, a clean no-repeat slate
      sessSentsRef.current = new Set();
      s = updSess({ plan: buildPlan(variant), idx: 0, count: 0, brk: false, finished: false, credits: 0,
        wq: mode === "scen" ? null : buildWarmupQueue(totalWarm), wqi: 0, sents: [] });
    }
    if (s.brk || s.finished) return;
    const entry = s.plan[s.idx];
    if (s.count >= entry.n) {
      // stage-set complete — bank a set, then break (or finish after the bonus)
      setHist((h) => {
        const k = dkey(new Date());
        const d = h[k] || { w: 0, p: 0, s: 0 };
        return { ...h, [k]: { ...d, s: d.s + 1 } };
      });
      setPlaying(false);
      updSess(s.idx >= s.plan.length - 1 ? { finished: true } : { brk: true });
      return;
    }
    const cur = itemRef.current;
    if (cur && cur.kind === "couple" && cur.beat === 1) {
      // beat 2: the word inside its sentence; credit = the sentence's targets
      const nx = { ...cur, beat: 2 };
      show(nx);
      bump(nx.targets.length, false);
      updSess({ count: s.count + 1, credits: s.credits + nx.targets.length });
      return;
    }
    let nx;
    if (entry.stage === "warmup") {
      let w;
      if (mode === "scen") w = pickFromPool(SCENARIOS.find((sc) => sc.id === scenario)?.words || []);
      else {
        w = s.wq && s.wqi < s.wq.length ? s.wq[s.wqi] : pickFromPool(Object.values(WORDS).flat());
        s = updSess({ wqi: s.wqi + 1 });
      }
      sessWordsRef.current.add(w);
      nx = { kind: "word", w };
      recordSeen(w);
      markRecent(w);
      setSetItems((p) => [...p, w]);
      bump(1, false);
      updSess({ count: s.count + 1, credits: s.credits + 1 });
    } else if (entry.stage === "couples") {
      // §6 ladder: each set's rung mix comes from RUNG_MIX via the difficulty
      // check-in — at Medium, set 3 is all 2- and 3-instance sentences. The
      // whole set is queued up front (see buildCouplesQueue) so the mix and the
      // pack spread are both guaranteed; rebuilt when the set changes and when
      // a Redo runs the same set again.
      const pos = s.plan.slice(0, s.idx).filter((p) => p.stage === "couples").length + 1;
      if (s.cqFor !== s.idx || s.cqi >= (s.cq?.length ?? 0)) {
        s = updSess({ cq: buildCouplesQueue(entry.n, rungPlan(entry.n, pos, diffAdj), mode === "scen" ? scenario : null), cqi: 0, cqFor: s.idx });
      }
      let sent = s.cq[s.cqi];
      if (!sent) { // queue exhausted (thin pack) — fall back to a single draw
        const bank = (mode === "scen" && SCENARIO_SENTENCES[scenario]) || ALL_COUPLE_SENTS;
        const want = rungPlan(1, pos, diffAdj)[0];
        let cand = [];
        for (const r of RUNG_FALLBACK[want]) { cand = bank.filter((x) => rungOf(x) === r && !sessSentsRef.current.has(x)); if (cand.length) break; }
        if (!cand.length) cand = bank;
        const list = notRecent(cand);
        sent = list[Math.floor(Math.random() * list.length)];
      }
      s = updSess({ cqi: s.cqi + 1 });
      const w = SENT_META[sent]?.w || topTarget(sent);
      sessWordsRef.current.add(w);
      sessSentsRef.current.add(sent);
      nx = { kind: "couple", sentence: sent, targets: targetsOf(sent), w, beat: 1, hint: !s.hinted };
      recordSeen(w);
      markRecent(sent);
      setSetItems((p) => [...p, w]);
      bump(1, false); // the couple's count advances at beat 2
      updSess({ credits: s.credits + 1, hinted: true, sents: [...(s.sents || []), sent] });
    } else {
      // §10 Bonus Round: one sentence per scenario, highlight only a word
      // practiced this session (none at all otherwise — never a substitute).
      let q = s.bonusQ;
      if (!q) { q = buildBonusQueue(s); s = updSess({ bonusQ: q }); }
      const pick = q[Math.min(s.count, q.length - 1)];
      const targets = targetsOf(pick.sentence);
      nx = { kind: "bonus", sentence: pick.sentence, w: pick.w };
      markRecent(pick.sentence);
      if (pick.w) setSetItems((p) => [...p, pick.w]);
      bump(targets.length, false);
      updSess({ count: s.count + 1, credits: s.credits + targets.length });
    }
    show(nx);
  };

  // Break-screen controls: Continue advances, Redo re-runs the same stage-set,
  // skip jumps forward mid-set. Progress already banked is never lost (§9A).
  const resumeEntry = (redo) => {
    const s0 = sessRef.current;
    if (!s0) return;
    if (!redo && s0.idx >= s0.plan.length - 1) { updSess({ brk: false, finished: true }); return; }
    updSess({ brk: false, count: 0, idx: redo ? s0.idx : s0.idx + 1 });
    itemRef.current = null;
    setItem(null);
    clearHistory(); // Back never reaches across a break into the previous set
    next();
  };
  const skipStage = () => { setPlaying(false); resumeEntry(false); };

  const stageInfo = (s) => {
    const e = s.plan[s.idx];
    const same = s.plan.filter((p) => p.stage === e.stage).length;
    const pos = s.plan.slice(0, s.idx).filter((p) => p.stage === e.stage).length + 1;
    const name = e.stage === "warmup" ? "Warm-up" : e.stage === "couples" ? "Sentences" : "Bonus Round";
    return { name: same > 1 ? `${name} — set ${pos} of ${same}` : name, n: e.n };
  };

  useEffect(() => {
    if (playing && paced) {
      let alive = true;
      // §7: one shared WPM on one slider; a word holds one beat and a sentence
      // holds for the syllables it actually contains (see holdMs).
      const step = () => {
        if (!alive) return;
        next();
        if (tickOn) playTick();
        timerRef.current = setTimeout(step, holdMs(itemRef.current, wpm));
      };
      // Start on what's already on screen instead of advancing past it — in the
      // Bonus Round the first sentence used to vanish the instant you pressed
      // Start (CB 2026-08-19). The clock now begins on the item you're reading.
      if (itemRef.current && !sessRef.current?.brk) {
        if (tickOn) playTick();
        timerRef.current = setTimeout(step, holdMs(itemRef.current, wpm));
      } else step();
      return () => { alive = false; clearTimeout(timerRef.current); };
    }
    return () => clearTimeout(timerRef.current);
  }, [playing, wpm, mode, ratings, paced, tickOn]);

  // M1 — keep the screen awake during a paced drill; release on pause/unmount
  useEffect(() => {
    if (playing && "wakeLock" in navigator) {
      navigator.wakeLock.request("screen").then((l) => { wakeRef.current = l; }).catch(() => {});
    }
    return () => {
      if (wakeRef.current) { wakeRef.current.release().catch(() => {}); wakeRef.current = null; }
    };
  }, [playing]);

  // M2 — auto-pause when the app is backgrounded; never silently resume
  useEffect(() => {
    const onHide = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  // staged session completion → award + summary (sets were banked per stage)
  useEffect(() => {
    if (screen === "drill" && sess?.finished) {
      setPlaying(false);
      const prevTotal = totalDone - sess.credits;
      const ms = MILESTONES.find((m) => prevTotal < m && totalDone >= m);
      setAward(ms ? { milestone: ms } : { session: true });
      setDifficult({});
      marksAppliedRef.current = false;
      setSessDone((n) => n + 1); // drives the end-of-session check-in cadence
      setScreen("summary");
    }
  }, [sess, totalDone]);

  // pairs set completion → award + summary
  useEffect(() => {
    if (screen === "drill" && mode === "pairs" && setItems.length >= setSize) {
      setPlaying(false);
      const prevTotal = totalDone - setItems.length;
      const ms = MILESTONES.find((m) => prevTotal < m && totalDone >= m);
      const newSets = (hist[todayKey]?.s ?? 0) + 1;
      setAward(ms ? { milestone: ms } : newSets % 10 === 0 ? { setsMilestone: newSets } : { set: true, n: newSets });
      setHist((h) => {
        const k = dkey(new Date());
        const d = h[k] || { w: 0, p: 0, s: 0 };
        return { ...h, [k]: { ...d, s: d.s + 1 } };
      });
      setDifficult({});
      marksAppliedRef.current = false;
      setSessDone((n) => n + 1);
      setScreen("summary");
    }
  }, [setItems]);

  // Opening an ask point closes its gate, answered or not — an ignored
  // check-in doesn't come back next session (CB 2026-08-09: never pester).
  useEffect(() => {
    const s = sess;
    if (screen === "drill" && s?.brk && s.idx === 0 && s.plan[0].stage === "warmup" && !warmAsk && warmAskDue) {
      setWarmAsk(true);
      setWarmAskDay(todayKey);
    }
  }, [screen, sess]);
  useEffect(() => {
    if (screen === "summary" && !sumAsk && sumAskDue) {
      setSumAsk(true);
      setSumAskDay(todayKey);
      setSumAskSess(sessDone);
    }
  }, [screen]);

  useEffect(() => { // keep charts scrolled to the latest bar
    if (chartScrollRef.current) chartScrollRef.current.scrollLeft = chartScrollRef.current.scrollWidth;
  }, [range, screen]);

  // Fold the summary-screen "hard" taps into word stats: marked words get the
  // hard boost and restart their clean streak; unmarked appearances cool a
  // previous hard flag down one level.
  const applyHardMarks = () => {
    if (!HARD_MARKS) return; // paused — nothing marks words hard right now
    if (marksAppliedRef.current || !setItems.length) return;
    marksAppliedRef.current = true;
    const marks = difficult;
    const labels = setItems;
    setWordStats((s) => {
      const ns = { ...s };
      labels.forEach((label, i) => {
        label.split(" / ").forEach((w) => {
          const cur = ns[w] || { s: 0, h: 0 };
          if (marks[i]) ns[w] = { s: 0, h: 2 };
          else if (cur.h > 0) ns[w] = { ...cur, h: cur.h - 1 };
        });
      });
      return ns;
    });
  };

  const startNewSet = () => {
    applyHardMarks();
    doneRef.current = 0;
    itemRef.current = null;
    sessRef.current = null;
    setSess(null);
    setSetItems([]);
    setItem(null);
    clearHistory();
    sessWordsRef.current = new Set();
    sessSentsRef.current = new Set();
    pairWordsRef.current = new Set();
    setAward(null);
    setWarmAsk(false);
    setSumAsk(false);
    setWarmAnswer(null);
    setSumAnswer(null);
    setScreen("drill");
  };
  // each set is one mode — hard-word review never mixes words with pairs
  const switchMode = (m) => {
    setPlaying(false); setMode(m); setItem(null); itemRef.current = null; doneRef.current = 0;
    setSetItems([]); sessRef.current = null; setSess(null); clearHistory();
    sessWordsRef.current = new Set(); sessSentsRef.current = new Set(); pairWordsRef.current = new Set();
  };
  // One check-in answer, from either ask point (the gates already closed when
  // the ask opened). It logs the answer and moves the difficulty dial, which
  // steers both the warm-up tier mix and the sentence ladder from here on.
  const answerDiff = (v, where) => {
    const lvl = DIFF_LEVELS.find((l) => l.id === v);
    setDiffChecks((c) => [...c, { d: todayKey, v, sess: sessDone }]);
    (where === "warmup" ? setWarmAnswer : setSumAnswer)(v);
    setDiffAdj(lvl?.adj ?? 0); // latest read wins — the dial no longer accumulates
  };
  const togglePaced = () => { setPlaying(false); setPaced((p) => !p); };

  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Bricolage+Grotesque:wght@600;700&display=swap');
    * { box-sizing: border-box; margin: 0; }
    .app { min-height: 100vh; min-height: 100dvh; background: ${T.bg}; background-image: ${T.tex}; color: ${T.ink}; font-family: 'Atkinson Hyperlegible', sans-serif; display: flex; flex-direction: column; padding-bottom: env(safe-area-inset-bottom); }
    .app button:focus-visible, .app input:focus-visible { outline: 3px solid ${T.blue}; outline-offset: 2px; }
    .top { padding: calc(18px + env(safe-area-inset-top)) 20px 10px; display: flex; align-items: center; justify-content: space-between; }
    .logo { font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: 20px; letter-spacing: -0.01em; border: 2px solid ${T.ink}; border-radius: 14px; padding: 8px 14px; background: none; color: ${T.ink}; cursor: pointer; }
    .logo span { color: ${dark ? T.blue : T.blue}; }
    .logo em { font-style: normal; color: ${T.amber}; }
    .hdrBtns { display: flex; gap: 8px; }
    .hdrBtn { border: none; cursor: pointer; background: ${T.btn}; color: ${T.onBtn}; font-weight: 700; font-size: ${S(16)}; min-height: 44px; padding: 0 18px; border-radius: 12px; font-family: 'Atkinson Hyperlegible'; }
    .card { background: ${T.card}; border-radius: 20px; margin: 10px 8px; padding: 20px; box-shadow: 0 1px 3px rgba(20,25,40,0.10); }
    h2 { font-family: 'Bricolage Grotesque'; font-size: ${S(21)}; margin-bottom: 6px; color: ${T.blue}; }
    .sub { font-size: ${S(16)}; color: ${T.mut}; line-height: 1.45; margin-bottom: 14px; }
    .catRow { padding: 12px 0; border-bottom: 1px solid ${T.line}; }
    .catRow:last-child { border-bottom: none; }
    .catTop { display: flex; align-items: baseline; justify-content: space-between; gap: 6px 12px; flex-wrap: wrap; margin-bottom: 10px; }
    .catName { font-weight: 700; font-size: ${S(18)}; }
    .catEx { font-size: ${S(18)}; color: ${T.mut}; font-style: italic; }
    .dots { display: flex; gap: 8px; }
    .dot { width: 44px; height: 44px; border-radius: 12px; border: 1.5px solid ${T.line}; background: ${T.card}; font-weight: 700; font-size: ${S(17)}; color: ${T.mut}; cursor: pointer; font-family: 'Atkinson Hyperlegible'; }
    .dot.on { background: ${T.btn}; border-color: ${T.btn}; color: ${T.onBtn}; }
    .cta { display: block; width: calc(100% - 32px); margin: 14px 16px 24px; padding: 16px; border: none; border-radius: 16px; background: ${T.btn}; color: ${T.onBtn}; font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: ${S(16)}; cursor: pointer; }
    .tabs { display: flex; gap: 8px; margin: 4px 16px; }
    .tab { flex: 1; padding: 12px 6px; border-radius: 12px; border: 1.5px solid ${T.line}; background: ${T.card}; font-weight: 700; font-size: ${S(15)}; color: ${T.mut}; cursor: pointer; min-height: 44px; font-family: 'Atkinson Hyperlegible'; }
    .tab.on { background: ${T.btn}; border-color: ${T.btn}; color: ${T.onBtn}; }
    .stage { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 300px; padding: 10px 16px; }
    .word { font-weight: 700; font-size: calc(clamp(44px, 13vw, 76px) * ${fontScale}); letter-spacing: -0.01em; text-align: center; line-height: 1.05; color: ${T.blue}; }
    .pairWrap { display: flex; flex-direction: row; flex-wrap: wrap; gap: 6px 20px; align-items: baseline; justify-content: center; }
    .pair2 { font-weight: 700; font-size: calc(clamp(44px, 13vw, 76px) * ${fontScale}); letter-spacing: -0.01em; text-align: center; line-height: 1.05; color: ${T.blue}; }
    .sentWrap { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 18px; max-width: 900px; font-size: calc(clamp(35px, 10.4vw, 61px) * ${fontScale}); }
    .sw { font-weight: 400; font-size: inherit; line-height: 1.1; color: ${T.blue}; padding: 0 4px; border-radius: 12px; }
    .sw.tgt { font-weight: 700; background: ${T.chip}; }
    .coupleHint { margin-top: 18px; font-size: ${S(24)}; color: ${T.ink}; text-align: center; line-height: 1.35; }
    .idle { color: ${T.mut}; font-size: ${S(17)}; text-align: center; max-width: 340px; line-height: 1.5; }
    .controls { padding: 0 16px 26px; }
    .paceRow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; background: ${T.card}; border-radius: 16px; padding: 12px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(20,25,40,0.10); min-height: 60px; }
    /* Pace controls are sized for elderly hands (CB 2026-08-19): a 52px thumb
       on an 18px track, big −/+ steppers either side, and a value you can read
       across the room. */
    .paceWrap { display: flex; align-items: center; gap: 10px; width: 100%; }
    .paceVal { font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: ${S(24)}; min-width: 116px; text-align: center; }
    .paceStep { width: 64px; height: 64px; flex-shrink: 0; border-radius: 18px; border: 2px solid ${T.btn}; background: ${T.card}; color: ${T.btn}; font-weight: 700; font-size: 30px; line-height: 1; cursor: pointer; font-family: 'Atkinson Hyperlegible'; }
    input[type=range] { -webkit-appearance: none; appearance: none; flex: 1 1 120px; min-width: 100px; background: transparent; height: 64px; margin: 0; }
    input[type=range]::-webkit-slider-runnable-track { height: 18px; border-radius: 999px; background: ${dark ? "#3A4560" : "#DED3B7"}; }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 52px; height: 52px; margin-top: -17px; border-radius: 50%; background: ${T.btn}; border: 4px solid ${T.card}; box-shadow: 0 2px 5px rgba(20,25,40,0.35); cursor: pointer; }
    input[type=range]::-moz-range-track { height: 18px; border-radius: 999px; background: ${dark ? "#3A4560" : "#DED3B7"}; }
    input[type=range]::-moz-range-thumb { width: 52px; height: 52px; border-radius: 50%; background: ${T.btn}; border: 4px solid ${T.card}; box-shadow: 0 2px 5px rgba(20,25,40,0.35); cursor: pointer; }
    .switch { display: flex; align-items: center; gap: 10px; border: none; background: none; cursor: pointer; padding: 8px 0; min-height: 44px; font-family: 'Atkinson Hyperlegible'; }
    .swLbl { font-size: ${S(14)}; font-weight: 700; color: ${T.ink}; white-space: nowrap; }
    .track { width: 46px; height: 26px; border-radius: 999px; background: ${dark ? "#3A4560" : "#CFC5AB"}; position: relative; flex-shrink: 0; }
    .track.on { background: ${T.blue}; }
    .knob { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left 0.15s; }
    .track.on .knob { left: 23px; }
    .btnRow { display: flex; gap: 10px; }
    /* Drill buttons are the app's main target — 88px tall, big type. */
    .play { flex: 2; padding: 22px 16px; min-height: 88px; border: none; border-radius: 20px; font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: ${S(26)}; cursor: pointer; background: ${T.btn}; color: ${T.onBtn}; }
    .play.stop { background: ${T.rust}; color: #fff; }
    .ghost { flex: 1; padding: 16px 12px; border-radius: 16px; border: 1.5px solid ${T.line}; background: ${T.card}; font-weight: 700; font-size: ${S(14)}; color: ${T.ink}; cursor: pointer; font-family: 'Atkinson Hyperlegible'; }
    .btnRow .ghost { min-height: 88px; border-radius: 20px; font-size: ${S(20)}; border-width: 2px; }
    .btnRow .ghost:disabled { opacity: 0.4; cursor: default; }
    .meta { text-align: center; font-size: ${S(14)}; color: ${T.mut}; margin-top: 10px; }
    .setBar { height: 6px; border-radius: 999px; background: ${T.line}; margin: 0 16px 4px; overflow: hidden; }
    .setFill { height: 100%; background: ${T.btn}; border-radius: 999px; transition: width 0.3s; }
    .awardWrap { display: flex; flex-direction: column; align-items: center; gap: 6px; animation: pop 0.5s ease-out; }
    .awardFade { animation: pop 0.5s ease-out, fadeout 0.6s ease 2.2s forwards; }
    @keyframes pop { 0% { transform: scale(0.3); opacity: 0; } 55% { transform: scale(1.12); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
    @keyframes fadeout { to { opacity: 0; } }
    .awardLbl { font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: ${S(17)}; color: ${T.ink}; }
    .wordGrid { display: flex; flex-wrap: wrap; gap: 8px; }
    .wchip { padding: 10px 14px; min-height: 44px; border-radius: 12px; border: 1.5px solid ${T.line}; background: ${T.card}; font-size: ${S(17)}; font-weight: 400; color: ${T.ink}; cursor: pointer; font-family: 'Atkinson Hyperlegible'; }
    .wchip.hard { background: ${T.btn}; border-color: ${T.btn}; color: ${T.onBtn}; font-weight: 700; }
    .bigNum { font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: ${S(46)}; line-height: 1; }
    .bigLbl { font-size: ${S(14)}; color: ${T.mut}; margin-top: 4px; }
    .chartWrap { position: relative; height: 224px; margin-top: 14px; }
    .chartScroll { position: absolute; left: 42px; right: 0; top: 0; bottom: 0; overflow-x: auto; padding-bottom: 12px; scrollbar-width: thin; scrollbar-color: ${T.blue} ${T.line}; }
    .chartScroll::-webkit-scrollbar { height: 8px; }
    .chartScroll::-webkit-scrollbar-track { background: ${T.line}; border-radius: 999px; }
    .chartScroll::-webkit-scrollbar-thumb { background: ${T.blue}; border-radius: 999px; }
    .chartInner { position: relative; height: 100%; min-width: 100%; }
    .chartArea { display: flex; gap: 6px; height: 100%; width: 100%; }
    .col { flex: 1 0 42px; min-width: 42px; display: flex; flex-direction: column; align-items: center; height: 100%; }
    .barBox { flex: 1; width: 100%; display: flex; align-items: flex-end; justify-content: center; }
    .bar { width: 100%; max-width: 26px; border-radius: 7px; background: ${T.blue}; opacity: 0.45; }
    .bar.today { opacity: 1; }
    .dayLbl { height: 22px; font-size: 12px; color: ${T.mut}; display: flex; align-items: center; }
    .gLine { position: absolute; left: 0; right: 0; border-top: 1px solid ${T.line}; }
    .gLbl { position: absolute; left: 0; width: 36px; text-align: right; font-size: 12px; color: ${T.mut}; transform: translateY(50%); }
    .ringsRow { display: flex; align-items: center; gap: 18px; }
    .ringsSvg { width: 44%; max-width: 170px; flex-shrink: 0; }
    .bigLeg { display: flex; flex-direction: column; gap: 12px; }
    .bigLegName { font-size: ${S(18)}; font-weight: 700; }
    .bigLegVal { font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: ${S(34)}; line-height: 1; margin-top: 2px; }
    .streakNum { font-family: 'Bricolage Grotesque'; font-weight: 700; line-height: 0.9; }
    .streakLbl { font-size: ${S(20)}; font-weight: 700; color: ${T.mut}; }
    .legend { display: flex; flex-direction: column; gap: 12px; }
    .legLbl { font-size: ${S(15)}; font-weight: 700; }
    .legVal { font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: ${S(30)}; line-height: 1.05; }
    .rangeBar { display: flex; gap: 4px; background: ${dark ? "#2A3346" : "#E7DDC6"}; border-radius: 14px; padding: 4px; }
    .rangeBtn { flex: 1; min-height: 44px; border: none; border-radius: 11px; background: transparent; color: ${T.mut}; font-weight: 700; font-size: ${S(15)}; cursor: pointer; font-family: 'Atkinson Hyperlegible'; }
    .rangeBtn.on { background: ${T.card}; color: ${T.ink}; box-shadow: 0 1px 3px rgba(20,25,40,0.15); }
    .tiles { display: flex; gap: 10px; margin: 10px 8px; }
    .tile { flex: 1; background: ${T.card}; border-radius: 20px; padding: 16px 18px; box-shadow: 0 1px 3px rgba(20,25,40,0.10); }
    .tileLbl { font-family: 'Bricolage Grotesque'; font-size: ${S(22)}; font-weight: 700; margin-bottom: 8px; }
    .tileVal { font-family: 'Bricolage Grotesque'; font-weight: 700; font-size: ${S(30)}; line-height: 1; }
    .sizeRow { display: flex; justify-content: center; align-items: center; gap: 8px; padding: 4px 16px 22px; }
    .sizeLbl { font-size: ${S(14)}; color: ${T.mut}; font-weight: 700; margin-right: 4px; }
    .setting { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid ${T.line}; min-height: 56px; gap: 12px; }
    .setting:last-child { border-bottom: none; }
    .setLbl { font-weight: 700; font-size: ${S(16)}; }
    .seg { display: flex; gap: 6px; }
    .segBtn { min-width: 44px; min-height: 44px; border-radius: 12px; border: 1.5px solid ${T.line}; background: ${T.card}; color: ${T.mut}; font-weight: 700; cursor: pointer; font-family: 'Atkinson Hyperlegible'; }
    .segBtn.on { background: ${T.btn}; border-color: ${T.btn}; color: ${T.onBtn}; }
    .stepVal { font-weight: 700; font-size: ${S(16)}; min-width: 40px; text-align: center; }
    .condBtn { display: block; width: 100%; margin: 10px 0; padding: 16px; min-height: 56px; border-radius: 14px; border: 1.5px solid ${T.line}; background: ${T.card}; font-weight: 700; font-size: ${S(17)}; color: ${T.ink}; cursor: pointer; text-align: left; font-family: 'Atkinson Hyperlegible'; }
    .condBtn.on { background: ${T.btn}; border-color: ${T.btn}; color: ${T.onBtn}; }
    .linkBtn { border: none; background: none; color: ${T.blue}; text-decoration: underline; cursor: pointer; font-size: inherit; font-family: inherit; padding: 6px; }
    .hintRow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .hintTxt { font-size: ${S(15)}; line-height: 1.5; }
    .instSteps { display: flex; flex-direction: column; gap: 14px; margin-top: 6px; }
    .instStep { display: flex; align-items: center; gap: 14px; }
    .instIcon { flex: 0 0 auto; }
    @media (max-width: 640px) {
      .tiles { flex-direction: column; }
      .ringsRow { gap: 22px; justify-content: center; }
      .ringsSvg { width: 62%; max-width: 320px; }
      .bigLegVal { font-size: ${S(40)}; }
      .tile { padding: 20px; }
    }
    @media (prefers-reduced-motion: reduce) { .knob, .setFill { transition: none; } .awardWrap, .awardFade { animation: none; } }
  `;

  // Ranks categories by the user's actual hard-mark rate and drafts new 1–5
  // ratings from it (hardest category gets 5, scaled down; overridable).
  const goRescore = () => {
    const stats = statsRef.current;
    const rows = CATS.map((c) => {
      let seen = 0; const hard = [];
      WORDS[c.id].forEach((w) => {
        const st = stats[w];
        if (st && (st.s > 0 || st.h > 0)) seen++;
        if (st?.h > 0) hard.push(w);
      });
      return { ...c, seen, hard, ratio: seen >= 5 ? hard.length / seen : 0 };
    }).sort((a, b) => b.ratio - a.ratio);
    const maxR = Math.max(...rows.map((r) => r.ratio));
    const sugg = {};
    rows.forEach((r) => {
      sugg[r.id] = maxR > 0 ? Math.max(1, Math.min(5, Math.round(1 + 4 * (r.ratio / maxR)))) : (ratings[r.id] || 3);
    });
    setDraft({ rows, sugg });
    setPlaying(false);
    setScreen("rescore");
  };

  const Header = ({ right }) => (
    <div className="top">
      <button className="logo" onClick={() => { setPlaying(false); setScreen("landing"); }} aria-label="About Tongue and Groove">
        Tongue <em>&amp;</em> <span>Groove</span>
      </button>
      <div className="hdrBtns">{right}</div>
    </div>
  );

  const SizeRow = () => (
    <div className="sizeRow">
      <span className="sizeLbl">Text size</span>
      {[[1, 13], [1.15, 18], [1.3, 25]].map(([v, px]) => (
        <button key={v} className={"segBtn" + (fontScale === v ? " on" : "")} style={{ fontSize: px }}
          onClick={() => setFontScale(v)} aria-label={"Text size " + px}>A</button>
      ))}
    </div>
  );

  if (screen === "landing") {
    const returning = totalWords > 0 || totalSetsAll > 0;
    return (
      <div className="app">
        <style>{css}</style>
        <div className="top" style={{ justifyContent: "center", paddingTop: "calc(34px + env(safe-area-inset-top))" }}>
          <span className="logo" style={{ fontSize: 26, padding: "12px 20px", cursor: "default" }}>Tongue <em>&amp;</em> <span>Groove</span></span>
        </div>
        <div className="card">
          <h2>Practice speaking. Out loud. Every day.</h2>
          <p className="sub" style={{ marginBottom: 0 }}>A daily speech workout for people rebuilding clear speech — after a stroke or brain injury, or with Parkinson's. Private to your device, no account needed.</p>
        </div>
        <div className="card">
          <h2>Why it works</h2>
          <p className="sub"><b>The right words.</b> Built from the 1,500 most-used words in real conversation, filtered to the patterns that challenge the mouth most — blends, clusters, and TH sounds. You practice what you'll actually say.</p>
          <p className="sub"><b>Tuned to you.</b> You score six sound types from 1–5, and practice leans toward your hardest. A one-tap check-in — how was that? — nudges the words and sentences easier or harder as you go.</p>
          <p className="sub"><b>Real life built in.</b> Ready-made word sets for the restaurant, the doctor's office, phone calls, and more.</p>
          <p className="sub"><b>Momentum you can see.</b> Daily rings, streaks, and milestone awards make every session count.</p>
          <p className="sub" style={{ marginBottom: 0 }}><i>A practice tool, not medical treatment — keep working with your care team.</i></p>
        </div>
        <button className="cta" onClick={() => setScreen("condition")}>START</button>
        {returning && (
          <button className="ghost" style={{ display: "block", width: "calc(100% - 32px)", margin: "0 16px 20px" }}
            onClick={() => setScreen("progress")}>Back to my practice</button>
        )}
        <SizeRow />
      </div>
    );
  }

  if (screen === "condition") {
    return (
      <div className="app">
        <style>{css}</style>
        <Header right={null} />
        <div className="card">
          <h2>What brings you here?</h2>
          <p className="sub">This tunes the recommended practice mix for you. You can change it — or your sound ratings — any time in Settings.</p>
          {CONDITIONS.map((c) => (
            <button key={c.id} className="condBtn" onClick={() => {
              setCondition(c.id);
              setVariant(COND_VARIANT[c.id]);
              setScreen("assess"); // preset ratings apply via the useRec sync effect
            }}>{c.name}</button>
          ))}
        </div>
        <SizeRow />
      </div>
    );
  }

  if (screen === "rescore" && draft) {
    return (
      <div className="app">
        <style>{css}</style>
        <Header right={<button className="hdrBtn" onClick={() => setScreen("progress")}>Progress</button>} />
        <div className="card">
          <h2>Your hardest types, ranked from hardest to easiest</h2>
          <p className="sub">Based on the words you marked hard. We've suggested new scores — <b>5 = most practice.</b> Change any, then save.</p>
          {draft.rows.map((r) => (
            <div className="catRow" key={r.id}>
              <div className="catTop">
                <span className="catName">{r.name}</span>
                <span className="catEx">{r.hard.length ? "e.g. " + r.hard.slice(0, 5).join(", ") : r.seen >= 5 ? "no hard words yet" : "not enough practice yet"}</span>
              </div>
              <div className="dots">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} className={"dot" + (draft.sugg[r.id] === n ? " on" : "")}
                    onClick={() => setDraft((d) => ({ ...d, sugg: { ...d.sugg, [r.id]: n } }))}>{n}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <button className="cta" onClick={() => {
          setRatings((rt) => ({ ...rt, ...draft.sugg }));
          setManualRatings((rt) => ({ ...(rt || ratings), ...draft.sugg }));
          setUseRec(false); // saving custom scores is a manual choice (§8)
          setLastRescoreSets(totalSetsAll);
          setScreen("progress");
        }}>Save my new ratings</button>
        <SizeRow />
      </div>
    );
  }

  if (screen === "assess") {
    return (
      <div className="app">
        <style>{css}</style>
        <Header right={<span className="hdrBtn" style={{ color: T.mut, cursor: "default", background: "none" }}>SETUP</span>} />
        <div className="card">
          <h2>What's hard for you right now?</h2>
          <p className="sub"><b>5 = hardest for you.</b> Higher ratings get more practice time. Leave "Use recommended" on and we'll tune this for you — or switch it off to set your own. You can update these any time in Settings.</p>
          <div className="setting" style={{ paddingTop: 0 }}>
            <span className="setLbl">Use recommended</span>
            <button className="switch" onClick={() => {
              const on = !useRec;
              setUseRec(on);
              if (on) setManualRatings(ratings); // §8: manual choices survive the flip back; the sync effect applies the preset
              else if (manualRatings) setRatings(manualRatings);
            }} aria-pressed={useRec}>
              <span className={"track" + (useRec ? " on" : "")}><span className="knob" /></span>
            </button>
          </div>
          {CATS.map((c) => (
            <div className="catRow" key={c.id} style={useRec ? { opacity: 0.55 } : null}>
              <div className="catTop"><span className="catName">{c.name}</span><span className="catEx">like {c.ex}</span></div>
              <div className="dots">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} className={"dot" + (ratings[c.id] === n ? " on" : "")}
                    onClick={() => { if (!useRec) { const nr = { ...ratings, [c.id]: n }; setRatings(nr); setManualRatings(nr); } }}>{n}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <button className="cta" onClick={() => setScreen(condition ? "drill" : "condition")}>{condition ? "Start practicing" : "Continue"}</button>
        <SizeRow />
      </div>
    );
  }

  if (screen === "summary") {
    return (
      <div className="app">
        <style>{css}</style>
        <Header right={<button className="hdrBtn" onClick={() => { applyHardMarks(); setScreen("progress"); }}>Progress</button>} />
        <div className="card" style={{ textAlign: "center", paddingTop: 26 }}>
          {award && (
            <div className="awardWrap">
              <Badge size={award.set ? 72 : 104} color={award.milestone ? T.amber : T.blue}
                ring={award.milestone ? T.blue : T.amber} star={award.milestone ? T.ink : "#fff"} />
              <div className="awardLbl">
                {award.milestone ? award.milestone.toLocaleString() + " words!"
                  : award.session ? "Session complete! 💪"
                  : award.setsMilestone ? award.setsMilestone + " sets today! 🎉"
                  : award.n === 1 ? "1 down — nice start!"
                  : award.n + " down today!"}
              </div>
            </div>
          )}
          <div className="bigNum" style={{ marginTop: award ? 12 : 0 }}>{setItems.length}</div>
          <div className="bigLbl">{mode === "pairs" ? "pairs this set" : "items this session"} · {totalDone.toLocaleString()} total target words</div>
        </div>
        {/* End-of-session check-in — the one piece of feedback the app asks
            for now. Shown on a finished session, gated by sumAskDue. */}
        {sumAsk && (
          <div className="card">
            <h2>How was that?</h2>
            {sumAnswer ? (
              <>
                <p className="sub" style={{ marginBottom: 0 }}>{DIFF_ACK[sumAnswer]}</p>
                {sumAnswer === "vhard" && paced && (
                  <button className="condBtn" style={{ marginTop: 10 }}
                    onClick={() => setWpm((w) => Math.max(10, w - 5))}>Slow the pace to {Math.max(10, wpm - 5)} WPM</button>
                )}
              </>
            ) : (
              <>
                <p className="sub">A quick check-in — your honest read tunes the words and sentences you get next time.</p>
                {DIFF_LEVELS.map((l) => (
                  <button key={l.id} className="condBtn" style={{ margin: "3px 0" }}
                    onClick={() => answerDiff(l.id, "summary")}>{l.label}</button>
                ))}
              </>
            )}
          </div>
        )}
        {rescoreDue && (
          <div className="card" style={{ textAlign: "center" }}>
            <h2 style={{ marginBottom: 6 }}>{totalSetsAll} sets in — time to re-check your scores</h2>
            {HARD_MARKS ? (
              <>
                <p className="sub">See your hardest sound types ranked, with new suggested ratings based on the words you marked hard.</p>
                <button className="cta" style={{ width: "100%", margin: 0 }} onClick={() => { applyHardMarks(); goRescore(); }}>See my hardest sounds</button>
              </>
            ) : (
              <>
                <p className="sub">Sounds shift as you practice. Take a look at your 1–5 ratings and move any that no longer feel right.</p>
                <button className="cta" style={{ width: "100%", margin: 0 }}
                  onClick={() => { setLastRescoreSets(totalSetsAll); setPlaying(false); setScreen("assess"); }}>Check my sound ratings</button>
              </>
            )}
          </div>
        )}
        <button className="cta" onClick={startNewSet}>{mode === "pairs" ? "Next set" : "New session"}</button>
        <SizeRow />
      </div>
    );
  }

  if (screen === "settings") {
    return (
      <div className="app">
        <style>{css}</style>
        <Header right={<><button className="hdrBtn" onClick={() => { if (mode === "pairs" ? setItems.length >= setSize : sessRef.current?.finished) startNewSet(); else setScreen("drill"); }}>Practice</button><button className="hdrBtn" onClick={() => setScreen("progress")}>Progress</button></>} />
        <div className="card">
          <h2>Settings</h2>
          <div className="setting" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
            <span className="setLbl">What's hardest right now?</span>
            <p className="sub" style={{ margin: "2px 0 4px" }}>Changes how the warm-up is split into sets. The sentence work stays the same.</p>
            {VARIANTS.map((v) => (
              <button key={v.id} className={"condBtn" + (variant === v.id ? " on" : "")} style={{ margin: "3px 0" }}
                onClick={() => setVariant(v.id)}>{v.label}</button>
            ))}
          </div>
          <div className="setting">
            <span className="setLbl">Pairs per set (Sound pairs)</span>
            <div className="seg">
              <button className="segBtn" onClick={() => setSetSize((s) => Math.max(25, s - 25))} aria-label="Fewer pairs per set">−</button>
              <span className="stepVal" style={{ alignSelf: "center" }}>{setSize}</span>
              <button className="segBtn" onClick={() => setSetSize((s) => Math.min(150, s + 25))} aria-label="More pairs per set">+</button>
            </div>
          </div>
          <div className="setting">
            <span className="setLbl">Dark mode</span>
            <button className="switch" onClick={() => setDark((d) => !d)} aria-pressed={dark}>
              <span className={"track" + (dark ? " on" : "")}><span className="knob" /></span>
            </button>
          </div>
          <div className="setting">
            <span className="setLbl">Ask how practice felt</span>
            <button className="switch" onClick={() => setFeedbackOn((f) => !f)} aria-pressed={feedbackOn}>
              <span className={"track" + (feedbackOn ? " on" : "")}><span className="knob" /></span>
            </button>
          </div>
          <div className="setting">
            <span className="setLbl">Sound ratings — what's hard right now</span>
            <button className="hdrBtn" onClick={() => { setPlaying(false); setScreen("assess"); }}>Edit</button>
          </div>
          {HARD_MARKS && totalWords > 0 && (
            <div className="setting">
              <span className="setLbl">Suggested ratings from your hard words</span>
              <button className="hdrBtn" onClick={goRescore}>See</button>
            </div>
          )}
        </div>
        <SizeRow />
      </div>
    );
  }

  if (screen === "progress") {
    const now = new Date();
    const dow = now.getDay(); // 0 = Sunday
    const dayVals = [0, 1, 2, 3, 4, 5, 6].map((i) => {
      if (i > dow) return null;
      const d = new Date(now); d.setDate(now.getDate() - (dow - i));
      return hist[dkey(d)]?.w ?? 0;
    });
    const weekVals = [], weekLbls = [];
    for (let k = 11; k >= 0; k--) {
      const start = new Date(now); start.setDate(now.getDate() - dow - 7 * k);
      let sum = 0;
      for (let j = 0; j < 7; j++) { const d = new Date(start); d.setDate(start.getDate() + j); sum += hist[dkey(d)]?.w ?? 0; }
      weekVals.push(sum);
      weekLbls.push((start.getMonth() + 1) + "/" + start.getDate());
    }
    const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monVals = [], monLbls = [];
    for (let k = 11; k >= 0; k--) {
      const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      const prefix = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      let sum = 0;
      for (const [key, v] of Object.entries(hist)) if (key.startsWith(prefix)) sum += v.w || 0;
      monVals.push(sum);
      monLbls.push(MN[d.getMonth()]);
    }
    const charts = {
      d: { title: "This week", vals: dayVals, labels: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], hot: dow },
      w: { title: "Weekly totals", vals: weekVals, labels: weekLbls, hot: weekVals.length - 1 },
      m: { title: "Monthly totals", vals: monVals, labels: monLbls, hot: monVals.length - 1 },
    };
    const ch = charts[range];
    const niceMax = Math.ceil(Math.max(...ch.vals.filter((v) => v != null), 4) / 4) * 4;
    const fmt = (v) => (v >= 1000 ? Math.round(v / 100) / 10 + "k" : "" + v);
    let streak = 0;
    { const d = new Date(now);
      if (!((hist[todayKey]?.w ?? 0) > 0)) d.setDate(d.getDate() - 1); // today not practiced yet doesn't break the streak
      while ((hist[dkey(d)]?.w ?? 0) > 0) { streak++; d.setDate(d.getDate() - 1); } }
    const showInstall = (isIOS || isAndroid) && !isStandalone && !iosHintDismissed;
    const iosBlue = "#0A7AFF";
    const ShareIcon = () => (
      <svg className="instIcon" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
        <rect x="2" y="2" width="40" height="40" rx="10" fill={T.card} stroke={T.line} strokeWidth="1.5" />
        <rect x="13" y="18" width="18" height="16" rx="3" fill="none" stroke={iosBlue} strokeWidth="2.5" />
        <path d="M22 25V8" stroke={iosBlue} strokeWidth="2.5" strokeLinecap="round" />
        <path d="M16.5 13L22 7.5 27.5 13" fill="none" stroke={iosBlue} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
    const AddIcon = () => (
      <svg className="instIcon" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
        <rect x="2" y="2" width="40" height="40" rx="10" fill={T.card} stroke={T.line} strokeWidth="1.5" />
        <rect x="11" y="11" width="22" height="22" rx="6" fill="none" stroke={T.ink} strokeWidth="2.5" />
        <path d="M22 16.5v11M16.5 22h11" stroke={T.ink} strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    );
    const AppIcon = () => (
      <svg className="instIcon" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
        <rect x="2" y="2" width="40" height="40" rx="10" fill="#012169" />
        <text x="22" y="28" textAnchor="middle" fontFamily="Helvetica, Arial, sans-serif" fontWeight="bold" fontSize="15">
          <tspan fill="#FFFDF6">T</tspan><tspan fill="#E9B44C">&amp;</tspan><tspan fill="#FFFDF6">G</tspan>
        </text>
      </svg>
    );
    const MenuIcon = () => (
      <svg className="instIcon" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
        <rect x="2" y="2" width="40" height="40" rx="10" fill={T.card} stroke={T.line} strokeWidth="1.5" />
        <circle cx="22" cy="12.5" r="2.6" fill={T.ink} /><circle cx="22" cy="22" r="2.6" fill={T.ink} /><circle cx="22" cy="31.5" r="2.6" fill={T.ink} />
      </svg>
    );
    return (
      <div className="app">
        <style>{css}</style>
        <Header right={<><button className="hdrBtn" onClick={() => { if (mode === "pairs" ? setItems.length >= setSize : sessRef.current?.finished) startNewSet(); else setScreen("drill"); }}>Practice</button><button className="hdrBtn" onClick={() => setScreen("settings")}>Settings</button></>} />
        {showInstall && (
          <div className="card">
            <h2>Get the app on your phone</h2>
            <p className="sub" style={{ marginBottom: 10 }}>
              {isIOS
                ? <><b style={{ color: T.ink }}>On iPhone it will ONLY install from Safari</b> — Chrome or a link inside Messages/Mail makes just a bookmark. Open this page in Safari, then:</>
                : "Open this page in Chrome, then:"}
            </p>
            <div className="instSteps">
              {isIOS ? (
                <>
                  <div className="instStep"><ShareIcon /><div className="hintTxt"><b>1.</b> In <b>Safari</b>, tap the <b>Share</b> button — the square with the up arrow, bottom of the screen</div></div>
                  <div className="instStep"><AddIcon /><div className="hintTxt"><b>2.</b> Scroll down the list and tap <b>Add to Home Screen</b></div></div>
                  <div className="instStep"><AppIcon /><div className="hintTxt"><b>3.</b> Tap <b>Add</b>, then open <b>Tongue &amp; Groove</b> from your home screen — it opens full screen and works with no internet</div></div>
                </>
              ) : (
                <>
                  <div className="instStep"><MenuIcon /><div className="hintTxt"><b>1.</b> In <b>Chrome</b>, tap the <b>⋮ menu</b> in the top corner</div></div>
                  <div className="instStep"><AddIcon /><div className="hintTxt"><b>2.</b> Tap <b>Add to Home screen</b> (or <b>Install app</b>)</div></div>
                  <div className="instStep"><AppIcon /><div className="hintTxt"><b>3.</b> Open <b>Tongue &amp; Groove</b> from your home screen — full screen, works offline</div></div>
                </>
              )}
            </div>
            {isIOS && (
              <p className="sub" style={{ margin: "12px 0 0" }}>Opens like a webpage instead of an app? The icon was made outside Safari (Chrome, or a link inside Messages/Mail). Delete the icon and redo the steps above in Safari.</p>
            )}
            <button className="cta" style={{ width: "100%", margin: "16px 0 0" }} onClick={() => setIosHintDismissed(true)}>Got it — hide these steps</button>
          </div>
        )}
        <div className="tiles">
          <div className="tile" style={{ flex: 1.9 }}>
            <div className="tileLbl">Today</div>
            <div className="ringsRow">
              <svg viewBox="0 0 140 140" aria-hidden="true" className="ringsSvg">
                <Ring r={58} sw={13} frac={todayWords / GOALS.words} color={T.blue} />
                <Ring r={43} sw={13} frac={todayPairs / GOALS.pairs} color={T.amber} />
                <Ring r={28} sw={13} frac={todaySets / GOALS.sets} color={T.rust} />
              </svg>
              <div className="bigLeg">
                <div><div className="bigLegName">Target words</div><div className="bigLegVal" style={{ color: T.blue }}>{todayWords.toLocaleString()}</div></div>
                <div><div className="bigLegName">Sound pairs</div><div className="bigLegVal" style={{ color: dark ? T.amber : "#8A6414" }}>{todayPairs.toLocaleString()}</div></div>
                <div><div className="bigLegName">Sets</div><div className="bigLegVal" style={{ color: T.rust }}>{todaySets.toLocaleString()}</div></div>
              </div>
            </div>
            {todayWords > GOALS.words ? (
              <p className="sub" style={{ margin: "10px 0 0", fontSize: "14px", fontWeight: 700, color: dark ? T.amber : "#8A6414" }}>Daily goal beaten — the gold lap shows target words past {GOALS.words.toLocaleString()}.</p>
            ) : (
              <p className="sub" style={{ margin: "10px 0 0", fontSize: "13px" }}>Sound pairs count as 2 words.</p>
            )}
          </div>
          <div className="tile" style={{ display: "flex", flexDirection: "column" }}>
            <div className="tileLbl">Streak</div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 8 }}>
              <div className="streakNum" style={{ color: T.blue, fontSize: "calc(54px * " + fontScale + ")" }}>{streak}</div>
              <div className="streakLbl">days in a row</div>
            </div>
          </div>
          <div className="tile" style={{ display: "flex", flexDirection: "column" }}>
            <div className="tileLbl">Daily record</div>
            <div className="legend" style={{ flex: 1, justifyContent: "center" }}>
              {(() => {
                const best = Object.values(hist).reduce((b, d) => ({
                  w: Math.max(b.w, d.w || 0), p: Math.max(b.p, d.p || 0), s: Math.max(b.s, d.s || 0),
                }), { w: 0, p: 0, s: 0 });
                return [["Target words", best.w, T.blue], ["Pairs", best.p, dark ? T.amber : "#8A6414"], ["Sets", best.s, T.rust]].map(([lbl, v, col]) => (
                  <div key={lbl}><div className="legLbl">{lbl}</div><div className="legVal" style={{ color: col }}>{v.toLocaleString()}</div></div>
                ));
              })()}
            </div>
          </div>
        </div>
        <div className="card">
          <div className="rangeBar">
            {[["d", "Day"], ["w", "Week"], ["m", "Month"]].map(([k, l]) => (
              <button key={k} className={"rangeBtn" + (range === k ? " on" : "")} onClick={() => setRange(k)}>{l}</button>
            ))}
          </div>
          <h2 style={{ marginTop: 16 }}>{ch.title}</h2>
          <div className="chartWrap">
            {[1, 2, 3, 4].map((g) => (
              <span className="gLbl" key={g} style={{ bottom: "calc(22px + (100% - 22px) * " + g / 4 + ")" }}>{fmt(niceMax * g / 4)}</span>
            ))}
            <div className="chartScroll" ref={chartScrollRef}>
              <div className="chartInner" style={{ width: Math.max(ch.vals.length * 48, 0) + "px" }}>
                {[1, 2, 3, 4].map((g) => (
                  <div className="gLine" key={g} style={{ bottom: "calc(22px + (100% - 22px) * " + g / 4 + ")" }} />
                ))}
                <div className="gLine" style={{ bottom: 22 }} />
                <div className="chartArea">
                  {ch.vals.map((v, i) => (
                    <div className="col" key={i}>
                      <div className="barBox">{v != null && <div className={"bar" + (i === ch.hot ? " today" : "")} style={{ height: Math.max((v / niceMax) * 100, 1.5) + "%" }} />}</div>
                      <div className="dayLbl" style={i === ch.hot ? { fontWeight: 700, color: T.blue } : null}>{ch.labels[i]}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
        <SizeRow />
      </div>
    );
  }

  return (
    <div className="app">
      <style>{css}</style>
      <Header right={<><button className="hdrBtn" onClick={() => { setPlaying(false); setScreen("progress"); }}>Progress</button><button className="hdrBtn" onClick={() => { setPlaying(false); setScreen("settings"); }}>Settings</button></>} />
      <div className="tabs">
        <button className={"tab" + (mode === "practice" ? " on" : "")} onClick={() => switchMode("practice")}>Word Work</button>
        <button className={"tab" + (mode === "pairs" ? " on" : "")} onClick={() => switchMode("pairs")}>Sound pairs</button>
        <button className={"tab" + (mode === "scen" ? " on" : "")}
          onClick={() => {
            if (mode === "scen") { setPlaying(false); setScenario(null); setItem(null); itemRef.current = null; sessRef.current = null; setSess(null); } // tap again → back to the chooser
            else switchMode("scen");
          }}>Scenarios</button>
      </div>
      {mode === "scen" && scenario && (
        <div style={{ textAlign: "center", margin: "6px 16px 0" }}>
          <button className="ghost" style={{ padding: "8px 16px" }}
            onClick={() => { setPlaying(false); setScenario(null); setItem(null); itemRef.current = null; sessRef.current = null; setSess(null); }}>
            {SCENARIOS.find((s) => s.id === scenario)?.name} — change
          </button>
        </div>
      )}
      <div className="stage">
        {mode === "scen" && !scenario && (
          <div style={{ textAlign: "center" }}>
            <div className="idle" style={{ margin: "0 auto 16px" }}>Pick a situation — practice the words you actually need there.</div>
            <div className="wordGrid" style={{ justifyContent: "center" }}>
              {SCENARIOS.map((s) => (
                <button key={s.id} className="wchip" onClick={() => setScenario(s.id)}>
                  {s.name}{!SCEN_READY[s.id] && <span style={{ display: "block", fontSize: S(12), color: T.mut, fontWeight: 700 }}>In progress</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        {!item && !sess && !(mode === "scen" && !scenario) && (
          <div className="idle">
            {mode === "pairs"
              ? (paced
                ? "Press Start. Pairs appear one at a time — say both words out loud before the next arrives."
                : "Tap Next to begin. Say both words out loud, then tap Next when you're ready.")
              : "Tap Next to begin. A short warm-up of single words, then each word inside sentences that build from easy to a real workout. Everything out loud."}
          </div>
        )}
        {sess?.brk && (sess.plan[sess.idx + 1]?.stage === "bonus" ? (
          // §10: Bonus Round is optional — Finish and Bonus Round are equal
          // choices, and the session counts as complete either way.
          <div style={{ textAlign: "center", width: "100%", maxWidth: 420 }}>
            <div className="awardWrap"><Badge size={72} color={T.blue} ring={T.amber} star="#fff" /></div>
            <h2 style={{ margin: "12px 0 4px" }}>{stageInfo(sess).name} done!</h2>
            <p className="idle" style={{ margin: "0 auto 18px" }}>Up for a Bonus Round? Six real-life sentences, one from each situation. The session is complete either way.</p>
            <button className="cta" style={{ width: "100%", margin: "0 0 10px" }} onClick={() => resumeEntry(false)}>Bonus Round</button>
            <button className="cta" style={{ width: "100%", margin: "0 0 10px" }} onClick={() => updSess({ brk: false, finished: true })}>Finish</button>
            <button className="ghost" style={{ display: "block", width: "100%" }} onClick={() => resumeEntry(true)}>Redo that set</button>
          </div>
        ) : (
          <div style={{ textAlign: "center", width: "100%", maxWidth: 420 }}>
            <div className="awardWrap"><Badge size={72} color={T.blue} ring={T.amber} star="#fff" /></div>
            <h2 style={{ margin: "12px 0 4px" }}>{stageInfo(sess).name} done!</h2>
            {/* Difficulty check-in on the first warm-up break (CB 2026-08-05:
                ask right after the first words), once a day — it lands before
                the three sentence sets so the answer can shift their rung. */}
            {sess.idx === 0 && sess.plan[0].stage === "warmup" && warmAsk ? (
              <div style={{ margin: "0 0 14px" }}>
                <p className="idle" style={{ margin: "0 auto 10px" }}>How was that?</p>
                {warmAnswer ? (
                  <>
                    <p className="idle" style={{ margin: "0 auto 10px" }}>{DIFF_ACK[warmAnswer]}</p>
                    {warmAnswer === "vhard" && paced && (
                      <button className="condBtn" style={{ margin: "0 0 4px" }}
                        onClick={() => setWpm((w) => Math.max(10, w - 5))}>Slow the pace to {Math.max(10, wpm - 5)} WPM</button>
                    )}
                  </>
                ) : (
                  DIFF_LEVELS.map((l) => (
                    <button key={l.id} className="condBtn" style={{ margin: "3px 0", textAlign: "center" }}
                      onClick={() => answerDiff(l.id, "warmup")}>{l.label}</button>
                  ))
                )}
              </div>
            ) : (
              <p className="idle" style={{ margin: "0 auto 18px" }}>Take a short breather — 20 or 30 seconds is perfect.</p>
            )}
            <button className="cta" style={{ width: "100%", margin: "0 0 10px" }} onClick={() => resumeEntry(false)}>Continue</button>
            <button className="ghost" style={{ display: "block", width: "100%" }} onClick={() => resumeEntry(true)}>Redo that set</button>
          </div>
        ))}
        {item && !sess?.brk && item.kind === "word" && <div className="word" style={{ fontSize: wordFont(item.w) }}>{item.w}</div>}
        {item && !sess?.brk && item.kind === "couple" && item.beat === 1 && (
          <>
            <div className="word" style={{ fontSize: wordFont(item.w) }}>{item.w}</div>
            {item.hint && <div className="coupleHint">say it — its sentence comes next</div>}
          </>
        )}
        {item && !sess?.brk && (item.kind === "bonus" || (item.kind === "couple" && item.beat === 2)) && (
          <div className="sentWrap" style={{ fontSize: sentFont(item.sentence) }}>
            {(() => {
              // §5: exactly one highlighted word — the couple's target (or the
              // session word a bonus sentence carries), first occurrence only.
              const toks = item.sentence.split(" ");
              const hi = item.w ? toks.findIndex((t) => cleanToken(t) === item.w) : -1;
              return toks.map((t, i) => (
                <span key={i} className={"sw" + (i === hi ? " tgt" : "")}>{t}</span>
              ));
            })()}
          </div>
        )}
        {item && mode === "pairs" && item.pair && (
          <div className="pairWrap">
            <div className="word" style={{ fontSize: wordFont(item.pair[0]) }}>{item.pair[0]}</div>
            <div className="pair2" style={{ fontSize: wordFont(item.pair[1]) }}>{item.pair[1]}</div>
          </div>
        )}
      </div>
      <div className="setBar"><div className="setFill" style={{
        width: (mode === "pairs"
          ? Math.min((setItems.length / setSize) * 100, 100)
          : sess ? Math.min((sess.count / sess.plan[sess.idx].n) * 100, 100) : 0) + "%" }} /></div>
      <div className="controls" style={sess?.brk ? { visibility: "hidden" } : null}>
        <div className="paceRow">
          <button className="switch" onClick={togglePaced} aria-pressed={paced}>
            <span className={"track" + (paced ? " on" : "")}><span className="knob" /></span>
            <span className="swLbl">Auto pace</span>
          </button>
          {paced && (
            <>
              <span className="paceVal">{wpm} wpm</span>
              <button className="switch" onClick={() => {
                const on = !tickOn;
                setTickOn(on);
                if (on) { ensureAudio(); setTimeout(playTick, 120); } // audible confirmation
              }} aria-pressed={tickOn} aria-label="Pacing tick sound">
                <span className={"track" + (tickOn ? " on" : "")}><span className="knob" /></span>
                <span className="swLbl">Tick</span>
              </button>
              {/* The slider gets a full row to itself with big steppers either
                  side — a thumb you can hit and a value you can read without
                  reading glasses (CB 2026-08-19: these are elderly patients). */}
              <div className="paceWrap">
                <button className="paceStep" onClick={() => setWpm((w) => Math.max(10, w - 5))} aria-label="Slower pace">−</button>
                <input type="range" min="10" max="150" step="5" value={wpm} aria-label="Words per minute"
                  onChange={(e) => setWpm(parseInt(e.target.value))} />
                <button className="paceStep" onClick={() => setWpm((w) => Math.min(150, w + 5))} aria-label="Faster pace">+</button>
              </div>
            </>
          )}
        </div>
        <div className="btnRow">
          {/* Back steps to the previous item without un-banking any progress —
              available in the sentence sets and everywhere else (CB
              2026-08-19). It pauses auto-pace so nothing moves under you. */}
          <button className="ghost" onClick={goBack} disabled={viewPos <= 0} aria-label="Back to the previous item">Back</button>
          {paced ? (
            <>
              <button className={"play" + (playing ? " stop" : "")} onClick={() => { if (mode === "scen" && !scenario) return; if (tickOn) ensureAudio(); setPlaying(!playing); }}>
                {playing ? "Pause" : "Start"}
              </button>
              <button className="ghost" onClick={next}>Next</button>
            </>
          ) : (
            <button className="play" style={{ flex: 2 }} onClick={next}>
              {item ? "Next" : "Start"}
            </button>
          )}
        </div>
        <div className="meta">
          {mode === "pairs"
            ? `${setItems.length} of ${setSize} this set · ${todayWords} today`
            : sess && !sess.finished
              ? <>{stageInfo(sess).name} · {Math.min(sess.count, sess.plan[sess.idx].n)} of {sess.plan[sess.idx].n} · {todayWords} today · <button className="linkBtn" onClick={skipStage}>skip ahead</button></>
              : `Warm-up, then sentences · ${todayWords} today`}
        </div>
      </div>
      <SizeRow />
    </div>
  );
}
