#!/usr/bin/env python3
"""Generate the Tongue & Groove word library from wordfreq.

v3 (2026-08-04, Correction Spec v2): two-gate filter + difficulty tiers.

Gate 1 — category membership: word must contain a cluster from one of the six
         target categories (th / tri / lb / rb / sb / fc).
Gate 2 — automaticity guard: words in the top-500 frequency band are rejected
         unless they have 3+ syllables, 2+ qualifying clusters, or a
         3-consonant cluster (removes best/most/world/first/next/last).
Gate 3 — no single-syllable words, period (CB 2026-08-04: "we are not going
         for easy even if common — it's not what trips people up"). Kills
         street/bring/think/friend/free/great regardless of clusters.

Every surviving word is scored 1-5 (syllables + clusters + position - frequency)
and TIER 1 WORDS ARE DELETED. The usable pool is tiers 2-5.

Cluster counting is phonetic-ish: doubled letters (ss/ll) and single-sound
digraphs (sh/ch/ck/ght...) don't count; a post-vocalic r is treated as vowel
coloring, not a cluster member (so "world" = ld, "first" = st — automatic
words the guard then removes — while "wrists" keeps its true sts cluster).

Outputs:
  src/words.gen.js  — WORDS_BY_CAT (tiers 2-5, per category), WORD_META
                      ({tier, syllables, cats, score} per word), WORDS_PS
  vocab-audit.md    — full audit: counts, tiers, every deletion with reason

Run: python3 scripts/build_words.py
"""
import json
import re
from wordfreq import top_n_list

TOP_N = 1500       # 1,500 confirmed (CB 2026-08-05) — a 1,000 cut opens content
                   # gaps: TH drops 20→10, S-blends 23→13
DEEP_N = 6000      # ranks 1,500-6,000: admitted ONLY if they score tier 4-5
                   # (the top-1,500 universe is short-word-heavy — without this
                   # the tier-5 pool is 2 words and the 6/9/9/6 warm-up spread
                   # is impossible; same idea as the old SLP additions)
                   # Raised 3,000 → 6,000 on 2026-08-25. At 3,000 the pool held
                   # 276 words and the categories the injury presets rate
                   # HIGHEST were the starved ones: 3-consonant clusters 16
                   # words (stroke and TBI both rate it 5), TH 20, S-blends 23,
                   # against R-blends 107 and final clusters 132. Worse at tier
                   # level — clusters had ONE tier-2 word, and TH had no tier-5
                   # word at all. A stroke patient was cycling the same 16
                   # words. 6,000 roughly triples the thin categories and the
                   # words it adds are still everyday (chemistry, struggling,
                   # stranger, grandmother, athletes). 10,000 was measured too
                   # and drifts academic — algorithm, synthesis, manuscript —
                   # so 6,000 is the edge of "words a patient would say".
GUARD_RANK = 500   # automaticity guard applies below this filtered rank
BAND_RANK = 1000   # top-1,000 band costs 1 difficulty point

STOP = {
    "could", "would", "should", "walk", "talk", "talked", "talking", "walking",
    "folk", "folks", "chalk", "yolk", "half", "who", "whose", "whom", "whole",
    "answer", "island", "listen", "often", "castle", "christmas", "wednesday",
    "climbed", "comb", "thumb", "dumb", "lamb", "limb", "debt", "doubt",
    "receipt", "iron", "colonel", "sword", "know", "known", "knows", "knew",
    # proper nouns / artifacts in the frequency list
    "thomas", "smith", "elizabeth", "australia", "africa", "france", "thats",
    "trump", "april", "february", "friday", "thursday", "saturday",
    # web-corpus junk: URLs, acronyms, abbreviations (not real spoken words)
    "http", "https", "www", "com", "org", "net", "gov", "html", "pdf",
    "nfl", "nba", "nhl", "mlb", "bbc", "cnn", "fbi", "cia", "ltd", "inc",
    "mrs", "etc", "usa", "dvd", "gps", "app", "apps", "online", "url",
    # more proper nouns: people, places, brands, months, days
    "christ", "jesus", "christian", "christians", "catholic", "bible",
    "muslim", "jewish", "islam", "israel", "england", "ireland", "scotland",
    "wales", "london", "florida", "francisco", "california", "texas",
    "virginia", "washington", "boston", "chicago", "manchester", "germany",
    "german", "russia", "russian", "china", "chinese", "japan", "japanese",
    "europe", "india", "canada", "mexico", "andrew", "david", "michael",
    "john", "james", "george", "robert", "william", "richard", "facebook",
    "google", "twitter", "youtube", "instagram", "iphone", "microsoft",
    "australian", "centre", "monday", "tuesday", "sunday", "january", "june",
    "july", "august", "september", "october", "november", "december",
    # surfaced by the 6,000 band (2026-08-25) — people, places, brands
    "anthony", "franklin", "massachusetts", "netherlands", "queensland",
    "richmond", "switzerland", "thompson", "armstrong", "springfield",
    "starbucks", "stockholm", "southampton", "matthews", "northwestern",
}

# Words a 65+ stroke or TBI patient actually uses, admitted regardless of
# frequency rank or difficulty tier (CB 2026-08-25: "over-weight ones a stroke
# or TBI patient would use, eg doctor, and for stroke let's assume they are
# 65+, so things like granddaughter grandson").
#
# They still have to pass Gate 1 — a word with none of the six target sounds
# can never be a warm-up word, and no list can change that. "doctor",
# "hospital", "medicine", "daughter", "kitchen", "insurance", "family" and
# "pension" all carry none of them; they live in the SENTENCES instead.
#
# What this list is for is the other two gates. "granddaughter" (rank 12,983)
# and "grandson" (8,937) carry an R-blend but sit far past the frequency cut;
# "therapy" (2,923) and "breakfast" (2,425) are inside it but were being thrown
# out by the deep band's tier-4/5 rule. Both are the wrong reason to lose a
# word this population says every week.
LIFE_WORDS = {
    # family
    "granddaughter", "grandson", "grandchildren", "grandparents", "birthday",
    # health and therapy
    "therapy", "therapist", "prescription", "dentist", "swallow", "swallowing",
    "breathing", "stretching", "strengthen", "stiffness", "stitches",
    "thankful", "steady", "stumble",
    # home and daily routine
    "breakfast", "groceries", "grocery", "glasses", "blanket", "blankets",
    "bathroom", "restroom", "upstairs", "downstairs", "laundry", "dressing",
    "cleaning", "cleaner", "drawer", "freezer", "sweater", "slippers",
    "toothbrush", "clothing", "supper", "strawberries",
    # out and about
    "neighbors", "crossing", "celebrate", "flowers", "crutches", "travel",
    "driveway", "spelling", "crossword",
}
# The thin categories are thin for a reason — three-consonant clusters live
# mostly in Latinate institutional words (administration, distribution,
# infrastructure), which is exactly the register this population doesn't speak.
# So the words above deliberately over-supply tri/sb/th with domestic
# vocabulary: restroom, upstairs, downstairs, strawberries, stiffness,
# toothbrush, supper. Without them a stroke patient's most-practised word is
# "throughout".

# Correction Spec v2 §1A: function words / articles / pronouns / prepositions /
# auxiliaries never enter the pool, even when they carry a TH or a cluster
# (the, that, with, think-nots like "this"...). Content verbs like "think"
# and "through" stay — they're drillable.
FUNCTION_WORDS = {
    "the", "and", "that", "this", "these", "those", "there", "their", "theirs",
    "them", "they", "then", "than", "thus", "though", "although", "with",
    "within", "without", "whether", "either", "neither", "another", "other",
    "others", "both", "was", "were", "are", "been", "being", "does", "did",
    "done", "has", "had", "have", "having", "will", "would", "can", "cannot",
    "must", "might", "may", "shall", "she", "her", "hers", "him", "his", "its",
    "our", "ours", "your", "yours", "you", "not", "nor", "but", "for", "from",
    "into", "onto", "upon", "about", "above", "below", "under", "over",
    "between", "during", "before", "after", "against", "because", "since",
    "until", "while", "where", "when", "what", "which", "why", "how", "all",
    "any", "each", "few", "more", "most", "some", "such", "only", "own",
    "same", "just", "also", "very", "too", "again", "once", "here", "now",
    "still", "yet", "ever", "never", "always", "off", "out", "per", "via",
}

FC_EXCLUDE_END = re.compile(r"(gh|ght|ng|ck|ss|ll|ff|zz|mb|gn|wn|sh|ch|tch|dge|ce|ge|se|ze|ve|le|re|ue|ye|oe)$")
VOWEL_TH_END = re.compile(r"[aeiou]th$")

CATS = {
    "th":  lambda w: "th" in w,
    "tri": lambda w: re.search(r"(str|spr|scr|spl|squ|thr)", w) is not None,
    "lb":  lambda w: re.search(r"(bl|cl|fl|gl|pl|sl)", w) is not None
                     and re.search(r"(b|p|c|g|f|d|t|s)les?$", w) is None,
    "rb":  lambda w: re.search(r"(br|cr|dr|fr|gr|pr|tr)", w) is not None,
    "sb":  lambda w: re.match(r"s(t|p|c|k|m|n|w)", w) is not None,
    "fc":  lambda w: re.search(r"[bcdfgklmnprstvz]{2}$", w) is not None
                     and FC_EXCLUDE_END.search(w) is None
                     and VOWEL_TH_END.search(w) is None,
}

def syllables(w):
    groups = re.findall(r"[aeiouy]+", w)
    n = len(groups)
    if w.endswith("e") and not w.endswith(("le", "ee", "ie", "oe", "ye")) and n > 1:
        n -= 1
    return max(1, n)

CONS = "bcdfghjklmnpqrstvwxz"
VOWELS = set("aeiouy")
# letter runs that are one sound (or silent), never a motor cluster
SINGLE_SOUND_RUNS = {"sh", "ch", "ck", "ph", "wh", "gh", "gn", "kn", "wr",
                     "mb", "ght", "tch", "dg", "dge"}

def cluster_runs(w):
    """Maximal consonant runs, phonetically trimmed.
    Returns list of (run, start_index). A post-vocalic leading r is dropped
    (r-colored vowel: world→ld, first→st). Doubles and single-sound digraphs
    are dropped entirely."""
    out = []
    for m in re.finditer(rf"[{CONS}]{{2,}}", w):
        run, start = m.group(), m.start()
        if start > 0 and run[0] == "r" and w[start - 1] in VOWELS:
            run, start = run[1:], start + 1  # r-coloring, not a cluster member
        if len(run) < 2:
            continue
        if len(set(run)) == 1:              # doubled letter: ss, ll, tt...
            continue
        if run in SINGLE_SOUND_RUNS:
            continue
        out.append((run, start))
    # a bare "th" after a vowel isn't caught above when alone ("month" is nth);
    # standalone th ("thin", "bath") IS caught as a 2-run. Nothing extra needed.
    return out

def has_tri_cluster(runs):
    return any(len(r) >= 3 and r not in SINGLE_SOUND_RUNS for r, _ in runs)

def score_word(w, rank):
    """Correction Spec v2 §1C. Returns (score, tier)."""
    syl = syllables(w)
    runs = cluster_runs(w)
    qc = len(runs)
    s = {1: 0, 2: 1, 3: 2}.get(syl, 3)
    s += 1 if qc == 1 else 2 if qc == 2 else 3 if qc >= 3 else 0
    if has_tri_cluster(runs):
        s += 2
    if any(start > 0 for _, start in runs):   # medial or final cluster
        s += 1
    if rank < BAND_RANK:
        s -= 1
    tier = 1 if s <= 1 else 2 if s <= 3 else 3 if s <= 5 else 4 if s <= 7 else 5
    return s, tier

def guard_passes(w, rank):
    """Gate 2: top-500 words must earn their place."""
    if rank >= GUARD_RANK:
        return True
    runs = cluster_runs(w)
    return syllables(w) >= 3 or len(runs) >= 2 or has_tri_cluster(runs)

# place-of-articulation groups for the (hidden) switcher list
PLACE = {}
for ch in "pbmwfv": PLACE[ch] = "labial"
for ch in "tdsznlr": PLACE[ch] = "alveolar"
for ch in "kgcqx": PLACE[ch] = "velar"

def place_switches(w):
    seq = [PLACE[c] for c in w if c in PLACE]
    return sum(1 for a, b in zip(seq, seq[1:]) if a != b)

def is_place_switcher(w):
    return syllables(w) >= 3 and place_switches(w) >= 3


# --- life relevance (u, 1-5) -----------------------------------------------
# How likely this word is to come out of a 65+ stroke or TBI patient's mouth in
# an ordinary week. Frequency rank does NOT answer that: "administration" and
# "distribution" are common in a web corpus and rare in a living room, while
# "granddaughter" is the reverse. Stored as `u` in WORD_META and used to weight
# the warm-up draw, so the pool can be wide without the practice drifting into
# newspaper vocabulary.
#
# Matched on ROOTS, not whole words, so inflections come along for free
# ("grandchild/grandchildren", "treat/treatment/treatments").
LIFE_ROOTS = (
    # family and people close by
    "grand", "brother", "sister", "husband", "wife", "parent", "child",
    "friend", "neighbo", "birthday", "wedding", "famil",
    # health, therapy, the body
    "therap", "patient", "treat", "symptom", "prescri", "dentist", "medic",
    "breath", "swallow", "healthy", "appointment", "hospital", "nurse",
    "pressure", "strengthen", "stretch", "exercis", "recover",
    # home and daily routine
    "breakfast", "dinner", "kitchen", "bathroom", "bedroom", "blanket",
    "clean", "cook", "laundry", "grocer", "glasses", "drawer", "freezer",
    "cupboard", "curtain", "sweater", "slipper", "dressing", "garden",
    "flowers", "weather", "weekend", "morning", "evening", "restroom",
    "upstairs", "downstairs", "toothbrush", "clothing", "supper", "steady",
    "stiffness", "stitches", "strawberr", "thankful", "stumble", "crossword",
    "driveway", "spelling",
    # getting around and getting things done
    "walking", "driving", "travel", "crossing", "stairs", "crutch",
    "restaurant", "library", "shopping", "prices", "payment", "account",
    "telephone", "message", "address", "contact", "celebrate", "practice",
    # the words of asking for help
    "explain", "understand", "question", "complain", "appreciate", "grateful",
    "together", "remember", "trouble", "problem", "comfort", "please",
)
# The other end: real English, but words this population is unlikely to say out
# loud. Mostly politics, corporate process and academic abstraction — the exact
# register a web-frequency list over-supplies.
DISTANT_ROOTS = (
    "administr", "infrastructur", "legislat", "congress", "presiden",
    "republic", "democrat", "amendment", "constituen", "parliament",
    "propaganda", "discriminat", "immigrant", "terroris", "activis",
    "enforcement", "compliance", "implement", "procurement", "statistic",
    "distribut", "productivity", "integrat", "transformation", "sector",
    "corporat", "shareholder", "commodit", "municipal", "jurisdic",
    "sovereign", "ideolog", "empirical", "theoretical", "methodolog",
    "franchise", "gambling", "journalis", "gubernatorial", "gross",
)
ABSTRACT_END = re.compile(r"(ation|ations|ment|ments|ity|ities|ance|ence|ism|isms)$")


def life_relevance(w, rank):
    """1-5: how likely a 65+ patient is to use this word in ordinary life."""
    if any(r in w for r in LIFE_ROOTS):
        return 5
    if any(r in w for r in DISTANT_ROOTS):
        return 1
    # Abstract nominalisations that didn't earn a life root: "arrangement",
    # "expectations", "compliance". Real words, rarely spoken by this group.
    if ABSTRACT_END.search(w):
        return 2
    # No life root, but common enough to be ordinary speech rather than
    # newspaper vocabulary. Rank is a weak signal on its own — it is only
    # trusted here, after the two lists above have had their say.
    if rank < TOP_N:
        return 4
    return 3

PS_HAND_LIST = [
    "buttercup", "basketball", "cucumber", "helicopter", "calculator",
    "refrigerator", "thermometer", "caterpillar", "watermelon", "motorcycle",
    "supermarket", "gymnasium", "cinnamon", "aluminum", "spaghetti",
    "umbrella", "banana", "potato", "tomato", "pajamas", "magnificent",
    "comfortable", "particular", "temperature", "vegetable", "probably",
]

# ---------------------------------------------------------------------------

words = [w for w in top_n_list("en", DEEP_N * 2)
         if w.isalpha() and len(w) >= 3 and w not in STOP][:DEEP_N]

pool_before = []      # (word, rank, cats) — every Gate-1 member incl. function words
deleted = []          # (word, reason)
kept = []             # (word, rank, cats, score, tier)
deep_added = []       # rank 1,500-3,000 words admitted for tier 4-5 depth

for rank, w in enumerate(words):
    cats = [c for c, test in CATS.items() if test(w)]
    if not cats:
        continue      # never in the pool — Gate 1
    if rank >= TOP_N:
        # deep band: only multi-syllable tier-4/5 material earns a place
        s, tier = score_word(w, rank)
        if tier >= 4 and syllables(w) >= 2:
            kept.append((w, rank, cats, s, tier))
            deep_added.append(w)
        continue
    pool_before.append((w, rank, cats))
    if w in FUNCTION_WORDS:
        deleted.append((w, "function word"))
        continue
    if syllables(w) < 2:
        deleted.append((w, "single-syllable"))
        continue
    if not guard_passes(w, rank):
        deleted.append((w, "automaticity guard (top-500, no earn-back)"))
        continue
    s, tier = score_word(w, rank)
    if tier == 1:
        deleted.append((w, f"tier 1 (score {s})"))
        continue
    kept.append((w, rank, cats, s, tier))

# Life words that no frequency band would reach. Gate 1 still applies — a word
# with none of the six sounds is not admissible here or anywhere.
kept_set = {w for w, _, _, _, _ in kept}
life_added = []
deep_rank = {w: i for i, w in enumerate(top_n_list("en", 40000))}
for w in sorted(LIFE_WORDS):
    if w in kept_set or w in STOP or w in FUNCTION_WORDS:
        continue
    cats = [c for c, test in CATS.items() if test(w)]
    if not cats:
        deleted.append((w, "life word, but carries none of the six sounds"))
        continue
    if syllables(w) < 2:
        deleted.append((w, "life word, but single-syllable"))
        continue
    s, tier = score_word(w, deep_rank.get(w, DEEP_N))
    kept.append((w, deep_rank.get(w, DEEP_N), cats, s, max(tier, 2)))
    life_added.append(w)

by_cat = {c: [] for c in CATS}
for w, rank, cats, s, tier in kept:
    for c in cats:
        by_cat[c].append(w)
# order per category: tier ascending (easy first), then frequency
tier_of = {w: t for w, _, _, _, t in kept}
rank_of = {w: r for w, r, _, _, _ in kept}
for c in by_cat:
    by_cat[c].sort(key=lambda w: (tier_of[w], rank_of[w]))

meta = {w: {"t": tier, "y": syllables(w), "s": s, "c": cats,
            "u": life_relevance(w, rank)}
        for w, rank, cats, s, tier in kept}

ps = [w for w in words[:TOP_N] if is_place_switcher(w)]
ps += [w for w in PS_HAND_LIST if w not in ps]
ps.sort(key=lambda w: min(syllables(w), 4))

# --- audit -----------------------------------------------------------------
tier_counts = {t: 0 for t in (2, 3, 4, 5)}
for w, _, _, _, t in kept:
    tier_counts[t] += 1
gaps = [c for c in CATS if len(by_cat[c]) < 20]

lines = []
lines.append("# Vocab audit — Correction Spec v2 (generated by scripts/build_words.py)\n")
lines.append("Two gates: (1) contains a cluster from the six categories; "
             "(2) automaticity guard — top-500 words rejected unless 3+ syllables, "
             "2+ qualifying clusters, or a 3-consonant cluster. Survivors scored 1-5; "
             "tier 1 deleted. Ranks use the junk-filtered frequency list.\n")
lines.append("## Totals\n")
lines.append(f"| | words |\n|---|---|\n"
             f"| Pool before filtering (all Gate-1 category members in top-{TOP_N:,}) | {len(pool_before)} |\n"
             f"| Deleted | {len(deleted)} |\n"
             f"| Tier-4/5 depth additions from ranks {TOP_N:,}-{DEEP_N:,} | {len(deep_added)} |\n"
             f"| **Pool after filtering (tiers 2-5)** | **{len(kept)}** |\n")
lines.append(f"### Depth additions (ranks {TOP_N:,}-{DEEP_N:,}, admitted only when scoring tier 4-5)\n")
lines.append(", ".join(deep_added) + "\n")
lines.append("## Count per category (a word can belong to several)\n")
lines.append("| Category | words | gap? |\n|---|---|---|")
CAT_NAMES = {"th": "TH sounds", "tri": "3-consonant clusters", "lb": "L-blends",
             "rb": "R-blends", "sb": "S-blends", "fc": "Final/mid clusters"}
for c in CATS:
    lines.append(f"| {CAT_NAMES[c]} | {len(by_cat[c])} | "
                 f"{'**CONTENT GAP — under 20**' if c in gaps else ''} |")
lines.append("")
lines.append("## Count per difficulty tier\n")
lines.append("| Tier | words |\n|---|---|")
for t in (2, 3, 4, 5):
    lines.append(f"| {t} | {tier_counts[t]} |")
lines.append("")
lines.append(f"## Deleted words — {len(deleted)}, with reason\n")
lines.append("| Word | Reason |\n|---|---|")
for w, reason in deleted:
    lines.append(f"| {w} | {reason} |")
lines.append("")
if gaps:
    lines.append("## Content gaps flagged\n")
    for c in gaps:
        lines.append(f"- **{CAT_NAMES[c]}**: only {len(by_cat[c])} qualifying words (< 20)")
    lines.append("")

with open("vocab-audit.md", "w") as f:
    f.write("\n".join(lines))

# --- console table ---------------------------------------------------------
print(f"pool before (Gate-1 members, top-{TOP_N}): {len(pool_before)}")
print(f"deleted: {len(deleted)}  ->  kept (tiers 2-5): {len(kept)}")
print("per category:", {c: len(v) for c, v in by_cat.items()})
print("per tier:", tier_counts)
reasons = {}
for _, r in deleted:
    key = r.split(" (")[0]
    reasons[key] = reasons.get(key, 0) + 1
print("deletions by reason:", reasons)
if gaps:
    print("CONTENT GAPS (<20 words):", [CAT_NAMES[c] for c in gaps])
spot = ["best", "most", "world", "first", "next", "last", "the", "that", "with",
        "think", "then", "street", "bring", "friend", "friends", "front", "trying",
        "great", "free", "group", "true", "price", "work", "years", "part", "find",
        "help", "old", "end", "want"]
print("spot-check:", {w: ("KEPT t" + str(meta[w]["t"]) if w in meta else "gone") for w in spot})
print("place-switchers (hidden, unused in warm-up):", len(ps))

with open("src/words.gen.js", "w") as f:
    f.write("// GENERATED by scripts/build_words.py — do not edit by hand.\n")
    f.write("// Pool = two-gate filter (category membership + automaticity guard),\n")
    f.write("// tier 1 deleted. Per-category lists ordered tier-asc, then frequency.\n")
    f.write("// WORD_META: { t: tier 2-5, y: syllables, s: raw score, c: categories,\n")
    f.write("//   u: life relevance 1-5 for a 65+ stroke/TBI patient — see life_relevance() }\n")
    f.write("export const WORDS_BY_CAT = " + json.dumps(by_cat, separators=(",", ":")) + ";\n")
    f.write("export const WORD_META = " + json.dumps(meta, separators=(",", ":")) + ";\n")
    f.write("export const WORDS_PS = " + json.dumps(ps, separators=(",", ":")) + ";\n")
print("wrote src/words.gen.js + vocab-audit.md")
