// Build per-length word lists for Wordle Pro.
//
// Reads two cached source files (download once with curl — see scripts/README
// or the npm-free commands below) and emits one JSON file per word length:
//
//   data/words-<n>.json = { length, guesses: [...], answers: [...] }
//
//   guesses[n] = every valid dictionary word of length n  (large; "is this a real word?")
//   answers[n] = the common subset, by frequency           (small; the solution pool)
//
// answers is always a SUBSET of guesses, so the solution is always typeable.
//
// Sources (fetch via curl — works behind a TLS-intercepting proxy where Node fetch fails):
//   curl -fsSL -o scripts/sources/words_alpha.txt \
//     https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt
//   curl -fsSL -o scripts/sources/google-10000-english-no-swears.txt \
//     https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-no-swears.txt
//
// Run:  node scripts/build-words.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = join(ROOT, 'scripts', 'sources');
const OUT_DIR = join(ROOT, 'data');

// --- Tunables ---------------------------------------------------------------
const MIN_LEN = 4;
const MAX_LEN = 8;
// Use the top-N most frequent words as the answer-eligibility pool.
// google-10000 is ordered by frequency, so this just slices the front.
const FREQUENCY_TOP_N = Infinity; // Infinity = use the whole 10k list
// Obvious non-words / abbreviations that sneak into a web-frequency list and
// make poor answers. Extend freely.
const STOPLIST = new Set([
    'http', 'https', 'html', 'xml', 'url', 'urls', 'www', 'jpg', 'jpeg',
    'gif', 'png', 'pdf', 'asp', 'aspx', 'php', 'cgi', 'dvd', 'sql',
    'faq', 'faqs', 'isbn', 'nbsp', 'href', 'mailto', 'gmt', 'utc',
]);
// ---------------------------------------------------------------------------

function readWords(file) {
    return readFileSync(join(SOURCES, file), 'utf8')
        .split(/\r?\n/)
        .map(w => w.trim().toLowerCase())
        .filter(Boolean);
}

const isAlpha = w => /^[a-z]+$/.test(w);
const inRange = w => w.length >= MIN_LEN && w.length <= MAX_LEN;

// Full dictionary -> the allowed-guess universe.
const dictionary = new Set(readWords('words_alpha.txt').filter(w => isAlpha(w) && inRange(w)));

// Frequency-ordered common words -> answer eligibility.
// google-10000 is already ordered most-common-first; keep that order (deduped) so the
// emitted answers arrays are sorted by commonness. The "most likely answer" ranking in
// the optimal-play suggester relies on this ordering (earlier index = more common).
const seenFreq = new Set();
const frequent = [];
for (const w of readWords('google-10000-english-no-swears.txt')) {
    if (!isAlpha(w) || !inRange(w) || STOPLIST.has(w) || seenFreq.has(w)) continue;
    seenFreq.add(w);
    frequent.push(w);
    if (frequent.length >= FREQUENCY_TOP_N) break;
}

mkdirSync(OUT_DIR, { recursive: true });

const summary = [];
for (let len = MIN_LEN; len <= MAX_LEN; len++) {
    const guesses = [...dictionary].filter(w => w.length === len).sort();
    // answers must be common AND a valid guess (subset of guesses) AND a real word.
    // Kept in frequency order (most common first), NOT alphabetical.
    const answers = frequent.filter(w => w.length === len && dictionary.has(w));

    writeFileSync(
        join(OUT_DIR, `words-${len}.json`),
        JSON.stringify({ length: len, guesses, answers })
    );
    summary.push({ length: len, guesses: guesses.length, answers: answers.length });
}

console.table(summary);
console.log(`Wrote ${summary.length} files to data/  (words-${MIN_LEN}.json … words-${MAX_LEN}.json)`);
