// Daily-use probability of a sentence — "would this patient actually say this,
// to another person, in ordinary life?" Stored as SENT_META.p (1-5) and used to
// weight sentence selection, so practice leans on language that transfers.
//
// Why it exists (CB 2026-08-20): the scenario banks were audited and sound
// density turned out to run INVERSE to real-world usefulness. Share of
// sentences that are a request or a question — the clearest marker that the
// patient is the one speaking, and the least judgment-dependent signal we have:
//   rung 1: 39%   rung 2: 21%   rung 3: 2%  (one sentence out of 65)
// The third sentence set — the hardest, most valuable workout — was almost
// entirely third-person narrative ("The nurse placed my arm in a blue sling"),
// because those sentences were written to hit a sound target, not to be said.
//
// This is a TRIAGE tool, not clinical judgment. It reliably separates real
// utterances from drill text; it is weakest on elliptical requests and on
// statements about one's own life that carry no first-person pronoun ("The
// grandchildren are visiting this weekend"), which it under-rates. Curated
// overrides below win over the computed score — put a sentence there rather
// than bending a rule to fit it.

const RE = {
  // The patient asks another person for something.
  request: /^(can|could|may|would|will)\s+(i|we|you)\b|^(i'd like|i would like|i need|i'll have|i'll take|i want|i'm looking for)\b|^please\s+\w+|,\s*please\.?$/i,
  question: /\?\s*$/,
  ritual: /^(thank you|thanks|hello|hi\b|congratulations|welcome|happy birthday|good morning|good afternoon|excuse me|sorry|nice to)/i,
  // The patient reports on themselves. After requests and questions this is the
  // third thing patients actually do with speech — "I still get dizzy when I
  // stand up", "My symptoms started three weeks ago" — and scoring it as
  // ordinary narrative was wrong.
  selfReport: /^(i|i'd|i'll|i'm|i've|my|we|we'd|we'll|we're|we've|our)\b/i,
  // The speaker is present in the sentence at all.
  speaker: /\b(i|i'd|i'll|i'm|i've|me|my|mine|we|we'd|we'll|we're|we've|our|us)\b/i,
  // Opens on a thing rather than a person: the shape of written-about-you text.
  narrative: /^(the|a|an|that|this|these|those|his|her|their|everything|everyone)\b/i,
  // Imperatives aimed at objects — drill text's most reliable tell.
  objectCommand: /^(please\s+)?(place|stack|scrape|spread|screw|clip|skip|sweep|slide|plant|press|squeeze|stop by|swallow|breathe|describe|bring the|keep it|scrub|strap)\b/i,
};

// Sentences the rules get wrong, and the score they should carry. Elliptical
// requests and own-life reports the regexes can't see.
const OVERRIDE = {
  "A pound of turkey from the deli, please.": 5,
  "The grandchildren are visiting this weekend.": 4,
  "The whole family is coming for Thanksgiving.": 4,
  "The neighbors brought dinner over last night.": 3.5,
  "The kids grow up so fast, don't they?": 4,
  "That food was terrible.": 2.5,
  "The office is closed for the holiday.": 3,
  "The checkout line is shorter over there.": 3,
};

export function utilityScore(s) {
  if (OVERRIDE[s] != null) return OVERRIDE[s];
  const t = s.trim();
  let p = 3;
  // Is the patient audibly doing something to another person?
  const engaged = RE.request.test(t) || RE.question.test(t) || RE.ritual.test(t);
  if (RE.request.test(t)) p += 1.5;
  else if (RE.question.test(t)) p += 1.2;
  else if (RE.ritual.test(t)) p += 1.0;
  else if (RE.selfReport.test(t)) p += 0.8;
  // "No speaker in the sentence" only condemns it when nothing else marks it as
  // speech. "Could you please pass the plates?" names no I or my and is still a
  // textbook patient utterance — the request form already identifies who's
  // talking to whom.
  if (RE.speaker.test(t)) p += 0.5;
  else if (!engaged) p -= 1.2;
  if (RE.narrative.test(t) && !RE.question.test(t) && !RE.request.test(t)) p -= 1.3;
  if (RE.objectCommand.test(t)) p -= 1.5;
  return Math.max(1, Math.min(5, Math.round(p * 2) / 2));
}
