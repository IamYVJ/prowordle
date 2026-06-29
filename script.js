// Wordle Pro - Main Game Script
// Modern 4-letter Wordle clone with enhanced UI

// Game State
const state = {
    solution: '',
    guesses: [],
    currentGuess: '',
    currentRow: 0,
    gameOver: false,
    won: false,
    wordLength: 4,
    maxTries: 6,
    difficulty: 'easy',
    dictionary: new Set(), // allowed guesses for the current length (O(1) lookup)
    solutions: [],         // common-answer pool for the current length
    revealedLetters: { correct: {}, present: new Set() }
};

// Statistics
let stats = JSON.parse(localStorage.getItem('wordleProStats')) || {
    played: 0,
    won: 0,
    currentStreak: 0,
    maxStreak: 0
};

// Theme Management
const currentTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', currentTheme);

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
    if (state.gameOver || bestPlaysBusy) return;
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
        });
    });

    // Tries Slider
    const triesSlider = document.getElementById('home-tries');
    const triesDisplay = document.getElementById('tries-display');
    triesSlider.addEventListener('input', (e) => {
        state.maxTries = parseInt(e.target.value);
        triesDisplay.textContent = state.maxTries;
    });

    // Difficulty Selection
    const difficultyButtons = document.querySelectorAll('[data-difficulty]');
    const difficultyDesc = document.getElementById('difficulty-description');
    const descriptions = {
        easy: 'Any valid word is allowed',
        medium: 'Must reuse every revealed hint',
        hard: 'Rare words allowed — plus you must reuse every hint'
    };

    difficultyButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            difficultyButtons.forEach(b => b.classList.remove('active'));
            e.target.closest('.difficulty-btn').classList.add('active');
            state.difficulty = e.target.closest('.difficulty-btn').dataset.difficulty;
            difficultyDesc.textContent = descriptions[state.difficulty];
        });
    });

    // Start Game Button
    document.getElementById('start-game-btn').addEventListener('click', startGame);

    // Retry button inside the word-list load-error banner (re-attempts the start).
    const retryLoadBtn = document.getElementById('retry-load-btn');
    if (retryLoadBtn) retryLoadBtn.addEventListener('click', startGame);
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

async function startGame() {
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
    state.revealedLetters = { correct: {}, present: new Set() };

    // Select random word
    state.solution = state.solutions[Math.floor(Math.random() * state.solutions.length)];
    if (DEBUG) console.log('Solution:', state.solution);

    // Switch screens
    document.getElementById('home-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');

    // Update game info
    const difficultyNames = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
    document.getElementById('game-config').textContent = 
        `${state.wordLength} Letters • ${state.maxTries} Tries • ${difficultyNames[state.difficulty]}`;

    // Initialize board and keyboard
    initBoard();
    initKeyboard();

    // Hide result display
    document.getElementById('result-display').style.display = 'none';
}

// Initialize Game Board
function initBoard() {
    const board = document.getElementById('game-board');
    board.innerHTML = '';
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
            button.setAttribute('aria-label', key);
            button.addEventListener('click', () => handleKey(key));
            rowDiv.appendChild(button);
        });
        keyboard.appendChild(rowDiv);
    });
}

// Handle Key Input
function handleKey(key) {
    if (state.gameOver) return;

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

    if (state.currentGuess === state.solution) {
        state.won = true;
        state.gameOver = true;
        setTimeout(() => {
            bounceRow();
            updateStats(true);
            setTimeout(() => showResult(), 1500);
        }, 1500);
    } else if (state.currentRow === state.maxTries - 1) {
        state.gameOver = true;
        setTimeout(() => {
            updateStats(false);
            setTimeout(() => showResult(), 1500);
        }, 1500);
    } else {
        state.currentRow++;
        state.currentGuess = '';
    }
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
function revealRow() {
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

    // Apply flip animations, coloring each tile by its code.
    for (let i = 0; i < state.wordLength; i++) {
        const cls = CLASS[pattern[i]];
        setTimeout(() => {
            const tile = tiles[startIndex + i];
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
function showMessage(text, duration = 2000) {
    const container = document.getElementById('message-container');
    const message = document.createElement('div');
    message.className = 'message';
    message.textContent = text;
    container.appendChild(message);

    setTimeout(() => {
        message.remove();
    }, duration);
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

    // Show stats
    resultStats.innerHTML = `
        <div class="stat-item">
            <div class="stat-value">${state.won ? state.currentRow + 1 : '-'}</div>
            <div class="stat-label">Guesses</div>
        </div>
        <div class="stat-item">
            <div class="stat-value">${stats.played}</div>
            <div class="stat-label">Played</div>
        </div>
        <div class="stat-item">
            <div class="stat-value">${stats.currentStreak}</div>
            <div class="stat-label">Streak</div>
        </div>
    `;

    resultDisplay.style.display = 'block';

    // Scroll to result
    setTimeout(() => {
        resultDisplay.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
}

// Statistics
function updateStats(won) {
    stats.played++;
    if (won) {
        stats.won++;
        stats.currentStreak++;
        stats.maxStreak = Math.max(stats.maxStreak, stats.currentStreak);
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
        document.getElementById('game-screen').classList.remove('active');
        document.getElementById('home-screen').classList.add('active');
        updateStatsPreview();
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

    // Play again button
    document.getElementById('play-again-btn').addEventListener('click', () => {
        startGame();
    });

    // View analysis button
    document.getElementById('view-analysis-btn').addEventListener('click', () => {
        displayAnalysis();
        document.getElementById('analysis-modal').classList.add('active');
    });

    // Modal close
    document.querySelector('.modal-close').addEventListener('click', () => {
        document.getElementById('analysis-modal').classList.remove('active');
    });

    document.querySelector('.modal-backdrop').addEventListener('click', () => {
        document.getElementById('analysis-modal').classList.remove('active');
    });

    // Best plays (optimal-play suggester)
    document.getElementById('best-plays-btn').addEventListener('click', showBestPlays);
    document.querySelectorAll('[data-close-suggest]').forEach(el => {
        el.addEventListener('click', closeSuggestModal);
    });

    // Keyboard events
    document.addEventListener('keydown', (e) => {
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
        }
    });
});

// Prevent zoom on double tap (iOS)
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
        e.preventDefault();
    }
    lastTouchEnd = now;
}, false);
