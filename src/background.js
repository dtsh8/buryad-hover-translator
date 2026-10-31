// Service worker: all network access and caching lives here.
// Lookup order: memory -> chrome.storage.local cache -> burlang.ru -> (opt-in) Google Translate.

const BURLANG = "https://burlang.ru/api/v1";
const GOOGLE = "https://translate.googleapis.com/translate_a/single";

const POS_TTL = 30 * 24 * 3600e3;
const NEG_TTL = 3 * 24 * 3600e3;
const MAX_ENTRIES = 5000;
const MAX_PHRASE_WORDS = 12;
const MIN_STEM = 3;
const GOOGLE_MIN_GAP_MS = 1000;
const GOOGLE_BACKOFF_MS = 3600e3;

const DEFAULTS = {
  enabled: true,
  direction: "bua-ru", // bua-ru | ru-bua
  hoverDelay: 300,
  modifier: "none", // none | Alt | Control | Shift
  googleFallback: false,
  googleDailyCap: 100,
};

let cache = null; // key -> [expiresAt, value|null]
const inflight = new Map();
let saveTimer = null;
let googleLast = 0;

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

async function loadCache() {
  if (cache) return cache;
  const { cache: stored } = await chrome.storage.local.get("cache");
  cache = new Map(Object.entries(stored || {}));
  return cache;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const now = Date.now();
    for (const [k, [exp]] of cache) if (exp < now) cache.delete(k);
    // Map keeps insertion order, so the oldest entries go first.
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    await chrome.storage.local.set({ cache: Object.fromEntries(cache) });
  }, 2000);
}

async function cached(key, producer) {
  await loadCache();
  const hit = cache.get(key);
  if (hit && hit[0] > Date.now()) return hit[1];
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const value = await producer(); // throws on transient errors -> not cached
    cache.delete(key);
    cache.set(key, [Date.now() + (value === null ? NEG_TTL : POS_TTL), value]);
    scheduleSave();
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function fetchWithTimeout(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Burlang entries look like "1 1) здоровье; 2) приветствие" - drop the leading entry number.
function cleanTranslation(v) {
  return String(v)
    .replace(/^\s*\d+\s+(?=\d+\))/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns string[] or null (not found). Throws on network/server errors.
async function burlangWord(word, dir) {
  const ep = dir === "ru-bua" ? "russian-word" : "buryat-word";
  const res = await fetchWithTimeout(`${BURLANG}/${ep}/translate?q=${encodeURIComponent(word)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`burlang ${res.status}`);
  const data = await res.json();
  const list = (data.translations || []).map((t) => cleanTranslation(t.value)).filter(Boolean);
  return list.length ? list : null;
}

const lookupExact = (word, dir) => cached(`b|${dir}|${word}`, () => burlangWord(word, dir));

// Buryad is agglutinative: if the exact form is missing, try shorter stems.
async function lookupWord(word, dir) {
  const exact = await lookupExact(word, dir);
  if (exact) return { translations: exact };
  if (dir !== "bua-ru") return null;
  for (let n = 1; n <= 4 && word.length - n >= MIN_STEM; n++) {
    const stem = word.slice(0, word.length - n);
    const t = await lookupExact(stem, dir);
    if (t) return { translations: t, stem };
  }
  return null;
}

async function googlePhrase(text, dir, s) {
  await loadCache();
  const key = `g|${dir}|${text}`;
  const hit = cache.get(key);
  if (hit && hit[0] > Date.now()) return hit[1];

  const day = new Date().toISOString().slice(0, 10);
  const { gstate = {} } = await chrome.storage.local.get("gstate");
  if (gstate.blockedUntil > Date.now()) return null;
  const used = gstate.day === day ? gstate.count : 0;
  if (used >= s.googleDailyCap) return null;
  if (!(await chrome.permissions.contains({ origins: ["https://translate.googleapis.com/*"] }))) return null;

  return cached(key, async () => {
    const wait = googleLast + GOOGLE_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    googleLast = Date.now();
    await chrome.storage.local.set({ gstate: { day, count: used + 1 } });
    const [sl, tl] = dir === "ru-bua" ? ["ru", "mn"] : ["auto", "ru"];
    const res = await fetchWithTimeout(`${GOOGLE}?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`);
    const ct = res.headers.get("content-type") || "";
    if (res.status === 429 || !ct.includes("json")) {
      await chrome.storage.local.set({ gstate: { day, count: used + 1, blockedUntil: Date.now() + GOOGLE_BACKOFF_MS } });
      throw new Error("google blocked");
    }
    if (!res.ok) throw new Error(`google ${res.status}`);
    const data = await res.json();
    const out = (data[0] || []).map((seg) => seg[0]).join("").trim();
    return out && out.toLowerCase() !== text.toLowerCase() ? out : null;
  });
}

async function translate(raw) {
  const s = await settings();
  const dir = s.direction;
  const words = String(raw || "")
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ""))
    .filter(Boolean);
  if (!words.length) return { ok: false, error: "empty" };

  if (words.length === 1) {
    const r = await lookupWord(words[0], dir);
    return { ok: true, items: r ? [{ word: words[0], ...r }] : [] };
  }

  // Phrase: whole phrase first (idioms), then word by word.
  const phrase = words.join(" ");
  const whole = await lookupExact(phrase, dir);
  if (whole) return { ok: true, items: [{ word: phrase, translations: whole }] };

  const items = [];
  let missing = 0;
  for (const w of words.slice(0, MAX_PHRASE_WORDS)) {
    const r = await lookupWord(w, dir);
    if (r) items.push({ word: w, ...r });
    else missing++;
  }
  let full = null;
  if (s.googleFallback && missing > 0) {
    try {
      full = await googlePhrase(phrase, dir, s);
    } catch (_) {
      /* dictionary-only result is still shown */
    }
  }
  return { ok: true, items, full, missing, truncated: words.length > MAX_PHRASE_WORDS };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "clearCache") {
    cache = new Map();
    chrome.storage.local.remove("cache").then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type !== "translate") return false;
  translate(msg.text).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});

async function updateBadge() {
  const s = await settings();
  await chrome.action.setBadgeText({ text: s.enabled ? "" : "off" });
}

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
chrome.storage.onChanged.addListener((c, area) => area === "sync" && c.enabled && updateBadge());

// Toolbar click toggles the extension.
chrome.action.onClicked.addListener(async () => {
  const s = await settings();
  await chrome.storage.sync.set({ enabled: !s.enabled });
});
