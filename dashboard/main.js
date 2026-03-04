/**
 * AI Pulse Dashboard — Main Application Logic
 * =============================================
 * Loads feeds.json, renders article cards, handles source filtering,
 * search, bookmarking (localStorage), and 24h staleness checks.
 */

// ─── Constants ──────────────────────────────────────────────────

const FEEDS_URL = '/feeds.json';
const STORAGE_KEY = 'aiPulse';
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── State ──────────────────────────────────────────────────────

let allArticles = [];
let activeSource = 'all';
let activeView = 'feed'; // 'feed' | 'saved'
let searchQuery = '';

// ─── Storage Helpers ────────────────────────────────────────────

function loadStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : { savedArticles: [], lastFetchTimestamp: null };
    } catch {
        return { savedArticles: [], lastFetchTimestamp: null };
    }
}

function saveStorage(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function isSaved(articleId) {
    const store = loadStorage();
    return store.savedArticles.includes(articleId);
}

function toggleSaved(articleId) {
    const store = loadStorage();
    const idx = store.savedArticles.indexOf(articleId);
    if (idx === -1) {
        store.savedArticles.push(articleId);
    } else {
        store.savedArticles.splice(idx, 1);
    }
    saveStorage(store);
    return idx === -1; // returns true if now saved
}

// ─── Time Formatting ────────────────────────────────────────────

function timeAgo(dateStr) {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diffMs = now - then;
    const mins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);

    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

// ─── Card Rendering ─────────────────────────────────────────────

function createArticleCard(article) {
    const saved = isSaved(article.id);

    const card = document.createElement('div');
    card.className = 'article-card';
    card.dataset.id = article.id;
    card.dataset.source = article.source;

    card.innerHTML = `
    <div class="card-header">
        <span class="source-badge ${article.source}">
        <span class="source-dot ${article.source}"></span>
        ${article.sourceName}
      </span>
      <button class="bookmark-btn ${saved ? 'saved' : ''}" data-id="${article.id}" title="${saved ? 'Remove bookmark' : 'Save article'}" id="bookmark-${article.id}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="${saved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
    </div>

    <h3 class="card-title">
      <a href="${article.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.title)}</a>
    </h3>

    <p class="card-summary">${escapeHtml(article.summary)}</p>

    <div class="card-footer">
      <div class="card-meta">
        <span class="card-time">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          ${timeAgo(article.publishedAt)}
        </span>
        ${article.author ? `<span class="card-author">by ${escapeHtml(article.author)}</span>` : ''}
      </div>
      <a href="${article.url}" target="_blank" rel="noopener noreferrer" class="read-link">
        Read
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </a>
    </div>
  `;

    // Bookmark click handler
    const bookmarkBtn = card.querySelector('.bookmark-btn');
    bookmarkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nowSaved = toggleSaved(article.id);
        bookmarkBtn.classList.toggle('saved', nowSaved);
        bookmarkBtn.title = nowSaved ? 'Remove bookmark' : 'Save article';

        // Update SVG fill
        const svg = bookmarkBtn.querySelector('svg');
        svg.setAttribute('fill', nowSaved ? 'currentColor' : 'none');

        updateStats();

        // If in saved view and just removed, re-render
        if (activeView === 'saved' && !nowSaved) {
            renderArticles();
        }
    });

    return card;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ─── Filtering & Rendering ──────────────────────────────────────

function getFilteredArticles() {
    let articles = [...allArticles];

    // Filter by view
    if (activeView === 'saved') {
        const store = loadStorage();
        articles = articles.filter(a => store.savedArticles.includes(a.id));
    }

    // Filter by source
    if (activeSource !== 'all') {
        articles = articles.filter(a => a.source === activeSource);
    }

    // Search filter
    if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        articles = articles.filter(a =>
            a.title.toLowerCase().includes(q) ||
            a.summary.toLowerCase().includes(q) ||
            (a.author && a.author.toLowerCase().includes(q))
        );
    }

    return articles;
}

function renderArticles() {
    const grid = document.getElementById('articles-grid');
    const emptyState = document.getElementById('empty-state');
    const loadingState = document.getElementById('loading-state');

    loadingState.classList.add('hidden');

    const articles = getFilteredArticles();

    if (articles.length === 0) {
        grid.innerHTML = '';
        emptyState.classList.remove('hidden');
        // Update empty state text based on view
        const emptyH2 = emptyState.querySelector('h2');
        const emptyP = emptyState.querySelector('p');
        if (activeView === 'saved') {
            emptyH2.textContent = 'No saved articles';
            emptyP.textContent = 'Bookmark articles to save them for later.';
        } else {
            emptyH2.textContent = 'No articles found';
            emptyP.textContent = 'No AI news in the last 24 hours matching your filters.';
        }
        return;
    }

    emptyState.classList.add('hidden');
    grid.innerHTML = '';

    articles.forEach(article => {
        grid.appendChild(createArticleCard(article));
    });
}

// ─── Stats ──────────────────────────────────────────────────────

function updateStats() {
    const store = loadStorage();
    const totalEl = document.querySelector('#stat-total .stat-number');
    const savedEl = document.querySelector('#stat-saved .stat-number');

    if (totalEl) totalEl.textContent = allArticles.length;
    if (savedEl) savedEl.textContent = store.savedArticles.length;
}

// ─── Staleness Check ────────────────────────────────────────────

function checkStaleness() {
    const store = loadStorage();
    const badge = document.getElementById('stale-badge');
    const refreshInfo = document.getElementById('refresh-info');

    if (allArticles.length > 0 && allArticles[0].fetchedAt) {
        const fetchedTime = new Date(allArticles[0].fetchedAt).getTime();
        const age = Date.now() - fetchedTime;

        if (age > STALE_THRESHOLD_MS) {
            badge.classList.remove('hidden');
            if (refreshInfo) {
                refreshInfo.querySelector('span').textContent = 'Data may be stale';
                refreshInfo.querySelector('.refresh-dot').style.background = '#F59E0B';
            }
        } else {
            badge.classList.add('hidden');
            if (refreshInfo) {
                const mins = Math.floor(age / 60000);
                if (mins < 1) {
                    refreshInfo.querySelector('span').textContent = 'Updated just now';
                } else if (mins < 60) {
                    refreshInfo.querySelector('span').textContent = `Updated ${mins}m ago`;
                } else {
                    refreshInfo.querySelector('span').textContent = `Updated ${Math.floor(mins / 60)}h ago`;
                }
            }
        }

        // Save fetch timestamp
        store.lastFetchTimestamp = allArticles[0].fetchedAt;
        saveStorage(store);
    }
}

// ─── Event Handlers ─────────────────────────────────────────────

function setupEventListeners() {
    // Source filters
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeSource = btn.dataset.source;
            renderArticles();
        });
    });

    // Navigation (Feed / Saved)
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeView = btn.dataset.view;

            // Update page title
            const title = document.getElementById('page-title');
            title.textContent = activeView === 'saved' ? 'Saved Articles' : "Today's POD Pulse";

            renderArticles();
        });
    });

    // Search
    const searchInput = document.getElementById('search-input');
    let searchTimeout;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            searchQuery = searchInput.value;
            renderArticles();
        }, 200);
    });

    // Mobile menu
    const menuBtn = document.getElementById('mobile-menu-btn');
    const sidebar = document.getElementById('sidebar');

    menuBtn.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        toggleOverlay(sidebar.classList.contains('open'));
    });
}

function toggleOverlay(show) {
    let overlay = document.querySelector('.sidebar-overlay');
    if (show) {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'sidebar-overlay visible';
            overlay.addEventListener('click', () => {
                document.getElementById('sidebar').classList.remove('open');
                toggleOverlay(false);
            });
            document.getElementById('app').appendChild(overlay);
        } else {
            overlay.classList.add('visible');
        }
    } else if (overlay) {
        overlay.classList.remove('visible');
    }
}

// ─── Initialize ─────────────────────────────────────────────────

async function init() {
    setupEventListeners();

    try {
        const res = await fetch(FEEDS_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        allArticles = await res.json();
    } catch (err) {
        console.error('Failed to load feeds:', err);
        allArticles = [];
    }

    updateStats();
    checkStaleness();
    renderArticles();
}

// Start
init();
