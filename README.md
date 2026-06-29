# Wordle Pro

A customizable Wordle: choose your word length, number of tries, and difficulty, then
solve. Comes with an optimal-play assistant, post-game analysis, dark mode, and local
stats.

**Play it live: https://iamyvj.github.io/prowordle/**

## Features

- **Custom puzzles** — word length 4–8, anywhere from 3 to 10 tries.
- **Three difficulties**
  - **Easy** — any valid word; everyday answers.
  - **Medium** — everyday answers, but every revealed hint must be reused (greens stay in
    place, yellows must appear) — NYT-style hard mode.
  - **Hard** — a wide, obscure answer pool (real words only — no names, places, or brands),
    *plus* the hint-reuse rule.
- **Best plays assistant** — suggests strong guesses. While the field is large it maximizes
  information gain; as it narrows it switches to the most likely answer. It only ever sees
  the feedback you've already been shown — never the secret word.
- **Performance analysis** — a per-guess breakdown after every game.
- **Dark / light theme**, remembered across visits.
- **Local stats** — games played, wins, and streaks, kept in your browser.

## How it works

A pure static site — HTML, CSS, and vanilla JavaScript, with no framework and no runtime
dependencies.

- **Word lists load lazily, per length.** Each length has its own `data/words-<n>.json`,
  fetched the first time you start a game at that length.
- **One feedback scorer, shared everywhere.** `pattern.js` is the single green/yellow/grey
  scorer used by the board, the assistant, and the analysis — so they can never disagree
  about what a guess means. A test suite fails if anyone re-introduces a private copy.
- **The assistant is solution-blind.** `suggester.worker.js` runs in a Web Worker and is
  handed only the patterns you've already seen, ranking candidates by expected information
  gain (entropy). The heavy search stays off the UI thread, so the interface never janks.

## Project structure

```
index.html               Markup + screens (home, game, modals)
style.css                Theme tokens and all styling
script.js                Game logic, state, rendering, stats
pattern.js               Canonical feedback scorer (shared by all three consumers)
suggester.worker.js      Solution-blind best-plays worker
data/words-<n>.json      Per-length word lists (4–8)
scripts/build-words.mjs  Regenerates the word lists
tests/pattern.test.mjs   Drift guard for the scorer
```

## Word lists

Each `data/words-<n>.json` holds three arrays:

| field | meaning |
|---|---|
| `guesses` | every valid word of that length — the "is this typeable?" set (~7k–52k words) |
| `answers` | the common, frequency-ordered subset — the Easy/Medium solution pool |
| `hardAnswers` | every real, proper-noun-free word — the Hard solution pool |

The invariant `answers ⊆ hardAnswers ⊆ guesses` guarantees the secret word is always
something you could actually type.

Proper nouns are the subtle part. A web-frequency list lowercases names, places, and brands
(`paris`, `toyota`) that would make unfair secrets. Answers are therefore gated through the
ENABLE word-game dictionary (public-domain, free of proper nouns) plus a small allowlist for
modern words it predates (`email`, `online`). Only `guesses` — used purely to validate that a
typed word is real — keeps the permissive set.

### Regenerating the data

The sources aren't checked in. Fetch them, then run the build:

```sh
curl -fsSL -o scripts/sources/words_alpha.txt \
  https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt
curl -fsSL -o scripts/sources/google-10000-english-no-swears.txt \
  https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-no-swears.txt
curl -fsSL -o scripts/sources/enable1.txt \
  https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt

node scripts/build-words.mjs
```

Data sources: [dwyl/english-words](https://github.com/dwyl/english-words),
[first20hours/google-10000-english](https://github.com/first20hours/google-10000-english),
and the [ENABLE](https://github.com/dolph/dictionary) word list.

## Tests

```sh
node --test
```

Checks the feedback scorer against an independent reference over a fuzz corpus, and asserts
the scorer is defined in exactly one place.

## License

MIT — see [LICENSE](LICENSE).
