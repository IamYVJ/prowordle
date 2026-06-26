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
    dictionary: [],
    solutions: [],
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
const currentTheme = localStorage.getItem('theme') || 'light';
document.documentElement.setAttribute('data-theme', currentTheme);

// Loading Screen
window.addEventListener('load', () => {
    setTimeout(() => {
        state.dictionary = WORDS_4;
        state.solutions = WORDS_4;

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

// Home Screen Setup
function setupHomeScreen() {
    // Word Length Selection (fixed to 4)
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
        medium: 'Must use all revealed hints (Hard Mode)',
        hard: 'Includes obscure dictionary words'
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
function startGame() {
    // Reset state
    state.guesses = [];
    state.currentGuess = '';
    state.currentRow = 0;
    state.gameOver = false;
    state.won = false;
    state.revealedLetters = { correct: {}, present: new Set() };

    // Select random word
    state.solution = state.solutions[Math.floor(Math.random() * state.solutions.length)];
    console.log('Solution:', state.solution); // For testing

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

    if (!state.dictionary.includes(state.currentGuess)) {
        showMessage('Not in word list');
        shakeRow();
        return;
    }

    // Medium difficulty: Check if revealed hints are used
    if (state.difficulty === 'medium') {
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
    const solution = state.solution;

    // Count letter frequency in solution
    const solutionLetters = {};
    for (let letter of solution) {
        solutionLetters[letter] = (solutionLetters[letter] || 0) + 1;
    }

    // First pass: mark correct letters
    const result = Array(state.wordLength).fill('absent');
    for (let i = 0; i < state.wordLength; i++) {
        if (guess[i] === solution[i]) {
            result[i] = 'correct';
            solutionLetters[guess[i]]--;
            state.revealedLetters.correct[i] = guess[i];
        }
    }

    // Second pass: mark present letters
    for (let i = 0; i < state.wordLength; i++) {
        if (result[i] !== 'correct' && solution.includes(guess[i]) && solutionLetters[guess[i]] > 0) {
            result[i] = 'present';
            solutionLetters[guess[i]]--;
            state.revealedLetters.present.add(guess[i]);
        }
    }

    // Apply animations
    for (let i = 0; i < state.wordLength; i++) {
        setTimeout(() => {
            const tile = tiles[startIndex + i];
            tile.classList.add('flip');
            setTimeout(() => {
                tile.classList.add(result[i]);
                tile.setAttribute('aria-label', `${guess[i].toUpperCase()} ${result[i]}`);
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
function displayAnalysis() {
    if (!state.gameOver || state.guesses.length === 0) return;

    const content = document.getElementById('analysis-content');
    content.innerHTML = '';

    state.guesses.forEach((guess, index) => {
        const analysis = analyzeGuess(guess, index);
        const stepDiv = document.createElement('div');
        stepDiv.className = 'analysis-step';

        let html = `<h4>Guess ${index + 1}</h4>`;
        html += '<div class="analysis-guess">';

        for (let i = 0; i < guess.length; i++) {
            const letter = guess[i].toUpperCase();
            let className = 'analysis-tile';
            let bgColor = 'var(--absent)';
            if (guess[i] === state.solution[i]) {
                bgColor = 'var(--correct)';
            } else if (state.solution.includes(guess[i])) {
                bgColor = 'var(--present)';
            }
            html += `<div class="${className}" style="background-color: ${bgColor};">${letter}</div>`;
        }

        html += '</div>';
        html += `<div class="suggestion-text">${analysis}</div>`;
        stepDiv.innerHTML = html;
        content.appendChild(stepDiv);
    });
}

// Simple Analysis Algorithm
function analyzeGuess(guess, guessNumber) {
    if (guess === state.solution) {
        return '✓ Correct! Perfect guess.';
    }

    let correctPositions = 0;
    let correctLetters = 0;

    for (let i = 0; i < guess.length; i++) {
        if (guess[i] === state.solution[i]) {
            correctPositions++;
        } else if (state.solution.includes(guess[i])) {
            correctLetters++;
        }
    }

    if (guessNumber === 0) {
        if (correctPositions > 0) {
            return `Good start! ${correctPositions} correct position(s). ${correctLetters > 0 ? `${correctLetters} letter(s) in wrong position.` : ''}`;
        } else if (correctLetters > 0) {
            return `${correctLetters} correct letter(s) but wrong positions. Try rearranging.`;
        } else {
            return `No matches. Try words with common vowels like E, A, O.`;
        }
    } else {
        if (correctPositions >= guess.length - 1) {
            return `Very close! ${correctPositions} correct positions. Focus on the remaining letter(s).`;
        } else if (correctPositions > 0 || correctLetters > 0) {
            return `Progress: ${correctPositions} correct position(s), ${correctLetters} wrong position(s). Use the revealed hints.`;
        } else {
            return `Try completely different letters. Avoid: ${guess.toUpperCase()}`;
        }
    }
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

    // Theme toggle
    document.getElementById('theme-toggle').addEventListener('click', () => {
        const theme = document.documentElement.getAttribute('data-theme');
        const newTheme = theme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
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

    // Modal close
    document.querySelector('.modal-close').addEventListener('click', () => {
        document.getElementById('analysis-modal').classList.remove('active');
    });

    document.querySelector('.modal-backdrop').addEventListener('click', () => {
        document.getElementById('analysis-modal').classList.remove('active');
    });

    // Keyboard events
    document.addEventListener('keydown', (e) => {
        if (state.gameOver) return;
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
