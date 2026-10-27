/* Dev-only stand-in for the chrome.* APIs, so the extension's pages and content
   script can be loaded from a plain local web server. Never shipped in a build
   path and never loaded by manifest.json.

   Query params:
     key=none|set   whether an API key is already saved   (default: set)
     left=<n>       lookups remaining today                (default: 912)
*/
(() => {
  const q = new URLSearchParams(location.search);
  const store = {};
  if (q.get('key') !== 'none') store.apiKey = 'a1b2c3d4';
  const listeners = [];

  const pick = (keys) => {
    if (keys == null) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) if (k in store) out[k] = store[k];
    return out;
  };

  const emit = (changes) => listeners.forEach((fn) => fn(changes, 'local'));

  const withCb = (value, cb) => {
    if (typeof cb === 'function') { setTimeout(() => cb(value), 0); return undefined; }
    return Promise.resolve(value);
  };

  // Fictional titles on purpose: this must never show a made-up number for a real show.
  const base = { status: 'ok', confident: true, similarity: 1 };
  const T = (title, year, type, imdb, votes, rotten, metacritic) =>
    ({ ...base, title, year, type, imdbId: 'tt0000001', imdb, votes, rotten, metacritic, plot: null });

  const ratings = {
    'midnight orchard': T('Midnight Orchard', '2023', 'movie', '8.7', '412,903', '94%', '88'),
    'the long quiet': T('The Long Quiet', '2021–2024', 'series', '7.9', '88,214', '91%', null),
    'glass hours': T('Glass Hours', '2022–', 'series', '8.1', '64,550', '87%', '79'),
    'paper satellites': T('Paper Satellites', '2020', 'movie', '6.8', '23,771', '71%', '64'),
    'harbor lights': T('Harbor Lights', '2019', 'movie', '6.1', '9,402', '58%', '55'),
    'velvet static': T('Velvet Static', '2024', 'movie', '5.2', '17,880', '33%', '41'),
    'cold open': T('Cold Open', '2022', 'series', '4.4', '6,120', null, null),
    'brand new release': T('Brand New Release', '2025', 'movie', null, null, null, null),
    'saltwater kings': { ...base, confident: false, similarity: 0.4, title: 'Salt King', year: '1998', type: 'movie',
      imdbId: 'tt0000002', imdb: '6.4', votes: '3,100', rotten: null, metacritic: null, plot: null },
    'untitled thing': { status: 'nomatch' }
  };

  const norm = (t) => String(t || '').toLowerCase().replace(/\s*:\s*season.*$/, '').replace(/[^a-z0-9 ]+/g, '').trim();

  const handle = (msg) => {
    if (msg.type === 'rating') {
      if (!store.apiKey) return { status: 'nokey' };   // same as the real worker
      return ratings[norm(msg.title)] || T(msg.title, '2020', 'movie', '7.0', '12,000', '75%', '60');
    }
    if (msg.type === 'stats') return { hasKey: !!store.apiKey, remaining: Number(q.get('left') ?? 912), limit: 950 };
    if (msg.type === 'openOptions') { console.log('[stub] openOptionsPage()'); window.__openedOptions = true; }
    return undefined;
  };

  window.chrome = {
    runtime: {
      lastError: undefined,
      getManifest: () => ({ version: '1.2.1' }),
      openOptionsPage: () => { console.log('[stub] openOptionsPage()'); window.__openedOptions = true; },
      sendMessage: (msg, cb) => {
        const delay = msg.type === 'rating' ? 150 + Math.random() * 500 : 20;
        const result = new Promise((r) => setTimeout(() => r(handle(msg)), delay));
        if (typeof cb === 'function') { result.then(cb); return undefined; }
        return result;
      }
    },
    storage: {
      onChanged: { addListener: (fn) => listeners.push(fn) },
      local: {
        get: (keys, cb) => withCb(pick(keys), cb),
        set: (obj, cb) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = v; }
          emit(changes);
          return withCb(undefined, cb);
        },
        remove: (keys, cb) => {
          const changes = {};
          for (const k of [].concat(keys)) if (k in store) { changes[k] = { oldValue: store[k] }; delete store[k]; }
          if (Object.keys(changes).length) emit(changes);
          return withCb(undefined, cb);
        }
      }
    }
  };

  // The skipping settings use storage.sync; in the preview it shares the same fake store.
  window.chrome.storage.sync = window.chrome.storage.local;

  // OMDb, faked: lets the key-verification flow be exercised without spending a lookup.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    if (!String(url).includes('omdbapi.com')) return realFetch(url, opts);
    await new Promise((r) => setTimeout(r, 450));
    const key = new URL(url).searchParams.get('apikey');
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (key === 'netw0rk1') throw new TypeError('Failed to fetch');
    if (key === 'limit123') return json(401, { Response: 'False', Error: 'Request limit reached!' });
    if (key === 'a1b2c3d4' || key === 'good1234') return json(200, { Response: 'True', Title: 'The Matrix', Year: '1999', imdbRating: '8.7' });
    return json(401, { Response: 'False', Error: 'Invalid API key!' });
  };
})();
