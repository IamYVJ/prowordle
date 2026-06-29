// Optimal-play suggester (Web Worker).
//
// Runs the heavy candidate-filtering + scoring off the main thread so the UI never
// janks. It is SOLUTION-BLIND: it only receives the feedback patterns the player has
// already seen (computed on the main thread), never the secret word itself.
//
// Message in:  { length, guesses|null, answers, observed:[{guess,pattern}],
//                pool:'answers'|'full', topN, smallThreshold, triesLeft }
// Message out: { remaining, strategy, suggestions:[{word, score, isAnswer}] }
//
//   strategy 'info-gain'   -> score = expected information gain in bits (higher = better)
//   strategy 'most-likely' -> score = normalized commonness rank (1 = most common)

// Feedback scoring is the canonical computePattern from pattern.js — the SAME function the
// board (revealRow) and the post-game analysis use, so the solver can never drift from what
// the player actually sees. importScripts runs synchronously, before any code below.
importScripts('pattern.js');
const computePattern = self.WordlePattern.computePattern;

// Evenly-spaced subsample of at most `cap` items (deterministic, no RNG). Used to bound
// the entropy search when the candidate/probe pool is very large (e.g. Hard mode's
// full-dictionary pool). Pools at or under the cap are returned as-is (scored exactly).
function subsample(arr, cap) {
    if (arr.length <= cap) return arr;
    const out = [];
    const step = arr.length / cap;
    for (let i = 0; i < arr.length; i += step) out.push(arr[Math.floor(i)]);
    return out;
}

self.onmessage = (e) => {
    const { guesses, answers, observed, pool, topN, smallThreshold, triesLeft } = e.data;

    // Candidates = possible answers consistent with every clue seen so far.
    const candidates = answers.filter(a =>
        observed.every(o => computePattern(o.guess, a) === o.pattern)
    );
    const remaining = candidates.length;

    if (remaining === 0) {
        self.postMessage({ remaining: 0, strategy: 'none', suggestions: [] });
        return;
    }

    // Hybrid strategy: when the field is tiny or it's the last guess, just take the
    // most common still-possible answer (best shot at winning now). Otherwise maximize
    // information gain to collapse the field fastest.
    if (remaining <= smallThreshold || triesLeft <= 1) {
        const suggestions = candidates.slice(0, topN).map((w, i) => ({
            word: w,
            score: (remaining - i) / remaining, // 1 = most common of those remaining
            isAnswer: true,
        }));
        self.postMessage({ remaining, strategy: 'most-likely', suggestions });
        return;
    }

    const candidateSet = new Set(candidates);
    const LOG2 = Math.log(2);

    // Bound the entropy search. probes x candidates pattern computations can balloon into
    // the hundreds of millions on a large pool (Hard mode's full dictionary), so cap both
    // sides with an evenly-spaced subsample. Entropy over a representative sample closely
    // approximates the full result while keeping the worker responsive. The common
    // Easy/Medium answer pools (~1k words) fall under the cap and are scored exactly.
    const ENTROPY_CAP = 1500;
    const distCandidates = subsample(candidates, ENTROPY_CAP);
    const distTotal = distCandidates.length;
    const probePool = subsample(pool === 'full' && guesses ? guesses : candidates, ENTROPY_CAP);

    const scored = [];
    for (const probe of probePool) {
        // Distribution of feedback patterns this probe would produce over the candidates.
        const buckets = new Map();
        for (const c of distCandidates) {
            const pat = computePattern(probe, c);
            buckets.set(pat, (buckets.get(pat) || 0) + 1);
        }
        let entropy = 0;
        for (const cnt of buckets.values()) {
            const p = cnt / distTotal;
            entropy -= p * (Math.log(p) / LOG2);
        }
        scored.push({ word: probe, score: entropy, isAnswer: candidateSet.has(probe) });
    }

    // Best entropy first; tie-break toward words that could themselves be the answer
    // (a chance to win outright), then toward more common candidates.
    scored.sort((a, b) =>
        b.score - a.score ||
        (b.isAnswer === a.isAnswer ? 0 : a.isAnswer ? -1 : 1)
    );

    self.postMessage({ remaining, strategy: 'info-gain', suggestions: scored.slice(0, topN) });
};
