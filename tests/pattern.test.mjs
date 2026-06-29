// Drift guard for the Wordle feedback scorer.
//
// There used to be three hand-copied implementations of the green/yellow/grey logic — in
// script.js (the board, via revealRow), in suggester.worker.js (the solver), and in the
// analysis. If any drifted, the solver's "best plays" and the post-game analysis would be
// computed against feedback the player never actually saw — a silent, hard-to-spot break.
//
// They're now ONE function in pattern.js. These tests:
//   1. verify pattern.js matches an independent reference over hand cases + a fuzz corpus, and
//   2. assert nobody has re-introduced a private copy (script.js / the worker must use the
//      shared one).
//
// Run:  node --test           (from the project root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

// Load the REAL pattern.js (not a copy). It attaches its API to whatever `self` it's handed
// (its browser/worker code path), so we run the source with a stand-in global. `module` is not
// in scope inside `new Function`, so it deterministically takes the global-attach branch.
const sandbox = {};
new Function('self', read('pattern.js'))(sandbox);
const computePattern =
    sandbox.WordlePattern && sandbox.WordlePattern.computePattern;

// Independent reference implementation, written deliberately differently from the optimized
// Int8Array version in pattern.js (plain object counts, string compares) so a shared bug is
// unlikely to hide in both.
function reference(guess, target) {
    const n = guess.length;
    const code = Array(n).fill(0);
    const avail = {};
    for (const ch of target) avail[ch] = (avail[ch] || 0) + 1;
    for (let i = 0; i < n; i++) {
        if (guess[i] === target[i]) { code[i] = 2; avail[guess[i]]--; } // greens first
    }
    for (let i = 0; i < n; i++) {
        if (code[i] === 0 && avail[guess[i]] > 0) { code[i] = 1; avail[guess[i]]--; } // then yellows
    }
    return code.join('');
}

const randWord = (len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 26));
    return s;
};

test('pattern.js exposes a computePattern function', () => {
    assert.equal(typeof computePattern, 'function',
        'pattern.js must expose WordlePattern.computePattern');
});

test('hand-computed cases (greens, greys, duplicate-letter accounting)', () => {
    const cases = [
        ['aaaaa', 'aaaaa', '22222'], // all correct
        ['aaaaa', 'bbbbb', '00000'], // all absent
        ['speed', 'erase', '10110'], // two e's: both present, s present, p/d absent
        ['aabbb', 'abcde', '20100'], // 1st a green; 2nd a has no copies left -> grey; one b yellow
        ['llama', 'ladle', '21100'], // l: green+yellow (target has 2); a: one yellow, one grey (target has 1)
    ];
    for (const [guess, target, expected] of cases) {
        assert.equal(computePattern(guess, target), expected, `${guess} vs ${target}`);
        assert.equal(reference(guess, target), expected, `reference disagrees on ${guess} vs ${target}`);
    }
});

test('matches the independent reference over a fuzz corpus (lengths 4-8)', () => {
    for (let n = 0; n < 50000; n++) {
        const len = 4 + Math.floor(Math.random() * 5); // 4..8
        const guess = randWord(len);
        const target = randWord(len);
        assert.equal(
            computePattern(guess, target),
            reference(guess, target),
            `mismatch: computePattern("${guess}","${target}")=${computePattern(guess, target)} ` +
            `but reference=${reference(guess, target)}`
        );
    }
});

test('output length always equals word length (reused buffer never leaks across lengths)', () => {
    // Interleave different lengths so a stale scratch buffer would show up as a wrong length.
    for (const [g, t] of [['abcd', 'abcd'], ['abcdefgh', 'zzzzzzzz'], ['rose', 'paris'], ['planet', 'planet']]) {
        const p = computePattern(g, t);
        assert.equal(p.length, g.length, `length mismatch for ${g}`);
        assert.match(p, /^[012]+$/, `unexpected chars in ${p}`);
    }
});

test('deterministic: identical inputs give identical output', () => {
    const a = computePattern('crane', 'trace');
    const b = computePattern('crane', 'trace');
    assert.equal(a, b);
});

// --- Source guards: ensure the duplication can't quietly come back -----------------------

test('only pattern.js defines computePattern; consumers use the shared one', () => {
    const defRe = /function\s+computePattern\b/;

    assert.match(read('pattern.js'), defRe, 'pattern.js should define computePattern');

    const script = read('script.js');
    assert.doesNotMatch(script, defRe,
        'script.js must not define its own computePattern — use WordlePattern.computePattern');
    assert.match(script, /WordlePattern\.computePattern/,
        'script.js should reference the shared WordlePattern.computePattern');

    const worker = read('suggester.worker.js');
    assert.doesNotMatch(worker, defRe,
        'suggester.worker.js must not define its own computePattern — importScripts pattern.js');
    assert.match(worker, /importScripts\(['"]pattern\.js['"]\)/,
        'suggester.worker.js should importScripts(\'pattern.js\')');
});

test('index.html loads pattern.js before script.js', () => {
    const html = read('index.html');
    // Match the actual <script src="..."> tags, not incidental mentions in comments.
    const iPattern = html.search(/<script\s+src=["']pattern\.js["']/);
    const iScript = html.search(/<script\s+src=["']script\.js["']/);
    assert.ok(iPattern !== -1, 'index.html should load pattern.js via a <script> tag');
    assert.ok(iScript !== -1, 'index.html should load script.js via a <script> tag');
    assert.ok(iPattern < iScript, 'pattern.js must be loaded before script.js');
});
