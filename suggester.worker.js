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

// Reusable scratch buffers (worker is single-threaded, so reuse is safe and avoids
// allocating on every one of the millions of pattern computations).
const _counts = new Int8Array(26);
const _code = new Int8Array(16);

// Wordle feedback pattern of `guess` against `target`, as a digit string:
// 2 = correct (green), 1 = present (yellow), 0 = absent (grey). Mirrors the
// game's two-pass, letter-count-aware evaluation in script.js (revealRow).
function computePattern(guess, target) {
    const L = guess.length;
    _counts.fill(0);
    for (let i = 0; i < L; i++) _counts[target.charCodeAt(i) - 97]++;
    for (let i = 0; i < L; i++) {
        const g = guess.charCodeAt(i);
        if (g === target.charCodeAt(i)) { _code[i] = 2; _counts[g - 97]--; }
        else _code[i] = 0;
    }
    for (let i = 0; i < L; i++) {
        if (_code[i] === 0) {
            const ci = guess.charCodeAt(i) - 97;
            if (_counts[ci] > 0) { _code[i] = 1; _counts[ci]--; }
        }
    }
    let res = '';
    for (let i = 0; i < L; i++) res += _code[i];
    return res;
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
    const probePool = pool === 'full' && guesses ? guesses : candidates;
    const LOG2 = Math.log(2);

    const scored = [];
    for (const probe of probePool) {
        // Distribution of feedback patterns this probe would produce over the candidates.
        const buckets = new Map();
        for (const c of candidates) {
            const pat = computePattern(probe, c);
            buckets.set(pat, (buckets.get(pat) || 0) + 1);
        }
        let entropy = 0;
        for (const cnt of buckets.values()) {
            const p = cnt / remaining;
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
