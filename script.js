// Wordle Pro - Main Game Script
// Modern variable-length (4–8) Wordle clone with enhanced UI

// Game State
const state = {
    solution: '',
    guesses: [],
    currentGuess: '',
    currentRow: 0,
    gameOver: false,
    won: false,
    wordLength: 5, // default matches the home screen's pre-selected length (synced from the DOM on load)
    maxTries: 6,
    difficulty: 'easy',
    isDaily: false,        // Daily Challenge mode (deterministic word, no Best Plays helper)
    isChallenge: false,    // launched from a "Challenge a friend" link (fixed word + config)
    isBlitz: false,        // Blitz / Time Attack mode (timed; solve as many words as possible)
    isQuordle: false,      // Quordle mode (four boards solved in parallel; see the Quordle module)
    dailyDate: '',         // YYYY-MM-DD the active daily belongs to
    dictionary: new Set(), // allowed guesses for the current length (O(1) lookup)
    solutions: [],         // common-answer pool for the current length
    revealedLetters: { correct: {}, present: new Set() }
};

// Statistics
let stats = JSON.parse(localStorage.getItem('wordleProStats')) || {
    played: 0,
    won: 0,
    currentStreak: 0,
    maxStreak: 0,
    dist: {}            // guesses-to-win -> count, drives the distribution chart
};
// Back-fill for saves created before the distribution existed, so older players
// don't hit a missing-field error the first time the chart renders.
if (!stats.dist || typeof stats.dist !== 'object') stats.dist = {};

// Theme Management
const currentTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', currentTheme);

// High-contrast / colorblind mode. Applied before first paint so there's no color flash.
const CONTRAST_KEY = 'wordleProContrast';
if (localStorage.getItem(CONTRAST_KEY) === 'high') {
    document.documentElement.setAttribute('data-contrast', 'high');
}

// Debug mode (OFF by default). Enable to log the solution + internals to the console:
//   • append ?debug to the URL, or
//   • run localStorage.setItem('wordleDebug', '1') once in devtools.
// This keeps the answer out of a normal player's console. NOTE: in static mode the solution
// still lives in client memory (state.solution), so this only removes the trivial giveaway —
// true anti-cheat requires the server-authoritative mode (see GAME-SERVER-PLATFORM.md).
const DEBUG = new URLSearchParams(location.search).has('debug')
    || localStorage.getItem('wordleDebug') === '1';

// Loading Screen
// Word lists are now loaded lazily per length when a game starts (see loadWords),
// so the boot splash just reveals the app shell.
window.addEventListener('load', () => {
    setTimeout(() => {
        const loadingScreen = document.getElementById('loading-screen');
        const app = document.getElementById('app');

        loadingScreen.classList.add('hidden');
        setTimeout(() => {
            loadingScreen.style.display = 'none';
            app.style.display = 'block';
            updateStatsPreview();
            updateDailyButton();
            updateBlitzButton();
            updateQuordleButton();
        }, 400);
    }, 1500);
});

// Word List Loader
// Fetches data/words-<n>.json once per length and caches it. This is the single
// seam between the client and its word data — to make the game server-authoritative
// later, swap this fetch for a request to the game server (the rest of the code
// only ever sees a guesses Set + an answers array).
const wordCache = {};
async function loadWords(length) {
    if (wordCache[length]) return wordCache[length];
    // 'no-cache' = use the cached copy but always revalidate with the server (cheap 304
    // when unchanged). Without this the browser can serve a stale word list after the data
    // is rebuilt/redeployed — e.g. returning players would keep seeing removed proper nouns.
    const res = await fetch(`data/words-${length}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Failed to load words-${length}.json (HTTP ${res.status})`);
    const data = await res.json();
    // hardAnswers = proper-noun-free Hard pool. Fall back to the full guess list if an older
    // (pre-hardAnswers) data file is served, so Hard still works rather than breaking.
    const entry = {
        guesses: new Set(data.guesses),
        answers: data.answers,
        hardAnswers: data.hardAnswers || data.guesses,
    };
    wordCache[length] = entry;
    return entry;
}

// ===========================================================================
// Optimal-Play Suggester ("Best plays")
// ===========================================================================
// Hardcoded toggle for the probe pool (flip this to change which dictionary the
// info-gain search considers):
//   'answers' = score only still-possible answers      (fast, main-thread-friendly)
//   'full'    = also score non-answer "probe" words     (true optimal, heavier)
const SUGGEST_PROBE_POOL = 'answers';
const SUGGEST_TOP_N = 10;       // how many suggestions to list
const SUGGEST_SMALL_SET = 2;    // <= this many candidates left -> go for the win

// Wordle feedback pattern of `guess` vs `target` as a "210"-style code string
// (2=correct, 1=present, 0=absent). Shared with revealRow(), the analysis, and the solver
// worker via pattern.js (loaded just before this script) so they can never drift apart.
const computePattern = WordlePattern.computePattern;

// Bridge to the Web Worker. Sends only the feedback already shown to the player
// (the worker never receives state.solution), so suggestions can't just leak the answer.
let suggestWorker = null;
function getSuggestions() {
    return new Promise((resolve, reject) => {
        const words = wordCache[state.wordLength];
        if (!words) { reject(new Error('Word list not loaded')); return; }

        const observed = state.guesses.map(g => ({ guess: g, pattern: computePattern(g, state.solution) }));
        const triesLeft = state.maxTries - state.currentRow;

        if (!suggestWorker) suggestWorker = new Worker('suggester.worker.js');
        const worker = suggestWorker;
        const cleanup = () => {
            worker.removeEventListener('message', onMsg);
            worker.removeEventListener('error', onErr);
        };
        const onMsg = (e) => { cleanup(); resolve(e.data); };
        const onErr = (err) => { cleanup(); reject(err); };
        worker.addEventListener('message', onMsg);
        worker.addEventListener('error', onErr);

        worker.postMessage({
            length: state.wordLength,
            guesses: SUGGEST_PROBE_POOL === 'full' ? [...words.guesses] : null,
            answers: state.solutions, // candidate universe (full dict on Hard, common pool otherwise)
            observed,
            pool: SUGGEST_PROBE_POOL,
            topN: SUGGEST_TOP_N,
            smallThreshold: SUGGEST_SMALL_SET,
            triesLeft,
        });
    });
}

function openSuggestModal() { document.getElementById('suggest-modal').classList.add('active'); }
function closeSuggestModal() { document.getElementById('suggest-modal').classList.remove('active'); }

// How-to-play guide. Auto-opens once on a visitor's first session and is available any time
// via the "?" button. Opening it (by either route) records the flag, so it never auto-opens again.
const HELP_SEEN_KEY = 'wordleProHelpSeen';
function openHelp() {
    document.getElementById('help-modal').classList.add('active');
    try { localStorage.setItem(HELP_SEEN_KEY, '1'); } catch (e) { /* storage unavailable */ }
}
function closeHelp() { document.getElementById('help-modal').classList.remove('active'); }

// Guard against overlapping runs. The suggester worker is a singleton, so a second
// in-flight request would attach a duplicate listener and could resolve with the FIRST
// run's result — i.e. show stale suggestions for a row you've since moved past (close the
// modal, submit a guess, reopen). Disabling the button while busy blocks the click that
// starts a second run; the flag is the belt-and-suspenders guard.
let bestPlaysBusy = false;
function setBestPlaysBusy(busy) {
    bestPlaysBusy = busy;
    const btn = document.getElementById('best-plays-btn');
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('is-loading', busy);
    if (busy) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
}

async function showBestPlays() {
    if (state.gameOver || bestPlaysBusy || state.isDaily) return;
    const content = document.getElementById('suggest-content');
    setBestPlaysBusy(true);
    content.innerHTML = '<div class="suggest-state"><div class="loader-spinner"></div><p>Calculating best plays…</p></div>';
    openSuggestModal();
    try {
        renderSuggestions(await getSuggestions());
    } catch (err) {
        console.error(err);
        content.innerHTML = '<div class="suggest-state"><p>Could not compute suggestions.</p></div>';
    } finally {
        setBestPlaysBusy(false);
    }
}

function renderSuggestions(data) {
    const content = document.getElementById('suggest-content');
    const { remaining, strategy, suggestions } = data;

    if (strategy === 'none' || !suggestions.length) {
        content.innerHTML = '<div class="suggest-state"><p>No words match the clues so far.</p></div>';
        return;
    }

    const isInfo = strategy === 'info-gain';
    const heading = isInfo ? '🔍 Maximize information' : '🎯 Go for the win';
    const sub = remaining === 1 ? 'Only 1 possible word left' : `${remaining.toLocaleString()} possible words left`;

    // Normalize scores to a 0–100% bar width.
    const maxScore = isInfo
        ? Math.max(Math.log2(Math.max(remaining, 2)), ...suggestions.map(s => s.score))
        : 1;

    const items = suggestions.map((s, i) => {
        const pct = Math.max(4, Math.round((s.score / maxScore) * 100));
        const scoreLabel = isInfo
            ? `<span class="suggest-score-value">${s.score.toFixed(2)}</span><div class="suggest-score-unit">bits</div>`
            : `<span class="suggest-score-value">#${i + 1}</span><div class="suggest-score-unit">pick</div>`;
        const tag = s.isAnswer && isInfo ? '<span class="suggest-tag">possible</span>' : '';
        return `
            <button class="suggest-item" data-word="${s.word}">
                <span class="suggest-rank">${i + 1}</span>
                <span class="suggest-word-wrap">
                    <span class="suggest-word">${s.word}</span>${tag}
                    <div class="suggest-bar-track"><div class="suggest-bar-fill" style="width:${pct}%"></div></div>
                </span>
                <span class="suggest-score">${scoreLabel}</span>
            </button>`;
    }).join('');

    const hint = isInfo
        ? 'Higher = splits the remaining words more evenly. Tap a word to fill the current row.'
        : 'Most common of the words that still fit. Tap a word to fill the current row.';

    content.innerHTML = `
        <div class="suggest-summary">
            <div class="suggest-strategy">${heading}</div>
            <div class="suggest-remaining">${sub}</div>
        </div>
        <div class="suggest-list">${items}</div>
        <p class="suggest-hint">${hint}</p>`;

    content.querySelectorAll('.suggest-item').forEach(btn => {
        btn.addEventListener('click', () => fillCurrentGuess(btn.dataset.word));
    });
}

function fillCurrentGuess(word) {
    if (state.gameOver) return;
    state.currentGuess = word.slice(0, state.wordLength);
    updateBoard();
    closeSuggestModal();
}

// Home-screen control config + persistence.
const DIFFICULTY_DESCRIPTIONS = {
    easy: 'Any valid word is allowed',
    medium: 'Must reuse every revealed hint',
    hard: 'Rare words allowed — plus you must reuse every hint'
};
const SETTINGS_KEY = 'wordleProSettings';

// Read the saved length/tries/difficulty, validated against the allowed ranges so a
// stale or tampered value can never start a broken game. Returns null when absent/invalid.
function loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
        if (s && s.length >= 4 && s.length <= 8 && s.tries >= 3 && s.tries <= 10
            && DIFFICULTY_DESCRIPTIONS[s.difficulty]) {
            return { length: s.length, tries: s.tries, difficulty: s.difficulty };
        }
    } catch (e) { /* ignore malformed JSON */ }
    return null;
}

// Persist the player's current choices so the home screen restores them next visit.
function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            length: state.wordLength,
            tries: state.maxTries,
            difficulty: state.difficulty
        }));
    } catch (e) { /* storage unavailable — settings just won't persist */ }
}

// Apply a {length, tries, difficulty} config to BOTH game state and the home-screen
// controls in one place, so the UI and state can never drift. Each value is range-checked
// independently. Used to restore saved settings and to honor an incoming challenge link.
function applyHomeSettings(length, tries, difficulty) {
    if (length >= 4 && length <= 8) {
        state.wordLength = length;
        document.querySelectorAll('[data-length]').forEach(b =>
            b.classList.toggle('active', parseInt(b.dataset.length) === length));
        const disp = document.getElementById('word-length-display');
        if (disp) disp.textContent = length;
    }
    if (tries >= 3 && tries <= 10) {
        state.maxTries = tries;
        const slider = document.getElementById('home-tries');
        const td = document.getElementById('tries-display');
        if (slider) slider.value = tries;
        if (td) td.textContent = tries;
    }
    if (DIFFICULTY_DESCRIPTIONS[difficulty]) {
        state.difficulty = difficulty;
        document.querySelectorAll('[data-difficulty]').forEach(b =>
            b.classList.toggle('active', b.dataset.difficulty === difficulty));
        const dd = document.getElementById('difficulty-description');
        if (dd) dd.textContent = DIFFICULTY_DESCRIPTIONS[difficulty];
    }
}

// Home Screen Setup
function setupHomeScreen() {
    // Word Length Selection (4–8; each length loads its own list on Start)
    const lengthButtons = document.querySelectorAll('[data-length]');
    lengthButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            lengthButtons.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            state.wordLength = parseInt(e.target.dataset.length);
            document.getElementById('word-length-display').textContent = state.wordLength;
            saveSettings();
        });
    });

    // Tries Slider
    const triesSlider = document.getElementById('home-tries');
    const triesDisplay = document.getElementById('tries-display');
    triesSlider.addEventListener('input', (e) => {
        state.maxTries = parseInt(e.target.value);
        triesDisplay.textContent = state.maxTries;
        saveSettings();
    });

    // Difficulty Selection
    const difficultyButtons = document.querySelectorAll('[data-difficulty]');
    difficultyButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            difficultyButtons.forEach(b => b.classList.remove('active'));
            e.target.closest('.difficulty-btn').classList.add('active');
            state.difficulty = e.target.closest('.difficulty-btn').dataset.difficulty;
            document.getElementById('difficulty-description').textContent =
                DIFFICULTY_DESCRIPTIONS[state.difficulty];
            saveSettings();
        });
    });

    // Initial config: restore saved settings if present, otherwise sync from whatever the
    // home screen shows as selected by default (so starting without touching a control uses
    // the displayed values). applyHomeSettings keeps state and UI in lockstep either way.
    let cfg = loadSettings();
    if (!cfg) {
        const activeLength = document.querySelector('[data-length].active');
        const activeDifficulty = document.querySelector('[data-difficulty].active');
        cfg = {
            length: activeLength ? parseInt(activeLength.dataset.length) : state.wordLength,
            tries: parseInt(triesSlider.value),
            difficulty: activeDifficulty ? activeDifficulty.dataset.difficulty : state.difficulty
        };
    }
    applyHomeSettings(cfg.length, cfg.tries, cfg.difficulty);

    // Start Game Button
    document.getElementById('start-game-btn').addEventListener('click', () => startGame());

    // Retry button inside the word-list load-error banner (re-attempts the start).
    const retryLoadBtn = document.getElementById('retry-load-btn');
    if (retryLoadBtn) retryLoadBtn.addEventListener('click', () => startGame());
}

// Stats Preview
function updateStatsPreview() {
    const preview = document.querySelector('.stats-grid');
    if (preview) {
        preview.children[0].querySelector('.stat-value-preview').textContent = stats.played;
        preview.children[1].querySelector('.stat-value-preview').textContent = stats.won;
        preview.children[2].querySelector('.stat-value-preview').textContent = stats.currentStreak;
    }
}

// Start Game
let startingGame = false;
// Show or clear the home-screen word-list load error. Pass a message to reveal the banner
// (with its Try-again button), or null to hide it. Note the transient showMessage() toast
// lives in a container on the GAME screen, which is hidden while the home screen is up — so a
// Start-time failure needs its own visible, persistent banner here rather than a toast.
function setLoadError(message) {
    const box = document.getElementById('load-error');
    if (!box) return;
    if (message) {
        const text = document.getElementById('load-error-text');
        if (text) text.textContent = message;
        box.hidden = false;
    } else {
        box.hidden = true;
    }
}

// Reset the document scroll so a newly shown screen starts at the top. The page
// scrolls at the window level and the home screen can be taller than the viewport,
// so its scroll position would otherwise carry over to the game screen.
function scrollToTop() {
    window.scrollTo(0, 0);
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
}

// `challengeWord`, when given, fixes the solution (a "Challenge a friend" link) instead of
// picking randomly; the length/tries/difficulty must already be applied to state.
async function startGame(challengeWord = null) {
    if (startingGame) return; // guard against double-trigger while words load
    startingGame = true;
    setLoadError(null); // clear any previous failure (e.g. when retrying)

    // Load the word list for the chosen length (cached after first fetch).
    const startBtn = document.getElementById('start-game-btn');
    const startLabel = startBtn ? startBtn.querySelector('span') : null;
    const originalLabel = startLabel ? startLabel.textContent : '';
    if (startLabel) startLabel.textContent = 'Loading words…';
    try {
        const words = await loadWords(state.wordLength);
        state.dictionary = words.guesses; // Set of allowed guesses
        // Solution pool by difficulty: Hard pulls from hardAnswers — the wide, obscure, but
        // proper-noun-free word set — so rare/archaic words become possible answers without
        // ever serving a name/place/brand as the secret; Easy/Medium stay in the common-answer
        // pool. This is also the universe that Best Plays and the post-game analysis treat as
        // "possible answers", so they stay consistent with where the secret actually came from.
        state.solutions = state.difficulty === 'hard' ? words.hardAnswers : words.answers;
    } catch (err) {
        console.error(err);
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        setLoadError(offline
            ? 'You appear to be offline. Reconnect, then try again.'
            : "Couldn't load the word list. Check your connection and try again.");
        return;
    } finally {
        if (startLabel) startLabel.textContent = originalLabel;
        startingGame = false;
    }

    // Reset state
    state.guesses = [];
    state.currentGuess = '';
    state.currentRow = 0;
    state.gameOver = false;
    state.won = false;
    state.isDaily = false;
    state.isChallenge = !!challengeWord;
    state.revealedLetters = { correct: {}, present: new Set() };
    exitBlitzMode(); // clear any in-progress Blitz run (timer/HUD/lock) when starting a normal game
    exitQuordleMode(); // and tear down any in-progress Quordle run

    // A challenge link fixes the word; otherwise pick randomly from the difficulty's pool.
    state.solution = challengeWord || state.solutions[Math.floor(Math.random() * state.solutions.length)];
    if (DEBUG) console.log('Solution:', state.solution);

    // Switch screens
    document.getElementById('home-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    scrollToTop();

    // Update game info
    const difficultyNames = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
    const configLabel = `${state.wordLength} Letters • ${state.maxTries} Tries • ${difficultyNames[state.difficulty]}`;
    document.getElementById('game-config').textContent =
        state.isChallenge ? `Challenge • ${configLabel}` : configLabel;
    setBestPlaysVisible(true);

    // Initialize board and keyboard
    initBoard();
    initKeyboard();

    // Hide result display
    document.getElementById('result-display').style.display = 'none';
}

// ===========================================================================
// Daily Challenge
// ===========================================================================
// One shared word per calendar day, picked deterministically from the date so
// everyone playing on the same day gets the same puzzle (no server needed). Fixed
// 5-letter / 6-try / common-answer config. Progress is saved per day so the game can
// be resumed across refreshes and is locked once finished. The Best Plays helper is
// intentionally hidden in this mode.
const DAILY_LENGTH = 5;
const DAILY_TRIES = 6;
const DAILY_KEY = 'wordleProDaily';

// Local calendar date as YYYY-MM-DD (the daily rolls over at the player's own midnight).
function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Deterministic FNV-1a string hash -> unsigned 32-bit. The same date always maps to the
// same word, while adjacent dates scatter to unrelated words.
function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function pickDailyWord(answers, dateKey) {
    if (!answers || !answers.length) return '';
    return answers[hashString(`wordlepro-daily-${dateKey}`) % answers.length];
}

function loadDailyProgress() {
    try { return JSON.parse(localStorage.getItem(DAILY_KEY)); }
    catch (e) { return null; }
}

// Persist today's guesses + status so the daily survives a refresh and stays locked once
// finished. Stores only the player's own guesses — never the solution.
function saveDailyProgress() {
    const status = state.won ? 'won' : (state.gameOver ? 'lost' : 'in-progress');
    try {
        localStorage.setItem(DAILY_KEY, JSON.stringify({
            date: state.dailyDate,
            guesses: state.guesses,
            status,
        }));
    } catch (e) { /* storage unavailable — progress just won't persist */ }
}

// Re-apply already-made guesses to the board WITHOUT animation, advancing state exactly as
// submitGuess would (minus stats/animation), so a saved daily can be resumed or shown
// finished. Does NOT touch stats — those were already recorded when the guesses were live.
function replayGuesses(savedGuesses) {
    for (const g of savedGuesses) {
        if (!g || g.length !== state.wordLength) continue;
        state.currentGuess = g;
        state.guesses.push(g);
        revealRow(false);
        updateKeyboard();
        if (g === state.solution) { state.won = true; state.gameOver = true; break; }
        if (state.currentRow === state.maxTries - 1) { state.gameOver = true; break; }
        state.currentRow++;
        state.currentGuess = '';
    }
}

// Show/hide the Best Plays helper button (hidden during the Daily Challenge).
function setBestPlaysVisible(visible) {
    const btn = document.getElementById('best-plays-btn');
    if (btn) btn.style.display = visible ? '' : 'none';
}

// Refresh the home-screen Daily button's sub-label with today's state.
function updateDailyButton() {
    const sub = document.getElementById('daily-btn-sub');
    if (!sub) return;
    const today = todayKey();
    const dateLabel = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const saved = loadDailyProgress();
    if (saved && saved.date === today && (saved.status === 'won' || saved.status === 'lost')) {
        sub.textContent = saved.status === 'won' ? 'Solved today — back tomorrow' : 'Played today — back tomorrow';
    } else if (saved && saved.date === today && saved.guesses && saved.guesses.length) {
        sub.textContent = `Resume today's word • ${dateLabel}`;
    } else {
        sub.textContent = `Today's word • ${dateLabel}`;
    }
}

let startingDaily = false;
async function startDailyChallenge() {
    if (startingDaily) return;
    startingDaily = true;
    setLoadError(null);

    // Briefly reflect loading in the button's sub-label, then restore it.
    const sub = document.getElementById('daily-btn-sub');
    const originalSub = sub ? sub.textContent : '';
    if (sub) sub.textContent = 'Loading…';

    let words;
    try {
        words = await loadWords(DAILY_LENGTH);
    } catch (err) {
        console.error(err);
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        setLoadError(offline
            ? 'You appear to be offline. Reconnect, then try again.'
            : "Couldn't load the daily word. Check your connection and try again.");
        return;
    } finally {
        if (sub) sub.textContent = originalSub;
        startingDaily = false;
    }

    // Fixed daily config.
    state.wordLength = DAILY_LENGTH;
    state.maxTries = DAILY_TRIES;
    state.difficulty = 'easy';
    state.dictionary = words.guesses;
    state.solutions = words.answers;

    // Reset per-game state.
    state.guesses = [];
    state.currentGuess = '';
    state.currentRow = 0;
    state.gameOver = false;
    state.won = false;
    state.isDaily = true;
    state.isChallenge = false;
    state.revealedLetters = { correct: {}, present: new Set() };
    exitBlitzMode(); // clear any in-progress Blitz run (timer/HUD/lock) when starting the daily
    exitQuordleMode(); // and tear down any in-progress Quordle run

    // Deterministic word for today.
    state.dailyDate = todayKey();
    state.solution = pickDailyWord(words.answers, state.dailyDate);
    if (DEBUG) console.log('Daily solution:', state.solution);

    // Switch to the game screen.
    document.getElementById('home-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    scrollToTop();
    document.getElementById('game-config').textContent = `Daily Challenge • ${state.wordLength} Letters`;
    setBestPlaysVisible(false); // no helper in the daily

    initBoard();
    initKeyboard();
    document.getElementById('result-display').style.display = 'none';

    // Resume today's saved progress, if any.
    const saved = loadDailyProgress();
    if (saved && saved.date === state.dailyDate && Array.isArray(saved.guesses) && saved.guesses.length) {
        replayGuesses(saved.guesses);
        if (state.gameOver) showResult(); // already finished today -> show the locked result
    }
}

// ===========================================================================
// Blitz / Time Attack
// ===========================================================================
// A timed sprint on fixed 5-letter / 6-try / common-answer puzzles: instead of one word you
// solve as many as you can before the clock runs out. Solving a word (or using up all 6 tries)
// immediately rolls a fresh word onto the same board. Score = words solved. Only the personal
// best is persisted — Blitz never touches the normal win/streak stats. No Best Plays helper.
const BLITZ_LENGTH = 5;
const BLITZ_TRIES = 6;
const BLITZ_SECONDS = 90;
const BLITZ_KEY = 'wordleProBlitz';

// Timer handle + an input lock. blitzLock is raised during the reveal/advance window between
// words (and during the start countdown) so a fast typist can't submit a guess on the old
// board moments before it's replaced — or before the clock has even started.
let blitzTimerId = null;
let blitzLock = false;
let startingBlitz = false;

// Start-of-run "3 · 2 · 1 · Go!" lead-in. Digits show for STEP ms, the "Go!" flash for GO ms.
const BLITZ_COUNT_STEP = 650;
const BLITZ_COUNT_GO = 500;
let blitzCountdownId = null;

function loadBlitzBest() {
    try {
        const b = JSON.parse(localStorage.getItem(BLITZ_KEY));
        return (b && typeof b.best === 'number' && b.best >= 0) ? b.best : 0;
    } catch (e) { return 0; }
}

function saveBlitzBest(score) {
    try { localStorage.setItem(BLITZ_KEY, JSON.stringify({ best: score })); }
    catch (e) { /* storage unavailable — best just won't persist */ }
}

// Refresh the home-screen Blitz button's sub-label with the saved best.
function updateBlitzButton() {
    const sub = document.getElementById('blitz-btn-sub');
    if (!sub) return;
    const best = loadBlitzBest();
    sub.textContent = best > 0
        ? `${BLITZ_SECONDS}s sprint • Best ${best}`
        : `Solve as many as you can in ${BLITZ_SECONDS}s`;
}

// Format milliseconds as M:SS for the HUD clock (ceil so the last second still reads "0:01").
function formatTime(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Show/hide the Blitz HUD (and mirror that in aria-hidden).
function setBlitzHudVisible(visible) {
    const hud = document.getElementById('blitz-hud');
    if (!hud) return;
    hud.style.display = visible ? '' : 'none';
    hud.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function updateBlitzHud() {
    const scoreEl = document.getElementById('blitz-score');
    if (scoreEl) scoreEl.textContent = state.blitzScore;
}

// Recompute the remaining time from the fixed end-timestamp (so background-tab throttling
// can't make the clock drift) and end the run when it hits zero.
function updateBlitzTimer() {
    const remaining = Math.max(0, state.blitzEndTime - Date.now());
    const timeEl = document.getElementById('blitz-time');
    if (timeEl) {
        timeEl.textContent = formatTime(remaining);
        timeEl.classList.toggle('is-low', remaining <= 10000 && remaining > 0);
    }
    if (remaining <= 0) endBlitz();
}

function startBlitzTimer() {
    stopBlitzTimer();
    updateBlitzTimer();                       // paint immediately (no stale first tick)
    blitzTimerId = setInterval(updateBlitzTimer, 250);
}

function stopBlitzTimer() {
    if (blitzTimerId !== null) { clearInterval(blitzTimerId); blitzTimerId = null; }
}

// Tear down an in-progress Blitz run when leaving the mode (starting another game, the daily,
// or returning home): stop the clock, hide Blitz UI, and clear the input lock so the next
// game isn't frozen by a leftover blitzLock.
function exitBlitzMode() {
    stopBlitzTimer();
    clearBlitzCountdown();
    state.isBlitz = false;
    blitzLock = false;
    setBlitzHudVisible(false);
    const panel = document.getElementById('blitz-result');
    if (panel) panel.style.display = 'none';
}

// Cancel any pending countdown and hide its overlay (used on completion and when leaving).
function clearBlitzCountdown() {
    if (blitzCountdownId !== null) { clearTimeout(blitzCountdownId); blitzCountdownId = null; }
    const overlay = document.getElementById('blitz-countdown');
    if (overlay) { overlay.style.display = 'none'; overlay.setAttribute('aria-hidden', 'true'); }
}

// Play a "3 · 2 · 1 · Go!" lead-in, then invoke onDone (which starts the clock). Input stays
// locked the whole time. Each step re-checks isBlitz so a mid-countdown exit bails cleanly
// rather than starting the clock after the player has already left the run.
function runBlitzCountdown(onDone) {
    clearBlitzCountdown(); // drop any stale countdown before starting a fresh one
    const overlay = document.getElementById('blitz-countdown');
    const numEl = document.getElementById('blitz-countdown-num');
    const steps = ['3', '2', '1', 'Go!'];
    blitzLock = true; // no typing until the clock actually starts
    announce('Get ready');
    if (overlay) { overlay.style.display = 'flex'; overlay.setAttribute('aria-hidden', 'false'); }

    let i = 0;
    const tick = () => {
        if (!state.isBlitz) { clearBlitzCountdown(); return; } // player left mid-countdown
        if (i >= steps.length) {
            clearBlitzCountdown();
            blitzLock = false;
            onDone();
            return;
        }
        const label = steps[i];
        const isGo = label === 'Go!';
        if (numEl) {
            numEl.textContent = label;
            numEl.classList.toggle('go', isGo);
            numEl.classList.remove('pop');
            void numEl.offsetWidth; // reflow so the pop animation restarts each step
            numEl.classList.add('pop');
        }
        if (isGo) announce('Go!');
        i++;
        blitzCountdownId = setTimeout(tick, isGo ? BLITZ_COUNT_GO : BLITZ_COUNT_STEP);
    };
    tick();
}

async function startBlitz() {
    if (startingBlitz) return;
    startingBlitz = true;
    setLoadError(null);

    // Briefly reflect loading in the button's sub-label, then restore it.
    const sub = document.getElementById('blitz-btn-sub');
    const originalSub = sub ? sub.textContent : '';
    if (sub) sub.textContent = 'Loading…';

    let words;
    try {
        words = await loadWords(BLITZ_LENGTH);
    } catch (err) {
        console.error(err);
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        setLoadError(offline
            ? 'You appear to be offline. Reconnect, then try again.'
            : "Couldn't load the word list. Check your connection and try again.");
        return;
    } finally {
        if (sub) sub.textContent = originalSub;
        startingBlitz = false;
    }

    // Fixed Blitz config.
    state.wordLength = BLITZ_LENGTH;
    state.maxTries = BLITZ_TRIES;
    state.difficulty = 'easy';
    state.dictionary = words.guesses;
    state.solutions = words.answers;

    // Mode flags + run state. gameOver stays false for the whole run (only endBlitz sets it).
    state.isDaily = false;
    state.isChallenge = false;
    state.isBlitz = true;
    state.gameOver = false;
    state.blitzScore = 0;
    state.blitzUsed = new Set();
    blitzLock = false;
    exitQuordleMode(); // tear down any in-progress Quordle run when starting Blitz

    // Switch to the game screen.
    document.getElementById('home-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    scrollToTop();
    document.getElementById('game-config').textContent = `Blitz • ${BLITZ_SECONDS}s`;
    setBestPlaysVisible(false); // no helper in Blitz
    document.getElementById('result-display').style.display = 'none';
    const panel = document.getElementById('blitz-result');
    if (panel) panel.style.display = 'none';

    // First word + HUD, then a "3 · 2 · 1 · Go!" lead-in before the clock starts.
    nextBlitzWord();
    updateBlitzHud();
    setBlitzHudVisible(true);
    // Freeze the HUD clock at the full duration while the lead-in plays.
    const timeEl = document.getElementById('blitz-time');
    if (timeEl) { timeEl.textContent = formatTime(BLITZ_SECONDS * 1000); timeEl.classList.remove('is-low'); }
    runBlitzCountdown(() => {
        if (!state.isBlitz) return; // guard: player may have left just as the countdown ended
        state.blitzEndTime = Date.now() + BLITZ_SECONDS * 1000;
        startBlitzTimer();
    });
}

// Load the next Blitz word onto a fresh board. Picks a not-yet-seen answer (clearing the
// used-set once the pool is exhausted) so words don't repeat within a run until they must.
function nextBlitzWord() {
    const pool = state.solutions;
    if (!pool || !pool.length) return;
    if (state.blitzUsed.size >= pool.length) state.blitzUsed = new Set();
    let word;
    do {
        word = pool[Math.floor(Math.random() * pool.length)];
    } while (state.blitzUsed.has(word) && state.blitzUsed.size < pool.length);
    state.blitzUsed.add(word);
    state.solution = word;
    if (DEBUG) console.log('Blitz solution:', state.solution);

    // Reset the per-word board state (mode flags + score + timer persist across words).
    state.guesses = [];
    state.currentGuess = '';
    state.currentRow = 0;
    state.won = false;
    state.revealedLetters = { correct: {}, present: new Set() };

    initBoard();
    initKeyboard();
    blitzLock = false;
}

// Blitz guess outcome. A solved or exhausted word doesn't end the game — it advances to a
// fresh word after the reveal animation. The run ends only when the timer expires (endBlitz).
function handleBlitzGuess(solved) {
    const revealMs = state.wordLength * 300 + 350; // last tile colors at (n-1)*300 + 300
    if (solved) {
        state.blitzScore++;
        updateBlitzHud();
        showMessage('Correct! +1', 900);
        blitzLock = true;
        scheduleBlitzAdvance(revealMs);
    } else if (state.currentRow === state.maxTries - 1) {
        // Out of tries on this word: flash the answer, then move on (no score).
        showMessage(`Answer: ${state.solution.toUpperCase()}`, 1400);
        blitzLock = true;
        scheduleBlitzAdvance(revealMs + 250);
    } else {
        // Keep going on the same word.
        state.currentRow++;
        state.currentGuess = '';
    }
}

// Advance to the next word after the reveal finishes, unless the run ended (timer expired) in
// the meantime — the guard stops a queued advance from resurrecting the board under the result.
function scheduleBlitzAdvance(delay) {
    setTimeout(() => {
        if (!state.isBlitz || state.gameOver) return;
        nextBlitzWord();
    }, delay);
}

// End the Blitz run when the clock hits zero. Locks the board, records a new best if beaten,
// and shows the run summary. Only ever called by the timer (never per word).
function endBlitz() {
    if (state.gameOver) return; // guard against a double-fire from the interval
    stopBlitzTimer();
    state.gameOver = true;
    blitzLock = true;

    const score = state.blitzScore;
    const prevBest = loadBlitzBest();
    const isNewBest = score > prevBest;
    if (isNewBest) saveBlitzBest(score);

    announce(`Time's up. You solved ${score} ${score === 1 ? 'word' : 'words'}.`);
    setBlitzHudVisible(false);
    showBlitzResult(score, Math.max(score, prevBest), isNewBest);
}

// Render the Blitz run summary (parallel to showResult, but score-based with its own actions).
function showBlitzResult(score, best, isNewBest) {
    const panel = document.getElementById('blitz-result');
    if (!panel) return;
    const icon = document.getElementById('blitz-result-icon');
    const title = document.getElementById('blitz-result-title');
    const finalEl = document.getElementById('blitz-final-score');
    const bestEl = document.getElementById('blitz-best-score');
    const badge = document.getElementById('blitz-best-badge');

    if (icon) icon.textContent = isNewBest ? '🏆' : '🔥';
    if (title) title.textContent = isNewBest ? 'New best!' : "Time's up!";
    if (finalEl) finalEl.textContent = score;
    if (bestEl) bestEl.textContent = best;
    if (badge) badge.style.display = isNewBest ? '' : 'none';

    panel.style.display = 'block';
    setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
}

// ===========================================================================
// Quordle: four boards at once
// ===========================================================================
// Four 5-letter / 9-guess puzzles solved in parallel from a single shared guess.
// Every guess is scored against all four secret words simultaneously; a board freezes
// once solved. You win by solving all four within 9 guesses. The shared on-screen
// keyboard shows the BEST status a letter has reached across the four boards (merged,
// not quadrant-split) to stay consistent with the theme/high-contrast/ARIA model.
// Only the personal best (fewest guesses to clear all four) is persisted — Quordle
// never touches the normal win/streak stats.
const QUORDLE_COUNTS = [2, 4, 8];          // selectable board counts: Dordle / Quordle / Octordle
const QUORDLE_LENGTH = 5;                  // every board is a 5-letter word
const QUORDLE_EXTRA_GUESSES = 5;           // guesses allowed = boards + 5 (so 7 / 9 / 13)
const QUORDLE_NAMES = { 2: 'Dordle', 4: 'Quordle', 8: 'Octordle' };
const QUORDLE_KEY = 'wordleProQuordle';

// Input lock raised during the reveal animation so a fast typist can't submit onto a
// board mid-flip; startingQuordle guards the async word load against a double-start.
let quordleLock = false;
let startingQuordle = false;
const quordle = {
    boards: 4,       // how many boards this run (2/4/8)
    tries: 9,        // guesses allowed this run (boards + QUORDLE_EXTRA_GUESSES)
    solutions: [],   // the secret words, indexed by board
    solved: [],      // bool per board
    solvedRow: [],   // 0-based guess index each board was solved on (drives the summary)
    guesses: [],     // shared guess history (lowercase)
    currentGuess: '' // the row currently being typed
};

// Persisted as { best: { "2":n, "4":n, "8":n }, sel: N }. Per-count best = fewest guesses
// to clear every board (LOWER is better; absent = no win yet). sel = last-picked count.
// A legacy { best: n } value (from the 4-only version) migrates to a 4-board best.
function loadQuordleData() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(QUORDLE_KEY)); } catch (e) { raw = null; }
    const data = { best: {}, sel: 4 };
    if (raw && typeof raw === 'object') {
        if (typeof raw.best === 'number') {
            if (raw.best > 0) data.best['4'] = raw.best; // legacy: best was always the 4-board game
        } else if (raw.best && typeof raw.best === 'object') {
            for (const n of QUORDLE_COUNTS) {
                const v = raw.best[n];
                if (typeof v === 'number' && v > 0) data.best[n] = v;
            }
        }
        if (QUORDLE_COUNTS.includes(raw.sel)) data.sel = raw.sel;
    }
    return data;
}

function saveQuordleData(data) {
    try { localStorage.setItem(QUORDLE_KEY, JSON.stringify(data)); }
    catch (e) { /* storage unavailable — won't persist */ }
}

function loadQuordleBest(boards) {
    const v = loadQuordleData().best[boards];
    return (typeof v === 'number' && v > 0) ? v : 0;
}

function saveQuordleBest(boards, guesses) {
    const data = loadQuordleData();
    data.best[boards] = guesses;
    saveQuordleData(data);
}

function loadQuordleSel() {
    return loadQuordleData().sel;
}

function saveQuordleSel(boards) {
    const data = loadQuordleData();
    data.sel = boards;
    saveQuordleData(data);
}

// Refresh the home-screen Quordle CTA (title + sub-label) and the word-count pills to
// reflect the currently-selected board count and its saved best.
function updateQuordleButton() {
    const sel = loadQuordleSel();
    const tries = sel + QUORDLE_EXTRA_GUESSES;
    const best = loadQuordleBest(sel);
    const title = document.getElementById('quordle-btn-title');
    const sub = document.getElementById('quordle-btn-sub');
    if (title) title.textContent = QUORDLE_NAMES[sel];
    if (sub) {
        sub.textContent = best > 0
            ? `Solve ${sel} words at once · Best ${best}/${tries}`
            : `Solve ${sel} words at once · ${tries} guesses`;
    }
    document.querySelectorAll('.quordle-words .option-btn').forEach(btn => {
        btn.classList.toggle('active', Number(btn.dataset.quordleBoards) === sel);
    });
}

// Screen-reader narration for Quordle (its own live region, since the game screen's is inactive).
function qAnnounce(text) {
    const region = document.getElementById('quordle-sr');
    if (region) region.textContent = text;
}

function qAnnounceGuess(guess, rowIdx) {
    const solvedNow = [];
    for (let b = 0; b < quordle.boards; b++) {
        if (quordle.solvedRow[b] === rowIdx) solvedNow.push(b + 1);
    }
    let msg = `Guess ${rowIdx + 1}: ${guess.toUpperCase()}.`;
    if (solvedNow.length) msg += ` Solved board ${solvedNow.join(', ')}.`;
    qAnnounce(msg);
}

function updateQuordleMeta() {
    const el = document.getElementById('quordle-meta');
    if (!el) return;
    const solvedCount = quordle.solved.filter(Boolean).length;
    el.textContent = `${QUORDLE_NAMES[quordle.boards]} • ${quordle.guesses.length}/${quordle.tries} guesses • ${solvedCount}/${quordle.boards} solved`;
}

function qBoardEl(idx) {
    return document.querySelector(`.quordle-board[data-board="${idx}"]`);
}

function qBoardTiles(idx) {
    const board = qBoardEl(idx);
    return board ? board.querySelectorAll('.tile') : [];
}

// Build quordle.boards boards from scratch (each quordle.tries rows x QUORDLE_LENGTH cols of
// tiles) inside the grid. The grid + main carry data-boards so CSS can pick the layout.
function initQuordleBoards() {
    const grid = document.getElementById('quordle-grid');
    if (!grid) return;
    grid.innerHTML = '';
    grid.setAttribute('data-boards', quordle.boards);
    const main = document.querySelector('.quordle-main');
    if (main) main.setAttribute('data-boards', quordle.boards);
    for (let b = 0; b < quordle.boards; b++) {
        const board = document.createElement('div');
        board.className = 'quordle-board';
        board.setAttribute('data-board', b);
        board.setAttribute('role', 'grid');
        board.setAttribute('aria-label', `Board ${b + 1}: ${quordle.tries} guesses of ${QUORDLE_LENGTH} letters`);
        board.style.setProperty('--cols', QUORDLE_LENGTH);
        for (let i = 0; i < quordle.tries * QUORDLE_LENGTH; i++) {
            const tile = document.createElement('div');
            tile.className = 'tile';
            tile.setAttribute('role', 'gridcell');
            tile.setAttribute('aria-label', 'Empty tile');
            board.appendChild(tile);
        }
        grid.appendChild(board);
    }
}

// Build the shared Quordle keyboard. Mirrors initKeyboard but routes to handleQuordleKey.
function initQuordleKeyboard() {
    const keyboard = document.getElementById('quordle-keyboard');
    if (!keyboard) return;
    const rows = [
        ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
        ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
        ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '⌫']
    ];
    keyboard.innerHTML = '';
    rows.forEach(row => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'keyboard-row';
        row.forEach(key => {
            const button = document.createElement('button');
            button.className = key.length > 1 ? 'key wide' : 'key';
            button.textContent = key;
            button.setAttribute('data-key', key);
            button.setAttribute('aria-label', key === '⌫' ? 'Backspace' : key);
            button.addEventListener('click', () => handleQuordleKey(key));
            rowDiv.appendChild(button);
        });
        keyboard.appendChild(rowDiv);
    });
}

// Pick n distinct random words from a pool (the four secret words are always distinct).
function pickDistinct(pool, n) {
    const picks = [];
    const used = new Set();
    let guard = 0;
    while (picks.length < n && guard < 10000) {
        guard++;
        const w = pool[Math.floor(Math.random() * pool.length)];
        if (!used.has(w)) { used.add(w); picks.push(w); }
    }
    return picks;
}

async function startQuordle(boards) {
    if (startingQuordle) return;
    // Resolve & validate the requested board count (fall back to the saved selection).
    if (!QUORDLE_COUNTS.includes(boards)) boards = loadQuordleSel();
    startingQuordle = true;
    setLoadError(null);

    const sub = document.getElementById('quordle-btn-sub');
    const originalSub = sub ? sub.textContent : '';
    if (sub) sub.textContent = 'Loading…';

    let words;
    try {
        words = await loadWords(QUORDLE_LENGTH);
    } catch (err) {
        console.error(err);
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        setLoadError(offline
            ? 'You appear to be offline. Reconnect, then try again.'
            : "Couldn't load the word list. Check your connection and try again.");
        return;
    } finally {
        if (sub) sub.textContent = originalSub;
        startingQuordle = false;
    }

    // Config for the chosen board count + a clean slate.
    quordle.boards = boards;
    quordle.tries = boards + QUORDLE_EXTRA_GUESSES;
    saveQuordleSel(boards); // remember the pick for the home CTA + next launch
    state.wordLength = QUORDLE_LENGTH;
    state.dictionary = words.guesses;
    state.isDaily = false;
    state.isChallenge = false;
    state.isQuordle = true;
    state.gameOver = false;
    exitBlitzMode(); // tear down any in-progress Blitz run (timer/HUD/lock)

    quordle.solutions = pickDistinct(words.answers, quordle.boards);
    quordle.solved = new Array(quordle.boards).fill(false);
    quordle.solvedRow = new Array(quordle.boards).fill(-1);
    quordle.guesses = [];
    quordle.currentGuess = '';
    quordleLock = false;
    if (DEBUG) console.log('Quordle solutions:', quordle.solutions);

    // Switch to the Quordle screen.
    document.getElementById('home-screen').classList.remove('active');
    document.getElementById('game-screen').classList.remove('active');
    document.getElementById('quordle-screen').classList.add('active');
    scrollToTop();

    initQuordleBoards();
    initQuordleKeyboard();
    updateQuordleMeta();
    const panel = document.getElementById('quordle-result');
    if (panel) panel.style.display = 'none';
}

// Leave Quordle (returning home or starting another mode): clear flags/lock and hide the result.
function exitQuordleMode() {
    state.isQuordle = false;
    quordleLock = false;
    const panel = document.getElementById('quordle-result');
    if (panel) panel.style.display = 'none';
}

function handleQuordleKey(key) {
    if (state.gameOver) return;
    if (quordleLock) return; // ignore input during the reveal animation
    if (key === 'ENTER') {
        submitQuordleGuess();
    } else if (key === '⌫') {
        quordle.currentGuess = quordle.currentGuess.slice(0, -1);
        updateQuordleBoards();
    } else if (quordle.currentGuess.length < QUORDLE_LENGTH) {
        quordle.currentGuess += key.toLowerCase();
        updateQuordleBoards();
    }
}

// Paint the in-progress guess into the active row of every UNSOLVED board (solved boards
// are frozen at their solving row, so they keep their final coloured state).
function updateQuordleBoards() {
    const rowIdx = quordle.guesses.length;
    if (rowIdx >= quordle.tries) return;
    for (let b = 0; b < quordle.boards; b++) {
        if (quordle.solved[b]) continue;
        const tiles = qBoardTiles(b);
        const start = rowIdx * QUORDLE_LENGTH;
        for (let i = 0; i < QUORDLE_LENGTH; i++) {
            const tile = tiles[start + i];
            if (!tile) continue;
            const letter = quordle.currentGuess[i] || '';
            tile.textContent = letter.toUpperCase();
            if (letter) {
                tile.classList.add('filled');
                tile.setAttribute('aria-label', letter.toUpperCase());
            } else {
                tile.classList.remove('filled');
                tile.setAttribute('aria-label', 'Empty tile');
            }
        }
    }
}

function submitQuordleGuess() {
    const guess = quordle.currentGuess;
    if (guess.length !== QUORDLE_LENGTH) {
        showMessage('Not enough letters', 2000, 'quordle-message-container');
        shakeQuordle();
        return;
    }
    if (!state.dictionary.has(guess)) {
        showMessage('Not in word list', 2000, 'quordle-message-container');
        shakeQuordle();
        return;
    }
    // No Hard Mode in Quordle (tracking four boards' hints would be punishing).

    const rowIdx = quordle.guesses.length;
    quordle.guesses.push(guess);
    quordleLock = true; // freeze input until the reveal completes

    // Reveal on every unsolved board; flag any board this guess solves.
    for (let b = 0; b < quordle.boards; b++) {
        if (quordle.solved[b]) continue;
        revealQuordleBoard(b, rowIdx, guess, true);
        if (guess === quordle.solutions[b]) {
            quordle.solved[b] = true;
            quordle.solvedRow[b] = rowIdx;
        }
    }

    updateQuordleKeyboard();
    qAnnounceGuess(guess, rowIdx);
    updateQuordleMeta();

    quordle.currentGuess = '';
    const revealMs = QUORDLE_LENGTH * 300 + 350; // last tile colours at (n-1)*300 + 300
    setTimeout(afterQuordleReveal, revealMs);
}

// Score one board's row and flip its tiles (mirrors revealRow, scoped to a Quordle board).
function revealQuordleBoard(idx, rowIdx, guess, animate = true) {
    const tiles = qBoardTiles(idx);
    const start = rowIdx * QUORDLE_LENGTH;
    const pattern = computePattern(guess, quordle.solutions[idx]); // "21000" (2=correct,1=present,0=absent)
    const CLASS = { '2': 'correct', '1': 'present', '0': 'absent' };

    for (let i = 0; i < QUORDLE_LENGTH; i++) {
        const cls = CLASS[pattern[i]];
        const tile = tiles[start + i];
        if (!tile) continue;
        // Make sure the letter is shown even on a board that wasn't the typing target.
        tile.textContent = guess[i].toUpperCase();
        tile.classList.add('filled');
        if (!animate) {
            tile.classList.add(cls);
            tile.setAttribute('aria-label', `${guess[i].toUpperCase()} ${cls}`);
            continue;
        }
        setTimeout(() => {
            tile.classList.add('flip');
            setTimeout(() => {
                tile.classList.add(cls);
                tile.setAttribute('aria-label', `${guess[i].toUpperCase()} ${cls}`);
            }, 300);
        }, i * 300);
    }
}

// Merged keyboard colouring: recompute each key's BEST status across all guesses x 4 boards.
// Rebuilt from scratch every guess (cheap: <=9x4x5 ops) so a letter that's green on one board
// always wins over absent on another.
function updateQuordleKeyboard() {
    const rank = {}; // letter -> 3 correct / 2 present / 1 absent
    const CLASSRANK = { '2': 3, '1': 2, '0': 1 };
    for (const guess of quordle.guesses) {
        for (let b = 0; b < quordle.boards; b++) {
            const pattern = computePattern(guess, quordle.solutions[b]);
            for (let i = 0; i < guess.length; i++) {
                const letter = guess[i].toUpperCase();
                const r = CLASSRANK[pattern[i]] || 0;
                if (!rank[letter] || r > rank[letter]) rank[letter] = r;
            }
        }
    }
    const NAME = { 3: 'correct', 2: 'present', 1: 'absent' };
    const STATUS = { 3: 'correct', 2: 'wrong position', 1: 'absent' };
    Object.keys(rank).forEach(letter => {
        const key = document.querySelector(`#quordle-keyboard [data-key="${letter}"]`);
        if (!key) return;
        key.classList.remove('correct', 'present', 'absent');
        const cls = NAME[rank[letter]];
        if (cls) key.classList.add(cls);
        key.setAttribute('aria-label', STATUS[rank[letter]] ? `${letter}, ${STATUS[rank[letter]]}` : letter);
    });
}

// After the reveal animation: fade solved boards, then resolve win/loss or unlock for the next guess.
function afterQuordleReveal() {
    if (!state.isQuordle) return;
    for (let b = 0; b < quordle.boards; b++) {
        if (quordle.solved[b]) {
            const el = qBoardEl(b);
            if (el) el.classList.add('solved');
        }
    }
    const solvedCount = quordle.solved.filter(Boolean).length;
    if (solvedCount === quordle.boards) {
        state.gameOver = true;
        const used = quordle.guesses.length;
        const prevBest = loadQuordleBest(quordle.boards);
        const isNewBest = prevBest === 0 || used < prevBest;
        if (isNewBest) saveQuordleBest(quordle.boards, used);
        qAnnounce(`Solved all ${quordle.boards} in ${used} ${used === 1 ? 'guess' : 'guesses'}.`);
        showQuordleResult(true, isNewBest);
    } else if (quordle.guesses.length >= quordle.tries) {
        state.gameOver = true;
        qAnnounce(`Out of guesses. You solved ${solvedCount} of ${quordle.boards}.`);
        showQuordleResult(false, false);
    } else {
        quordleLock = false; // keep playing
    }
    updateQuordleMeta();
}

function shakeQuordle() {
    for (let b = 0; b < quordle.boards; b++) {
        if (quordle.solved[b]) continue;
        const el = qBoardEl(b);
        if (el) el.classList.add('shake');
    }
    setTimeout(() => {
        for (let b = 0; b < quordle.boards; b++) {
            const el = qBoardEl(b);
            if (el) el.classList.remove('shake');
        }
    }, 500);
}

// Render the Quordle run summary (parallel to showBlitzResult): outcome, best, and all four words.
function showQuordleResult(won, isNewBest) {
    const panel = document.getElementById('quordle-result');
    if (!panel) return;
    const icon = document.getElementById('quordle-result-icon');
    const title = document.getElementById('quordle-result-title');
    const summary = document.getElementById('quordle-result-summary');
    const badge = document.getElementById('quordle-best-badge');
    const bestEl = document.getElementById('quordle-best-score');
    const list = document.getElementById('quordle-answers');

    const solvedCount = quordle.solved.filter(Boolean).length;
    const used = quordle.guesses.length;

    if (won) {
        if (icon) icon.textContent = isNewBest ? '🏆' : '🎉';
        if (title) title.textContent = isNewBest ? 'New best!' : `Solved all ${quordle.boards}!`;
        if (summary) summary.textContent = `All ${quordle.boards} solved in ${used} ${used === 1 ? 'guess' : 'guesses'}.`;
    } else {
        if (icon) icon.textContent = '😔';
        if (title) title.textContent = 'Out of guesses';
        if (summary) summary.textContent = `You solved ${solvedCount} of ${quordle.boards}.`;
    }

    const best = loadQuordleBest(quordle.boards);
    if (bestEl) bestEl.textContent = best > 0 ? `${best}/${quordle.tries}` : '—';
    if (badge) badge.style.display = isNewBest ? '' : 'none';

    // List every word: solved ones tag the guess they fell on; missed ones reveal the word.
    if (list) {
        list.innerHTML = '';
        for (let b = 0; b < quordle.boards; b++) {
            const li = document.createElement('li');
            const solved = quordle.solved[b];
            li.className = `quordle-answer ${solved ? 'solved' : 'missed'}`;
            const word = document.createElement('span');
            word.className = 'quordle-answer-word';
            word.textContent = quordle.solutions[b].toUpperCase();
            const tag = document.createElement('span');
            tag.className = 'quordle-answer-tag';
            tag.textContent = solved ? `${quordle.solvedRow[b] + 1}` : '—';
            li.appendChild(word);
            li.appendChild(tag);
            list.appendChild(li);
        }
    }

    panel.style.display = 'block';
    setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
}

// Initialize Game Board
function initBoard() {
    const board = document.getElementById('game-board');
    board.innerHTML = '';
    board.setAttribute('role', 'grid');
    board.setAttribute('aria-label', `Game board: ${state.maxTries} guesses of ${state.wordLength} letters`);
    board.style.gridTemplateColumns = `repeat(${state.wordLength}, 1fr)`;
    board.style.gridTemplateRows = `repeat(${state.maxTries}, 1fr)`;
    board.style.setProperty('--cols', state.wordLength);

    for (let i = 0; i < state.maxTries * state.wordLength; i++) {
        const tile = document.createElement('div');
        tile.className = 'tile';
        tile.setAttribute('role', 'gridcell');
        tile.setAttribute('aria-label', 'Empty tile');
        board.appendChild(tile);
    }
}

// Initialize Keyboard
function initKeyboard() {
    const keyboard = document.getElementById('keyboard');
    const rows = [
        ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
        ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
        ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '⌫']
    ];

    keyboard.innerHTML = '';
    rows.forEach(row => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'keyboard-row';
        row.forEach(key => {
            const button = document.createElement('button');
            button.className = key.length > 1 ? 'key wide' : 'key';
            button.textContent = key;
            button.setAttribute('data-key', key);
            // The "⌫" glyph isn't announced meaningfully, so give it a spoken name.
            button.setAttribute('aria-label', key === '⌫' ? 'Backspace' : key);
            button.addEventListener('click', () => handleKey(key));
            rowDiv.appendChild(button);
        });
        keyboard.appendChild(rowDiv);
    });
}

// Handle Key Input
function handleKey(key) {
    if (state.gameOver) return;
    if (blitzLock) return; // Blitz: ignore input during the reveal/advance window between words

    if (key === 'ENTER') {
        submitGuess();
    } else if (key === '⌫') {
        deleteLetter();
    } else if (state.currentGuess.length < state.wordLength) {
        addLetter(key);
    }
}

// Add Letter
function addLetter(letter) {
    if (state.currentGuess.length < state.wordLength) {
        state.currentGuess += letter.toLowerCase();
        updateBoard();
    }
}

// Delete Letter
function deleteLetter() {
    state.currentGuess = state.currentGuess.slice(0, -1);
    updateBoard();
}

// Update Board Display
function updateBoard() {
    const tiles = document.querySelectorAll('.tile');
    const startIndex = state.currentRow * state.wordLength;

    for (let i = 0; i < state.wordLength; i++) {
        const tile = tiles[startIndex + i];
        const letter = state.currentGuess[i] || '';
        tile.textContent = letter.toUpperCase();

        if (letter) {
            tile.classList.add('filled');
            tile.setAttribute('aria-label', `${letter.toUpperCase()}`);
        } else {
            tile.classList.remove('filled');
            tile.setAttribute('aria-label', 'Empty tile');
        }
    }
}

// Submit Guess
function submitGuess() {
    if (state.currentGuess.length !== state.wordLength) {
        showMessage('Not enough letters');
        shakeRow();
        return;
    }

    if (!state.dictionary.has(state.currentGuess)) {
        showMessage('Not in word list');
        shakeRow();
        return;
    }

    // Medium & Hard: enforce reusing every revealed hint (NYT-style "Hard Mode").
    if (state.difficulty === 'medium' || state.difficulty === 'hard') {
        if (!validateHardMode()) {
            return;
        }
    }

    state.guesses.push(state.currentGuess);
    revealRow();
    updateKeyboard();

    // Blitz runs on its own outcome logic (advance to the next word; the run only ends when
    // the timer expires), so it branches off before the normal single-word win/loss path.
    if (state.isBlitz) {
        handleBlitzGuess(state.currentGuess === state.solution);
        return;
    }

    if (state.currentGuess === state.solution) {
        state.won = true;
        state.gameOver = true;
        setTimeout(() => {
            bounceRow();
            const n = state.guesses.length;
            announce(`You won in ${n} ${n === 1 ? 'guess' : 'guesses'}! The word was ${state.solution.toUpperCase()}.`);
            updateStats(true, state.guesses.length);
            setTimeout(() => showResult(), 1500);
        }, 1500);
    } else if (state.currentRow === state.maxTries - 1) {
        state.gameOver = true;
        setTimeout(() => {
            announce(`Out of tries. The word was ${state.solution.toUpperCase()}.`);
            updateStats(false);
            setTimeout(() => showResult(), 1500);
        }, 1500);
    } else {
        state.currentRow++;
        state.currentGuess = '';
    }

    if (state.isDaily) saveDailyProgress();
}

// Validate Hard Mode
function validateHardMode() {
    // Check if correct letters (green) are in the same position
    for (let pos in state.revealedLetters.correct) {
        const letter = state.revealedLetters.correct[pos];
        if (state.currentGuess[pos] !== letter) {
            showMessage(`Must use ${letter.toUpperCase()} in position ${parseInt(pos) + 1}`);
            shakeRow();
            return false;
        }
    }

    // Check if present letters (yellow) are included
    for (let letter of state.revealedLetters.present) {
        if (!state.currentGuess.includes(letter)) {
            showMessage(`Must include ${letter.toUpperCase()}`);
            shakeRow();
            return false;
        }
    }

    return true;
}

// Reveal Row with Animation
// animate=false paints the row instantly (no flip) — used to rebuild a saved Daily board.
function revealRow(animate = true) {
    const tiles = document.querySelectorAll('.tile');
    const startIndex = state.currentRow * state.wordLength;
    const guess = state.currentGuess;

    // Score via the shared canonical function so the board matches the solver/analysis exactly.
    const pattern = computePattern(guess, state.solution); // e.g. "21000" (2=correct,1=present,0=absent)
    const CLASS = { '2': 'correct', '1': 'present', '0': 'absent' };

    // Record revealed hints (used by Hard-mode validation + the post-game analysis).
    for (let i = 0; i < pattern.length; i++) {
        if (pattern[i] === '2') state.revealedLetters.correct[i] = guess[i];
        else if (pattern[i] === '1') state.revealedLetters.present.add(guess[i]);
    }

    // Narrate this guess for screen readers (skip the silent replay of a saved Daily board).
    if (animate) announceGuess(guess, pattern);

    // Apply flip animations, coloring each tile by its code.
    for (let i = 0; i < state.wordLength; i++) {
        const cls = CLASS[pattern[i]];
        const tile = tiles[startIndex + i];
        if (!animate) {
            // Instant paint (replay): this row was never typed, so set its text too.
            tile.textContent = guess[i].toUpperCase();
            tile.classList.add('filled', cls);
            tile.setAttribute('aria-label', `${guess[i].toUpperCase()} ${cls}`);
            continue;
        }
        setTimeout(() => {
            tile.classList.add('flip');
            setTimeout(() => {
                tile.classList.add(cls);
                tile.setAttribute('aria-label', `${guess[i].toUpperCase()} ${cls}`);
            }, 300);
        }, i * 300);
    }
}

// Update Keyboard Colors
function updateKeyboard() {
    const guess = state.currentGuess;
    const solution = state.solution;

    for (let i = 0; i < guess.length; i++) {
        const letter = guess[i].toUpperCase();
        const key = document.querySelector(`[data-key="${letter}"]`);

        if (!key) continue;

        if (guess[i] === solution[i]) {
            key.classList.remove('present', 'absent');
            key.classList.add('correct');
        } else if (solution.includes(guess[i]) && !key.classList.contains('correct')) {
            key.classList.remove('absent');
            key.classList.add('present');
        } else if (!key.classList.contains('correct') && !key.classList.contains('present')) {
            key.classList.add('absent');
        }

        // Reflect the key's status in its accessible name (e.g. "A, absent").
        const status = key.classList.contains('correct') ? 'correct'
            : key.classList.contains('present') ? 'wrong position'
            : key.classList.contains('absent') ? 'absent' : '';
        key.setAttribute('aria-label', status ? `${letter}, ${status}` : letter);
    }
}

// Animations
function shakeRow() {
    const tiles = document.querySelectorAll('.tile');
    const startIndex = state.currentRow * state.wordLength;

    for (let i = 0; i < state.wordLength; i++) {
        tiles[startIndex + i].parentElement.classList.add('shake');
    }

    setTimeout(() => {
        for (let i = 0; i < state.wordLength; i++) {
            tiles[startIndex + i].parentElement.classList.remove('shake');
        }
    }, 500);
}

function bounceRow() {
    const tiles = document.querySelectorAll('.tile');
    const startIndex = state.currentRow * state.wordLength;

    for (let i = 0; i < state.wordLength; i++) {
        setTimeout(() => {
            tiles[startIndex + i].classList.add('bounce');
        }, i * 100);
    }
}

// Show Message
// containerId lets other modes target their own toast region (e.g. Quordle, whose
// game-screen message-container is hidden because that screen is inactive).
function showMessage(text, duration = 2000, containerId = 'message-container') {
    const container = document.getElementById(containerId);
    if (!container) return;
    const message = document.createElement('div');
    message.className = 'message';
    message.textContent = text;
    container.appendChild(message);

    setTimeout(() => {
        message.remove();
    }, duration);
}

// Screen-reader narration. Writes to the visually-hidden #sr-announcer live region so
// assistive tech reads it aloud. Used for guess feedback and the game outcome (board
// colors alone aren't perceivable without sight).
function announce(text) {
    const region = document.getElementById('sr-announcer');
    if (region) region.textContent = text;
}

function announceGuess(guess, pattern) {
    const WORD = { '2': 'correct', '1': 'wrong position', '0': 'absent' };
    const parts = [];
    for (let i = 0; i < guess.length; i++) {
        parts.push(`${guess[i].toUpperCase()} ${WORD[pattern[i]] || 'absent'}`);
    }
    announce(`Row ${state.currentRow + 1}: ${parts.join(', ')}`);
}

// Show Result Display
function showResult() {
    const resultDisplay = document.getElementById('result-display');
    const resultIcon = document.getElementById('result-icon');
    const resultTitle = document.getElementById('result-title');
    const resultAnswer = document.getElementById('result-answer');
    const resultStats = document.getElementById('result-stats');

    if (state.won) {
        resultIcon.textContent = '🎉';
        resultTitle.textContent = 'Excellent!';
    } else {
        resultIcon.textContent = '😔';
        resultTitle.textContent = 'Better luck next time';
    }

    resultAnswer.textContent = state.solution.toUpperCase();

    // Summary stats. The just-finished game's guess count is conveyed by the
    // highlighted bar in the distribution chart below, so it isn't repeated here.
    const winPct = stats.played ? Math.round((stats.won / stats.played) * 100) : 0;
    resultStats.innerHTML = `
        <div class="stat-item">
            <div class="stat-value">${stats.played}</div>
            <div class="stat-label">Played</div>
        </div>
        <div class="stat-item">
            <div class="stat-value">${winPct}</div>
            <div class="stat-label">Win %</div>
        </div>
        <div class="stat-item">
            <div class="stat-value">${stats.currentStreak}</div>
            <div class="stat-label">Streak</div>
        </div>
        <div class="stat-item">
            <div class="stat-value">${stats.maxStreak}</div>
            <div class="stat-label">Max</div>
        </div>
    `;
    renderDistribution();

    // Daily Challenge: you can't replay today, so swap "Play Again" for a come-back note.
    const playAgainBtn = document.getElementById('play-again-btn');
    const shareBtn = document.getElementById('share-result-btn');
    const copyBtn = document.getElementById('copy-result-btn');
    const challengeBtn = document.getElementById('challenge-result-btn');
    const actions = document.querySelector('.result-actions');
    let dailyNote = document.getElementById('daily-note');
    if (state.isDaily) {
        if (playAgainBtn) playAgainBtn.style.display = 'none';
        if (shareBtn) shareBtn.style.display = '';
        if (copyBtn) copyBtn.style.display = '';
        if (challengeBtn) challengeBtn.style.display = 'none'; // daily is the same word for everyone
        resetActionButton(shareBtn);
        resetActionButton(copyBtn);
        if (actions) actions.classList.add('is-daily');
        if (!dailyNote) {
            dailyNote = document.createElement('p');
            dailyNote.id = 'daily-note';
            dailyNote.className = 'daily-note';
            if (actions && actions.parentElement) actions.parentElement.insertBefore(dailyNote, actions);
        }
        if (dailyNote) {
            dailyNote.textContent = 'Come back tomorrow for a new word.';
            dailyNote.style.display = '';
        }
    } else {
        if (playAgainBtn) playAgainBtn.style.display = '';
        if (shareBtn) shareBtn.style.display = 'none';
        if (copyBtn) copyBtn.style.display = 'none';
        if (challengeBtn) { challengeBtn.style.display = ''; resetActionButton(challengeBtn); }
        if (actions) actions.classList.remove('is-daily');
        if (dailyNote) dailyNote.style.display = 'none';
    }

    resultDisplay.style.display = 'block';

    // Scroll to result
    setTimeout(() => {
        resultDisplay.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
}

// Render the guess-distribution chart on the result screen. One row per guess count from
// 1..top, where `top` spans at least this game's max tries so the just-finished bar has
// context (games of different lengths share one chart). Bar widths are scaled to the most
// common count; the bar matching this game's winning guess count is highlighted.
function renderDistribution() {
    const host = document.getElementById('result-dist');
    if (!host) return;

    const dist = stats.dist || {};
    let maxBucket = 0, maxCount = 0;
    for (const key in dist) {
        const n = parseInt(key, 10);
        const c = dist[key];
        if (n > 0 && c > 0) {
            if (n > maxBucket) maxBucket = n;
            if (c > maxCount) maxCount = c;
        }
    }
    const top = Math.max(maxBucket, state.maxTries || 0, 1);
    const denom = maxCount || 1;                       // avoid divide-by-zero when no wins yet
    const highlight = state.won ? state.guesses.length : -1;

    let rows = '';
    for (let i = 1; i <= top; i++) {
        const count = dist[i] || 0;
        const width = Math.round((count / denom) * 100);
        const cls = i === highlight ? 'dist-bar current' : 'dist-bar';
        // Final width is set inline so the chart is correct regardless of timing; the
        // CSS `dist-grow` keyframe animates it in from zero (and is a no-op under
        // prefers-reduced-motion). min-width keeps the count readable on tiny bars.
        rows += `
            <div class="dist-row">
                <span class="dist-index">${i}</span>
                <span class="dist-track">
                    <span class="${cls}" style="width: ${width}%;">${count}</span>
                </span>
            </div>`;
    }
    host.innerHTML = `<div class="dist-title">Guess Distribution</div>${rows}`;
}

// ── Daily Challenge: share results ──
// Build the classic emoji grid (🟩🟨⬛) from the player's guesses, with a title,
// score line, and a link back to the game. The same text feeds the native share
// sheet and the clipboard, so every path produces identical, recognizable output.
// Patterns come from the shared scorer (computePattern), so the grid always matches
// the colors shown on the board.
function buildShareText() {
    const EMOJI = { '2': '🟩', '1': '🟨', '0': '⬛' };
    const dateLabel = state.dailyDate
        ? new Date(state.dailyDate + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : '';
    const score = state.won ? `${state.guesses.length}/${state.maxTries}` : `X/${state.maxTries}`;
    const grid = state.guesses
        .map(g => computePattern(g, state.solution).split('').map(c => EMOJI[c] || '⬛').join(''))
        .join('\n');
    // Current page URL (no query/hash) — resolves to the live site when deployed.
    const link = location.origin + location.pathname;
    return `Wordle Pro — Daily${dateLabel ? ' ' + dateLabel : ''}\n${score}\n\n${grid}\n\n${link}`;
}

// Share button: try the OS share sheet first (the user chooses the destination —
// nothing is sent automatically); fall back to copying the same text.
async function shareDailyResult() {
    const text = buildShareText();
    if (navigator.share) {
        try {
            await navigator.share({ text });
            return; // the share sheet handled it
        } catch (err) {
            if (err && err.name === 'AbortError') return; // user dismissed the sheet
            // any other error: fall through to the clipboard
        }
    }
    copyToClipboard(text, document.getElementById('share-result-btn'));
}

// Copy button: copy the share text straight to the clipboard (no share sheet).
function copyDailyResult() {
    copyToClipboard(buildShareText(), document.getElementById('copy-result-btn'));
}

// Shared clipboard write with a legacy fallback. Shows "Copied!" feedback on the
// button that triggered it.
async function copyToClipboard(text, btn) {
    let copied = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(text); copied = true; }
        catch (err) { copied = legacyCopy(text); }
    } else {
        copied = legacyCopy(text);
    }
    if (copied) showCopied(btn);
    else showMessage('Could not copy results');
}

// Clipboard fallback for browsers without the async Clipboard API (or when it's blocked).
function legacyCopy(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch (e) {
        return false;
    }
}

// Briefly swap a result-action button to a "Copied!" success state, then restore it.
function showCopied(btn) {
    if (!btn) { showMessage('Copied results to clipboard'); return; }
    const label = btn.querySelector('.btn-label');
    if (label) label.textContent = 'Copied!';
    btn.classList.add('copied');
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => resetActionButton(btn), 1800);
}

// Restore a result-action button to its default label (from data-label) and style.
function resetActionButton(btn) {
    if (!btn) return;
    clearTimeout(btn._copyTimer);
    btn.classList.remove('copied');
    const label = btn.querySelector('.btn-label');
    if (label && btn.dataset.label) label.textContent = btn.dataset.label;
}

// ── Challenge a friend ──
// Encode the just-played puzzle (length, tries, difficulty, word) into a shareable link so a
// friend plays the exact same game. The payload is base64url'd — not for secrecy, just so the
// answer isn't sitting in plain sight in a link preview. No backend: the receiver reconstructs
// the puzzle entirely from the URL plus the same word list this app already ships.
function b64urlEncode(str) {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return atob(s);
}

function buildChallengeUrl() {
    const payload = `${state.wordLength}|${state.maxTries}|${state.difficulty}|${state.solution}`;
    return `${location.origin + location.pathname}?challenge=${b64urlEncode(payload)}`;
}

// Parse + validate the ?challenge= token. Every field is range/format-checked and the word
// length must match, so a malformed or tampered link can never launch a broken game.
function parseChallengeParam() {
    const token = new URLSearchParams(location.search).get('challenge');
    if (!token) return null;
    let raw;
    try { raw = b64urlDecode(token); } catch (e) { return null; }
    const parts = raw.split('|');
    if (parts.length !== 4) return null;
    const len = parseInt(parts[0], 10);
    const tries = parseInt(parts[1], 10);
    const diff = parts[2];
    const word = (parts[3] || '').toLowerCase();
    if (!(len >= 4 && len <= 8)) return null;
    if (!(tries >= 3 && tries <= 10)) return null;
    if (!DIFFICULTY_DESCRIPTIONS[diff]) return null;
    if (!/^[a-z]+$/.test(word) || word.length !== len) return null;
    return { len, tries, diff, word };
}

async function challengeFriend() {
    const url = buildChallengeUrl();
    const text = `Can you beat me at Wordle Pro? Try the exact ${state.wordLength}-letter word I just played:`;
    if (navigator.share) {
        try {
            await navigator.share({ title: 'Wordle Pro challenge', text, url });
            return; // the share sheet handled it
        } catch (err) {
            if (err && err.name === 'AbortError') return; // user dismissed the sheet
        }
    }
    copyToClipboard(`${text}\n${url}`, document.getElementById('challenge-result-btn'));
}

// Statistics
function updateStats(won, numGuesses) {
    stats.played++;
    if (won) {
        stats.won++;
        stats.currentStreak++;
        stats.maxStreak = Math.max(stats.maxStreak, stats.currentStreak);
        // Tally how many guesses this win took for the distribution chart.
        if (numGuesses > 0) stats.dist[numGuesses] = (stats.dist[numGuesses] || 0) + 1;
    } else {
        stats.currentStreak = 0;
    }
    localStorage.setItem('wordleProStats', JSON.stringify(stats));
}

// Analysis
// Post-game breakdown. Two things make this accurate rather than cosmetic:
//   1. Tiles are colored with the SAME feedback logic as the live board
//      (computePattern), so greens/yellows/greys always match what was shown.
//   2. Each guess is scored with real solver insight: how many answers were still
//      possible before vs after the clue, and how much information that revealed
//      (bits = log2(before/after)). The candidate pool is the same frequency-ordered
//      answers list the game draws solutions from.
function displayAnalysis() {
    if (!state.gameOver || state.guesses.length === 0) return;

    const content = document.getElementById('analysis-content');
    content.innerHTML = '';

    // Candidate universe = the pool the secret was actually drawn from (common answers on
    // Easy/Medium, the full dictionary on Hard) so the narrowing math stays honest.
    const pool = (state.solutions && state.solutions.length)
        ? state.solutions
        : ((wordCache[state.wordLength] && wordCache[state.wordLength].answers) || []);
    const startCount = pool.length;

    // Walk the guesses, shrinking the candidate pool one feedback pattern at a time.
    // `candidates` always already satisfies every earlier clue, so each step only has
    // to apply the current guess's pattern.
    let candidates = pool.slice();
    const steps = state.guesses.map((guess) => {
        const pattern = computePattern(guess, state.solution);
        const before = candidates.length;
        candidates = candidates.filter(c => computePattern(guess, c) === pattern);
        return { guess, pattern, before, after: candidates.length };
    });

    // Summary header.
    const summary = document.createElement('div');
    summary.className = 'analysis-summary';
    const resultLabel = state.won
        ? `Solved in ${state.guesses.length} / ${state.maxTries}`
        : `Out of tries`;
    const subText = startCount
        ? `${startCount.toLocaleString()} possible ${state.wordLength}-letter words at the start`
        : `Word list unavailable — showing letter feedback only`;
    summary.innerHTML = `
        <span class="analysis-summary-icon">${state.won ? '🏆' : '💡'}</span>
        <div>
            <div class="analysis-summary-title">${resultLabel}</div>
            <div class="analysis-summary-sub">${subText}</div>
        </div>`;
    content.appendChild(summary);

    // Per-guess cards.
    steps.forEach((step, index) => {
        const { guess, pattern, before, after } = step;
        const hasPool = startCount > 0 && before > 0;
        const bits = (hasPool && after > 0) ? Math.log2(before / after) : 0;

        const stepDiv = document.createElement('div');
        stepDiv.className = 'analysis-step';

        let html = `<div class="analysis-head">
            <h4>Guess ${index + 1}</h4>
            ${hasPool ? `<span class="analysis-badge">+${bits.toFixed(1)} bits</span>` : ''}
        </div>`;

        html += '<div class="analysis-guess">';
        for (let i = 0; i < guess.length; i++) {
            const cls = pattern[i] === '2' ? 'correct' : pattern[i] === '1' ? 'present' : 'absent';
            html += `<div class="analysis-tile ${cls}">${guess[i].toUpperCase()}</div>`;
        }
        html += '</div>';

        if (hasPool) {
            html += `<div class="analysis-stats-row">
                <div class="analysis-stat">
                    <span class="analysis-stat-value">${before.toLocaleString()} &rarr; ${after.toLocaleString()}</span>
                    <span class="analysis-stat-label">possible answers</span>
                </div>
            </div>`;
        }

        html += `<div class="suggestion-text">${analyzeGuess(step, hasPool)}</div>`;
        stepDiv.innerHTML = html;
        content.appendChild(stepDiv);
    });
}

// Turns one guess's outcome into a short, honest takeaway. Uses the candidate
// narrowing when the word pool is available, and always falls back to the raw
// green/yellow feedback so it works even if the list failed to load.
function analyzeGuess(step, hasPool) {
    const { guess, pattern, before, after } = step;
    if (guess === state.solution) return '✓ Nailed it — this was the answer.';

    const greens = (pattern.match(/2/g) || []).length;
    const yellows = (pattern.match(/1/g) || []).length;

    const hints = [];
    if (greens) hints.push(`${greens} in the right spot`);
    if (yellows) hints.push(`${yellows} in the word but misplaced`);
    const hintText = hints.length ? ` (${hints.join(', ')})` : '';

    if (!hasPool) {
        if (greens || yellows) return `${greens} green, ${yellows} yellow.`;
        return `No letters matched — try a fresh set of letters.`;
    }

    const reduction = before > 0 ? 1 - after / before : 0;
    const pct = Math.floor(reduction * 100); // floor so we never claim 100% while words remain

    let quality;
    if (after <= 1) quality = 'That left just one possibility — the answer was locked in.';
    else if (reduction >= 0.9) quality = `Excellent — ruled out ${pct}% of the remaining words.`;
    else if (reduction >= 0.6) quality = `Strong — cut the field by ${pct}%.`;
    else if (reduction >= 0.3) quality = `Decent — ${pct}% fewer options to weigh.`;
    else if (reduction > 0) quality = `Modest — only ${pct}% narrower.`;
    else quality = `No new information — the field didn't shrink.`;

    return `${quality}${hintText}`;
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    setupHomeScreen();

    // Back button
    document.getElementById('back-btn').addEventListener('click', () => {
        exitBlitzMode(); // stop the clock + hide Blitz UI if a run was in progress
        exitQuordleMode();
        document.getElementById('game-screen').classList.remove('active');
        document.getElementById('home-screen').classList.add('active');
        scrollToTop();
        updateStatsPreview();
        updateDailyButton();
        updateBlitzButton();
    });

    // Theme toggle (game header + home screen share one handler)
    function toggleTheme() {
        const theme = document.documentElement.getAttribute('data-theme');
        const newTheme = theme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    }
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
    document.getElementById('home-theme-toggle').addEventListener('click', toggleTheme);

    // High-contrast toggle (home settings card). Flips the data-contrast attribute, persists
    // the choice, and keeps the switch's accessible state + label in sync.
    const contrastToggle = document.getElementById('contrast-toggle');
    function syncContrastToggle() {
        const on = document.documentElement.getAttribute('data-contrast') === 'high';
        contrastToggle.setAttribute('aria-checked', on ? 'true' : 'false');
        const stateLabel = contrastToggle.querySelector('.contrast-toggle-state');
        if (stateLabel) stateLabel.textContent = on ? 'On' : 'Off';
    }
    if (contrastToggle) {
        syncContrastToggle();
        contrastToggle.addEventListener('click', () => {
            const on = document.documentElement.getAttribute('data-contrast') === 'high';
            if (on) {
                document.documentElement.removeAttribute('data-contrast');
            } else {
                document.documentElement.setAttribute('data-contrast', 'high');
            }
            try { localStorage.setItem(CONTRAST_KEY, on ? 'normal' : 'high'); } catch (e) { /* storage unavailable */ }
            syncContrastToggle();
        });
    }

    // How to Play guide ("?" button on the home screen; closes via its own scoped controls)
    document.getElementById('home-help-btn').addEventListener('click', openHelp);
    document.querySelectorAll('[data-close-help]').forEach(el => {
        el.addEventListener('click', closeHelp);
    });

    // Play again button
    document.getElementById('play-again-btn').addEventListener('click', () => {
        startGame();
    });

    // View analysis button
    document.getElementById('view-analysis-btn').addEventListener('click', () => {
        displayAnalysis();
        document.getElementById('analysis-modal').classList.add('active');
    });

    // Share / Copy results (Daily Challenge)
    const shareBtn = document.getElementById('share-result-btn');
    if (shareBtn) shareBtn.addEventListener('click', shareDailyResult);
    const copyBtn = document.getElementById('copy-result-btn');
    if (copyBtn) copyBtn.addEventListener('click', copyDailyResult);

    // Challenge a friend (non-daily games): share/copy a link to this exact puzzle.
    const challengeBtn = document.getElementById('challenge-result-btn');
    if (challengeBtn) challengeBtn.addEventListener('click', challengeFriend);

    // Modal close
    document.querySelector('.modal-close').addEventListener('click', () => {
        document.getElementById('analysis-modal').classList.remove('active');
    });

    document.querySelector('.modal-backdrop').addEventListener('click', () => {
        document.getElementById('analysis-modal').classList.remove('active');
    });

    // Daily Challenge
    const dailyBtn = document.getElementById('daily-challenge-btn');
    if (dailyBtn) dailyBtn.addEventListener('click', startDailyChallenge);

    // Blitz / Time Attack: home CTA starts a run; the result panel offers Play Again + Home.
    const blitzBtn = document.getElementById('blitz-challenge-btn');
    if (blitzBtn) blitzBtn.addEventListener('click', startBlitz);
    const blitzAgainBtn = document.getElementById('blitz-again-btn');
    if (blitzAgainBtn) blitzAgainBtn.addEventListener('click', startBlitz);
    const blitzHomeBtn = document.getElementById('blitz-home-btn');
    if (blitzHomeBtn) blitzHomeBtn.addEventListener('click', () => {
        exitBlitzMode();
        document.getElementById('game-screen').classList.remove('active');
        document.getElementById('home-screen').classList.add('active');
        scrollToTop();
        updateStatsPreview();
        updateDailyButton();
        updateBlitzButton();
    });

    // Quordle: home CTA starts a run; the result panel offers Play Again + Home. The header
    // Back button and Home both return to the home screen and tear down the run.
    const quordleBtn = document.getElementById('quordle-challenge-btn');
    if (quordleBtn) quordleBtn.addEventListener('click', () => startQuordle(loadQuordleSel()));
    const quordleAgainBtn = document.getElementById('quordle-again-btn');
    if (quordleAgainBtn) quordleAgainBtn.addEventListener('click', () => startQuordle(quordle.boards)); // replay same count
    // Word-count pills (2 / 4 / 8): pick the board count for the next run. updateQuordleButton
    // re-syncs the active pill + CTA title/sub from the saved selection.
    document.querySelectorAll('.quordle-words .option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const n = Number(btn.dataset.quordleBoards);
            if (!QUORDLE_COUNTS.includes(n)) return;
            saveQuordleSel(n);
            updateQuordleButton();
        });
    });
    function leaveQuordle() {
        exitQuordleMode();
        document.getElementById('quordle-screen').classList.remove('active');
        document.getElementById('home-screen').classList.add('active');
        scrollToTop();
        updateStatsPreview();
        updateDailyButton();
        updateBlitzButton();
        updateQuordleButton();
    }
    const quordleHomeBtn = document.getElementById('quordle-home-btn');
    if (quordleHomeBtn) quordleHomeBtn.addEventListener('click', leaveQuordle);
    const quordleBackBtn = document.getElementById('quordle-back-btn');
    if (quordleBackBtn) quordleBackBtn.addEventListener('click', leaveQuordle);
    const quordleThemeToggle = document.getElementById('quordle-theme-toggle');
    if (quordleThemeToggle) quordleThemeToggle.addEventListener('click', toggleTheme);

    // Best plays (optimal-play suggester)
    document.getElementById('best-plays-btn').addEventListener('click', showBestPlays);
    document.querySelectorAll('[data-close-suggest]').forEach(el => {
        el.addEventListener('click', closeSuggestModal);
    });

    // Keyboard events
    document.addEventListener('keydown', (e) => {
        // While the How-to-Play guide is open, swallow keys (so the board behind it doesn't
        // type) and let Escape dismiss it. Checked before the game-over guard so it also
        // works on the result screen.
        if (document.getElementById('help-modal').classList.contains('active')) {
            if (e.key === 'Escape') closeHelp();
            return;
        }
        if (state.gameOver) return;
        if (document.getElementById('suggest-modal').classList.contains('active')) return;
        if (document.getElementById('game-screen').classList.contains('active')) {
            if (e.key === 'Enter') {
                handleKey('ENTER');
            } else if (e.key === 'Backspace') {
                handleKey('⌫');
            } else if (/^[a-zA-Z]$/.test(e.key)) {
                handleKey(e.key.toUpperCase());
            }
        } else if (document.getElementById('quordle-screen').classList.contains('active')) {
            if (e.key === 'Enter') {
                handleQuordleKey('ENTER');
            } else if (e.key === 'Backspace') {
                handleQuordleKey('⌫');
            } else if (/^[a-zA-Z]$/.test(e.key)) {
                handleQuordleKey(e.key.toUpperCase());
            }
        }
    });

    // If opened from a "Challenge a friend" link, apply that puzzle's config and launch it
    // straight away. The token is then stripped from the address bar so Play Again / refresh
    // behave like a normal session (other params, e.g. debug, are preserved).
    const challenge = parseChallengeParam();
    if (challenge) {
        applyHomeSettings(challenge.len, challenge.tries, challenge.diff);
        const url = new URL(location.href);
        url.searchParams.delete('challenge');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
        startGame(challenge.word);
    } else if (!localStorage.getItem(HELP_SEEN_KEY)) {
        // First-ever visit (and not arriving via a challenge link): show the rules once.
        openHelp();
    }
});

// NOTE: Double-tap-to-zoom is already disabled via the viewport meta (maximum-scale=1.0,
// user-scalable=no) and `touch-action: manipulation` on the keyboard/keys. We deliberately do
// NOT add a global `touchend` preventDefault here. Such a handler cancels the synthesized
// `click` on a key whenever two taps land within ~300ms — i.e. during normal fast typing —
// silently dropping keystrokes and making the keyboard feel laggy/unresponsive on mobile.
