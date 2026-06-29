// Canonical Wordle feedback scorer — THE single source of truth.
//
// Loaded three ways, all sharing this one implementation so the board, the post-game
// analysis, and the solver worker can never drift apart:
//   • browser  — <script src="pattern.js"> before script.js   → window.WordlePattern
//   • worker   — importScripts('pattern.js') in suggester.worker.js → self.WordlePattern
//   • node     — required/eval'd by tests/pattern.test.mjs      → module.exports
//
// Keep this file dependency-free and framework-free so all three loaders stay happy.

(function (global) {
    'use strict';

    // Scratch buffers reused across calls. Both the browser and the worker are
    // single-threaded and computePattern runs to completion synchronously, so reuse is safe
    // and avoids allocating on every one of the millions of calls the solver makes.
    const _counts = new Int8Array(26); // letters a–z
    const _code = new Int8Array(16);   // per-position codes; 16 ≥ any supported word length

    // Wordle feedback of `guess` against `target` as a "210"-style digit string:
    // 2 = correct (green), 1 = present (yellow), 0 = absent (grey). Two-pass and
    // letter-count-aware: greens are claimed first, then each remaining guess letter is
    // yellow only while unclaimed copies of it remain in the target. Assumes lowercase a–z
    // (the dictionary and submitted guesses are always lowercased).
    function computePattern(guess, target) {
        const L = guess.length;
        _counts.fill(0);
        for (let i = 0; i < L; i++) _counts[target.charCodeAt(i) - 97]++;
        // Pass 1: greens. Consume a target copy for each exact match.
        for (let i = 0; i < L; i++) {
            const g = guess.charCodeAt(i);
            if (g === target.charCodeAt(i)) { _code[i] = 2; _counts[g - 97]--; }
            else _code[i] = 0;
        }
        // Pass 2: yellows. A non-green letter is present only while unclaimed copies remain.
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

    const api = { computePattern };
    // Node (CommonJS / eval-with-`self`) vs browser/worker global.
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else global.WordlePattern = api;
})(typeof self !== 'undefined' ? self : globalThis);
