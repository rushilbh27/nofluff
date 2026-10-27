// Service worker: owns the OMDb key, the cache, the rate limit, and the queue.
// The content script never sees the key and never touches the network.

const OMDB_URL = 'https://www.omdbapi.com/';

const CACHE_TTL_HIT = 30 * 24 * 60 * 60 * 1000; // ratings barely move
const CACHE_TTL_MISS = 7 * 24 * 60 * 60 * 1000; // retry unmatched titles weekly

const DAILY_LIMIT = 950;    // OMDb free tier is 1000/day; leave headroom
const MIN_INTERVAL_MS = 120; // be polite to a free API
const MAX_CONCURRENT = 3;

// ---------------------------------------------------------------- utilities

function normalizeTitle(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/\s*[:\-–—]\s*(season|series|part|limited series|volume|vol\.?)\s*\d+.*$/i, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/[‘’“”]/g, "'")
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Netflix labels cards "The Crown: Season 5" / "Kohrra: Limited Series". OMDb only
// knows the base title, so strip the suffix before querying. Case and punctuation
// are preserved here (unlike normalizeTitle) because OMDb matches on them.
function stripSeriesSuffix(raw) {
  return String(raw || '')
    .replace(/\s*[:\-–—]\s*(season|series|part|chapter|book|volume|vol\.?|limited series|collection)\b.*$/i, '')
    .replace(/\s*\((19|20)\d{2}\)\s*$/, '')
    .trim() || String(raw || '').trim();
}

function cacheKey(title, year) {
  return 'r:' + normalizeTitle(title) + (year ? '@' + year : '');
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

// Similarity, used only to decide confident vs uncertain. Cheap Dice coefficient
// on bigrams — good enough to catch "wrong movie entirely" without a dependency.
function similarity(a, b) {
  a = normalizeTitle(a);
  b = normalizeTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let hits = 0;
  for (const [g, n] of A) hits += Math.min(n, B.get(g) || 0);
  const total = (a.length - 1) + (b.length - 1);
  return total > 0 ? (2 * hits) / total : 0;
}

// ---------------------------------------------------------------- key + quota

async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  return apiKey || null;
}

async function quotaRemaining() {
  const { quota } = await chrome.storage.local.get('quota');
  if (!quota || quota.date !== todayStamp()) return DAILY_LIMIT;
  return Math.max(0, DAILY_LIMIT - quota.n);
}

async function bumpQuota() {
  const { quota } = await chrome.storage.local.get('quota');
  const date = todayStamp();
  const n = (quota && quota.date === date ? quota.n : 0) + 1;
  await chrome.storage.local.set({ quota: { date, n } });
}

// ---------------------------------------------------------------- cache

async function readCache(key) {
  const got = await chrome.storage.local.get(key);
  const entry = got[key];
  if (!entry) return null;
  const ttl = entry.result && entry.result.status === 'ok' ? CACHE_TTL_HIT : CACHE_TTL_MISS;
  if (Date.now() - entry.ts > ttl) return null;
  return entry.result;
}

async function writeCache(key, result) {
  await chrome.storage.local.set({ [key]: { ts: Date.now(), result } });
}

// ---------------------------------------------------------------- queue

let active = 0;
let lastStart = 0;
const pending = [];
const inflight = new Map(); // dedupe identical concurrent lookups

function pump() {
  if (active >= MAX_CONCURRENT || pending.length === 0) return;
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastStart));
  setTimeout(() => {
    const job = pending.shift();
    if (!job) return;
    active++;
    lastStart = Date.now();
    job().finally(() => {
      active--;
      pump();
    });
    pump();
  }, wait);
}

function enqueue(fn) {
  return new Promise((resolve) => {
    pending.push(() => fn().then(resolve, (e) => resolve({ status: 'error', message: String(e) })));
    pump();
  });
}

// ---------------------------------------------------------------- lookup

async function fetchFromOmdb(apiKey, title, year) {
  const query = stripSeriesSuffix(title);
  const params = new URLSearchParams({ apikey: apiKey, t: query, plot: 'short', r: 'json' });
  if (year) params.set('y', String(year));

  const res = await fetch(OMDB_URL + '?' + params.toString());
  if (res.status === 401) {
    // 401 covers both a rejected key and "Request limit reached!". Telling someone
    // their key is wrong when it is only out of quota sends them hunting for nothing.
    let error = '';
    try { error = (await res.json()).Error || ''; } catch (e) { /* non-JSON body */ }
    return /limit/i.test(error) ? { status: 'limit', fromServer: true } : { status: 'badkey' };
  }
  if (!res.ok) return { status: 'error', message: 'HTTP ' + res.status };

  const json = await res.json();
  if (json.Response === 'False') {
    // A year filter can cause a false miss (Netflix year != IMDb year). Retry once bare.
    if (year) return null;
    return { status: 'nomatch' };
  }

  const ratings = Object.fromEntries((json.Ratings || []).map((r) => [r.Source, r.Value]));
  const score = similarity(query, json.Title);

  return {
    status: 'ok',
    // Below 0.6 the API almost certainly returned a different title than the card.
    // Surface that as uncertain rather than printing a confident wrong number.
    confident: score >= 0.6,
    similarity: Number(score.toFixed(2)),
    title: json.Title,
    year: json.Year,
    type: json.Type,
    imdbId: json.imdbID,
    imdb: json.imdbRating && json.imdbRating !== 'N/A' ? json.imdbRating : null,
    votes: json.imdbVotes && json.imdbVotes !== 'N/A' ? json.imdbVotes : null,
    rotten: ratings['Rotten Tomatoes'] || null,
    metacritic: json.Metascore && json.Metascore !== 'N/A' ? json.Metascore : null,
    plot: json.Plot && json.Plot !== 'N/A' ? json.Plot : null
  };
}

async function lookup(title, year) {
  if (!title || !normalizeTitle(title)) return { status: 'nomatch' };

  const key = cacheKey(title, year);
  const cached = await readCache(key);
  if (cached) return cached;

  if (inflight.has(key)) return inflight.get(key);

  const job = enqueue(async () => {
    const apiKey = await getApiKey();
    if (!apiKey) return { status: 'nokey' };

    if (await quotaRemaining() <= 0) return { status: 'limit' };

    await bumpQuota();
    let result = await fetchFromOmdb(apiKey, title, year);

    // null means "year filter missed" — retry without it before giving up.
    if (result === null) {
      if (await quotaRemaining() <= 0) return { status: 'limit' };
      await bumpQuota();
      result = await fetchFromOmdb(apiKey, title, null);
      if (result === null) result = { status: 'nomatch' };
    }

    if (result.status === 'limit' && result.fromServer) {
      await chrome.storage.local.set({ quota: { date: todayStamp(), n: DAILY_LIMIT } });
    }

    // Don't cache transient states; a bad key or a blown quota is fixable.
    if (result.status === 'ok' || result.status === 'nomatch') {
      await writeCache(key, result);
    }
    return result;
  });

  inflight.set(key, job);
  job.finally(() => inflight.delete(key));
  return job;
}

// ---------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'rating') {
    lookup(msg.title, msg.year).then(sendResponse);
    return true; // async
  }
  if (msg && msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    return false;
  }
  if (msg && msg.type === 'stats') {
    (async () => {
      sendResponse({
        hasKey: !!(await getApiKey()),
        remaining: await quotaRemaining(),
        limit: DAILY_LIMIT
      });
    })();
    return true;
  }
  return false;
});

// First install: land on the setup page instead of leaving people to find it.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;
  if (await getApiKey()) return;
  chrome.runtime.openOptionsPage();
});

// ---------------------------------------------------------------- Skipping

// Last-resort trusted click for YouTube static ads, where scripted clicks are ignored and
// there is no video to seek. Uses the debugger API, so Chrome shows its
// "started debugging this browser" bar while attached; we detach after a few idle seconds.

const SKIP_IDLE_MS = 6000;
const skipTimers = new Map();

const skipCmd = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

function skipDetach(tabId) {
  clearTimeout(skipTimers.get(tabId));
  skipTimers.delete(tabId);
  chrome.debugger.detach({ tabId }).catch(() => {});
}

async function skipEnsureAttached(tabId) {
  if (!skipTimers.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      if (!/already attached/i.test(String(e))) throw e;
    }
  }
  clearTimeout(skipTimers.get(tabId));
  skipTimers.set(tabId, setTimeout(() => skipDetach(tabId), SKIP_IDLE_MS));
}

chrome.debugger.onDetach.addListener((source) => {
  clearTimeout(skipTimers.get(source.tabId));
  skipTimers.delete(source.tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'skipTrustedClick' || !sender.tab) return false;
  let host = '';
  try {
    const rawUrl = sender.url || (sender.tab && sender.tab.url);
    if (rawUrl) host = new URL(rawUrl).hostname;
  } catch (e) {
    return false;
  }
  if (!/(^|\.)youtube\.com$/.test(host)) return false;

  (async () => {
    try {
      const tabId = sender.tab.id;
      // Browser zoom: coordinates in DevTools Input protocol use CSS viewport coordinates.
      const k = msg.useZoom ? await chrome.tabs.getZoom(tabId) : 1;
      const x = Math.round(msg.x * k);
      const y = Math.round(msg.y * k);
      console.debug('[NoFluff] trusted click at', x, y, 'tab', tabId);
      await skipEnsureAttached(tabId);
      await skipCmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await skipCmd(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await skipCmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      sendResponse({ ok: true });
    } catch (e) {
      console.warn('[NoFluff] trusted click failed:', e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});
