"use strict";

/* ---------- Core lookup logic (also runs in Node for tests) ---------- */

const IS_NODE = typeof module !== "undefined" && module.exports;
const DICT = IS_NODE ? require("./data.js") : window.DICTIONARY;
const DEFS = IS_NODE ? require("./defs.js") : window.DICTIONARY_DEFS || {};
const KEYS = Object.keys(DICT).sort();

const IRREGULAR = {
  went: "go", gone: "go", ran: "run", ate: "eat", eaten: "eat", saw: "see", seen: "see",
  gave: "give", given: "give", took: "take", taken: "take", came: "come", spoke: "speak",
  spoken: "speak", wrote: "write", written: "write", slept: "sleep", knew: "know", known: "know",
  thought: "think", taught: "teach", heard: "hear", children: "child", men: "man", women: "woman",
  better: "good", best: "good", worse: "bad", worst: "bad", bigger: "big", biggest: "big",
  drank: "drink", drunk: "drink", learnt: "learn", wanted: "want"
};

/** Possible base forms of a typed word (plurals, -ing, -ed, etc.). */
function candidates(raw) {
  const w = raw.trim().toLowerCase();
  const out = [w];
  if (IRREGULAR[w]) out.push(IRREGULAR[w]);
  const rules = [["ies", "y"], ["ied", "y"], ["ves", "f"], ["ves", "fe"], ["es", ""], ["s", ""],
    ["ed", ""], ["ed", "e"], ["ing", ""], ["ing", "e"], ["er", ""], ["est", ""], ["ly", ""]];
  for (const [suf, rep] of rules) {
    if (w.length > suf.length + 2 && w.endsWith(suf)) {
      const stem = w.slice(0, -suf.length) + rep;
      out.push(stem);
      if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) out.push(stem.slice(0, -1));
    }
  }
  return [...new Set(out)];
}

function lookupLocal(raw) {
  for (const c of candidates(raw)) {
    if (Object.prototype.hasOwnProperty.call(DICT, c)) {
      const [pos, ml, syn, ex] = DICT[c];
      return {
        word: c, pos, ml: [...ml], mlPos: ml.map(() => pos), syn: [...syn],
        defs: (DEFS[c] || []).map(([definition, example]) => ({ pos, definition, example: example || "" })),
        examples: ex.map(([en, mlText]) => ({ en, ml: mlText })),
        source: "offline"
      };
    }
  }
  return null;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

function didYouMean(raw, limit = 4) {
  const w = raw.trim().toLowerCase();
  return KEYS.map((k) => [k, levenshtein(w, k)])
    .filter(([, d]) => d <= 2)
    .sort((x, y) => x[1] - y[1])
    .slice(0, limit)
    .map(([k]) => k);
}

function prefixMatches(raw, limit = 6) {
  const w = raw.trim().toLowerCase();
  if (!w) return [];
  return KEYS.filter((k) => k.startsWith(w)).slice(0, limit);
}

/* ---------- Storage: bookmarks, recent searches, cache of online results ---------- */

const CACHE_LIMIT = 300;

function cleanEntry(e) {
  return {
    word: e.word, pos: e.pos || "", ml: [...e.ml], mlPos: [...(e.mlPos || [])], syn: [...e.syn],
    defs: (e.defs || []).map((d) => ({ pos: d.pos || "", definition: d.definition, example: d.example || "" })),
    examples: e.examples.map((x) => ({ en: x.en, ml: x.ml || "" })),
    source: e.source
  };
}

function makeStore(storage) {
  const read = (key, fallback) => {
    try {
      const v = JSON.parse(storage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  };
  const write = (key, value) => {
    try { storage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or unavailable */ }
  };
  return {
    getBookmarks: () => read("bookmarks", []),
    isBookmarked(word) { return this.getBookmarks().some((b) => b.word === word); },
    /** Returns true if the word is bookmarked after the call. */
    toggleBookmark(entry) {
      const list = this.getBookmarks();
      const i = list.findIndex((b) => b.word === entry.word);
      if (i >= 0) { list.splice(i, 1); write("bookmarks", list); return false; }
      list.unshift(cleanEntry(entry));
      write("bookmarks", list);
      return true;
    },
    getRecent: () => read("recent", []),
    addRecent(word) {
      write("recent", [word, ...this.getRecent().filter((w) => w !== word)].slice(0, 8));
    },
    getCached(word) {
      const e = read("cache3", {})[word]; // "cache3": older cached results (fewer details) are ignored
      return e ? { ...e, source: "cached" } : null;
    },
    setCached(entry) {
      const cache = read("cache3", {});
      delete cache[entry.word];
      cache[entry.word] = cleanEntry(entry);
      const keys = Object.keys(cache);
      for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_LIMIT))) delete cache[k];
      write("cache3", cache);
    }
  };
}

/* ---------- Online fallback (free public APIs, used only for words not stored offline) ---------- */

const HAS_MALAYALAM = /[ഀ-ൿ]/;

async function getJSON(url, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the response of Google's free translate endpoint: main translation first, then dictionary alternatives. */
const MAX_MEANINGS = 10;

/** Returns [{ text: Malayalam meaning, pos: "noun" | "verb" | ... }], main translation first. */
function parseGoogle(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return [];
  const groups = Array.isArray(data[1]) ? data[1].filter((g) => Array.isArray(g) && Array.isArray(g[1])) : [];
  const groupPos = (g) => (typeof g[0] === "string" ? g[0] : "");
  const out = [];
  const add = (text, pos) => {
    if (typeof text === "string" && HAS_MALAYALAM.test(text) && !out.some((o) => o.text === text)) out.push({ text, pos });
  };

  const main = data[0].map((s) => (Array.isArray(s) && typeof s[0] === "string" ? s[0] : "")).join("").trim();
  if (main) {
    const home = groups.find((g) => g[1].includes(main));
    add(main, home ? groupPos(home) : "");
  }
  for (const g of groups) {
    for (const t of g[1]) {
      add(t, groupPos(g));
      if (out.length >= MAX_MEANINGS) return out;
    }
  }
  return out;
}

/** Malayalam meanings of a word or sentence: [{ text, pos }]. */
async function translateToMalayalam(text) {
  // Most accurate source first; MyMemory is only a backup.
  const google = parseGoogle(await getJSON(
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ml&dt=t&dt=bd&q=" + encodeURIComponent(text)
  ));
  if (google.length) return google;
  return (await translateWithMyMemory(text)).map((t) => ({ text: t, pos: "" }));
}

async function translateWithMyMemory(text) {
  const data = await getJSON(
    "https://api.mymemory.translated.net/get?langpair=en|ml&q=" + encodeURIComponent(text)
  );
  if (!data) return [];
  const found = [];
  const main = data.responseData && data.responseData.translatedText;
  if (main && HAS_MALAYALAM.test(main)) found.push(main.trim());
  if (Array.isArray(data.matches)) {
    for (const m of data.matches) {
      const t = (m.translation || "").trim();
      if (t && HAS_MALAYALAM.test(t) && t.length < 60 && !found.includes(t)) found.push(t);
      if (found.length >= 3) break;
    }
  }
  return found;
}

/**
 * Looks a word up online. The three requests run in parallel and `onUpdate`
 * is called every time one of them finishes, so the screen fills in piece by piece.
 */
async function lookupOnline(word, onUpdate) {
  const w = word.trim().toLowerCase();
  const entry = { word: w, pos: "", ml: [], mlPos: [], syn: [], defs: [], examples: [], source: "online", pending: true };
  const synSet = new Set();
  const emit = () => { if (onUpdate) onUpdate(entry); };
  const addSyn = (list) => {
    for (const s of list) {
      const t = String(s).toLowerCase();
      if (t && t !== w) synSet.add(t);
    }
    entry.syn = [...synSet].slice(0, 8);
  };

  const pTranslate = translateToMalayalam(w).then((items) => {
    entry.ml = items.map((i) => i.text);
    entry.mlPos = items.map((i) => i.pos);
    if (!entry.pos && items[0] && items[0].pos) entry.pos = items[0].pos;
    emit();
  });

  const pDict = getJSON("https://api.dictionaryapi.dev/v2/entries/en/" + encodeURIComponent(w)).then(async (dict) => {
    if (!Array.isArray(dict) || !dict.length) return;
    const exEn = [];
    const syns = [];
    const defs = [];
    for (const item of dict) {
      for (const m of item.meanings || []) {
        if (!entry.pos) entry.pos = m.partOfSpeech || "";
        syns.push(...(m.synonyms || []));
        let perType = 0;
        for (const d of m.definitions || []) {
          syns.push(...(d.synonyms || []));
          if (d.example) exEn.push(d.example);
          if (d.definition && perType < 3) {
            defs.push({ pos: m.partOfSpeech || "", definition: d.definition, example: d.example || "" });
            perType++;
          }
        }
      }
    }
    addSyn(syns);
    entry.defs = defs.slice(0, 8);
    entry.examples = exEn.slice(0, 2).map((en) => ({ en, ml: "" }));
    emit();
    await Promise.all(entry.examples.map(async (ex) => {
      const t = await translateToMalayalam(ex.en);
      ex.ml = t[0] ? t[0].text : "";
      emit();
    }));
  });

  const pMuse = getJSON("https://api.datamuse.com/words?max=8&rel_syn=" + encodeURIComponent(w)).then((muse) => {
    if (Array.isArray(muse)) { addSyn(muse.map((m) => m.word)); emit(); }
  });

  await Promise.all([pTranslate, pDict, pMuse]);
  entry.pending = false;
  return entry.ml.length || entry.syn.length || entry.examples.length || entry.defs.length ? entry : null;
}

if (IS_NODE) {
  module.exports = { candidates, lookupLocal, didYouMean, prefixMatches, levenshtein, makeStore, parseGoogle, KEYS };
} else {
  /* ---------- UI ---------- */
  const $ = (id) => document.getElementById(id);
  const form = $("search-form");
  const input = $("q");
  const sugg = $("suggestions");
  const result = $("result");
  const recentBox = $("recent");
  const savedBox = $("saved");
  const themeBtn = $("theme");
  const mainEl = document.querySelector("main");
  const tabSearch = $("tab-search");
  const tabSaved = $("tab-saved");
  const toastEl = $("toast");

  /** Switch between the Search screen and the Saved words screen. */
  function setView(view) {
    mainEl.dataset.view = view;
    tabSearch.classList.toggle("active", view === "search");
    tabSaved.classList.toggle("active", view === "saved");
    tabSearch.setAttribute("aria-selected", String(view === "search"));
    tabSaved.setAttribute("aria-selected", String(view === "saved"));
    if (view === "saved") { hideSuggestions(); window.scrollTo({ top: 0 }); }
  }

  let toastTimer = null;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2000);
  }

  let memory = {};
  const memStorage = {
    getItem: (k) => (k in memory ? memory[k] : null),
    setItem: (k, v) => { memory[k] = String(v); }
  };
  let storage = memStorage;
  try { storage = window.localStorage; storage.getItem("x"); } catch (e) { storage = memStorage; }
  const store = makeStore(storage);

  let reqId = 0; // bumped on every new search/keystroke so stale online results are ignored

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function block(title) {
    const s = el("section", "block");
    s.append(el("h3", "label", title));
    return s;
  }

  function chip(word) {
    const b = el("button", "chip", word);
    b.type = "button";
    b.addEventListener("click", () => search(word));
    return b;
  }

  const POS_ML = { noun: "നാമം", verb: "ക്രിയ", adjective: "വിശേഷണം", adverb: "ക്രിയാവിശേഷണം", pronoun: "സർവ്വനാമം" };
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  /** Small tag shown next to a Malayalam meaning, e.g. "നാമം" for a noun. */
  const posTag = (pos) => (pos ? POS_ML[pos.toLowerCase()] || capitalize(pos) : "");

  const SOURCE_LABEL = { offline: "Offline", online: "Online", cached: "Cached" };

  function render(entry) {
    result.replaceChildren();
    const card = el("article", "card");

    const head = el("div", "head");
    head.append(el("h2", "word", entry.word));
    if (entry.pos) head.append(el("span", "pos", entry.pos));
    head.append(el("span", "src " + entry.source, SOURCE_LABEL[entry.source] || entry.source));

    const star = el("button", "star");
    star.type = "button";
    star.disabled = !!entry.pending;
    const setStar = (on) => {
      star.textContent = on ? "★" : "☆";
      star.classList.toggle("on", on);
      star.setAttribute("aria-pressed", String(on));
      star.setAttribute("aria-label", on ? "Remove bookmark" : "Bookmark this word");
    };
    setStar(store.isBookmarked(entry.word));
    star.addEventListener("click", () => {
      const saved = store.toggleBookmark(entry);
      setStar(saved);
      renderSaved();
      toast(saved ? "Saved ★ — see the Saved tab" : "Removed from saved words");
    });
    head.append(star);
    card.append(head);

    const loading = (what) => el("p", "muted", entry.pending ? "Loading…" : "No " + what + " found.");

    const meaning = block("Malayalam meaning · മലയാളം അർത്ഥം");
    if (entry.ml.length) {
      const list = el("div", "ml-list");
      entry.ml.forEach((m, i) => {
        const chipEl = el("span", "ml");
        chipEl.append(m);
        const tag = posTag((entry.mlPos && entry.mlPos[i]) || "");
        if (tag) chipEl.append(el("small", "ml-pos", tag));
        list.append(chipEl);
      });
      meaning.append(list);
    } else meaning.append(loading("Malayalam meaning"));
    card.append(meaning);

    // English definitions, grouped by type: "Noun", "Verb", ...
    const defs = entry.defs || [];
    if (defs.length) {
      const order = [];
      defs.forEach((d) => { if (!order.includes(d.pos)) order.push(d.pos); });
      order.forEach((pos) => {
        const group = block(pos ? capitalize(pos) : "Meaning");
        defs.filter((d) => d.pos === pos).forEach((d) => {
          const item = el("div", "def");
          item.append(el("p", "def-text", d.definition));
          if (d.example) item.append(el("p", "def-ex", "“" + d.example + "”"));
          group.append(item);
        });
        card.append(group);
      });
    } else if (entry.pending) {
      const wait = block("Definition");
      wait.append(el("p", "muted", "Loading…"));
      card.append(wait);
    }

    const syn = block("English synonyms");
    if (entry.syn.length) {
      const row = el("div", "chips");
      entry.syn.forEach((s) => row.append(chip(s)));
      syn.append(row);
    } else syn.append(loading("synonyms"));
    card.append(syn);

    const ex = block("Example sentences");
    if (entry.examples.length) {
      entry.examples.forEach((e) => {
        const item = el("div", "example");
        item.append(el("p", "ex-en", e.en));
        if (e.ml) item.append(el("p", "ex-ml", e.ml));
        ex.append(item);
      });
    } else ex.append(loading("example sentences"));
    card.append(ex);

    result.append(card);
  }

  function renderMessage(title, body, suggestions) {
    result.replaceChildren();
    const card = el("article", "card");
    card.append(el("h2", "word", title));
    card.append(el("p", "muted", body));
    if (suggestions && suggestions.length) {
      card.append(el("p", "label", "Did you mean"));
      const row = el("div", "chips");
      suggestions.forEach((s) => row.append(chip(s)));
      card.append(row);
    }
    result.append(card);
  }

  function renderWelcome() {
    result.replaceChildren();
    const card = el("article", "card");
    card.append(el("h2", "word", "Welcome"));
    card.append(el("p", "muted",
      "Start typing an English word to see its Malayalam meaning, synonyms and example sentences. " +
      "Tap ☆ on a result to save the word."));
    result.append(card);
  }

  function renderRecent() {
    recentBox.replaceChildren();
    const list = store.getRecent();
    if (!list.length) return;
    recentBox.append(el("h3", "label", "Recent searches"));
    const row = el("div", "chips");
    list.forEach((w) => row.append(chip(w)));
    recentBox.append(row);
  }

  function renderSaved() {
    savedBox.replaceChildren();
    const list = store.getBookmarks();
    tabSaved.textContent = "★ Saved (" + list.length + ")";
    if (!list.length) {
      savedBox.append(el("p", "muted empty", "No saved words yet. Search a word and tap the ☆ star on its result to save it here."));
      return;
    }
    savedBox.append(el("h3", "label", "Saved words · " + list.length));
    const ul = el("ul", "saved-list");
    list.forEach((b) => {
      const li = el("li", "saved-item");
      const open = el("button", "saved-open");
      open.type = "button";
      open.append(el("span", "saved-word", b.word), el("span", "saved-ml", b.ml[0] || ""));
      open.addEventListener("click", () => {
        reqId++;
        input.value = b.word;
        hideSuggestions();
        setView("search");
        render({ ...b, source: b.source === "online" ? "cached" : b.source });
        window.scrollTo({ top: 0 });
      });
      const del = el("button", "saved-del", "✕");
      del.type = "button";
      del.setAttribute("aria-label", "Remove " + b.word + " from saved words");
      del.addEventListener("click", () => {
        store.toggleBookmark(b);
        renderSaved();
        const star = result.querySelector(".star");
        const shown = result.querySelector(".word");
        if (star && shown && shown.textContent === b.word) { star.textContent = "☆"; star.classList.remove("on"); }
      });
      li.append(open, del);
      ul.append(li);
    });
    savedBox.append(ul);
  }

  function lookupCached(raw) {
    for (const c of candidates(raw)) {
      const hit = store.getCached(c);
      if (hit) return hit;
    }
    return null;
  }

  /** Instant lookup: built-in words first, then words found online before. */
  function lookupInstant(raw) {
    return lookupLocal(raw) || lookupCached(raw);
  }

  async function search(raw) {
    const word = (raw || "").trim();
    if (!word) return;
    const id = ++reqId;
    setView("search");
    input.value = word;
    hideSuggestions();
    input.blur();

    const hit = lookupInstant(word);
    if (hit) {
      render(hit);
      store.addRecent(hit.word);
      renderRecent();
      return;
    }

    render({ word: word.toLowerCase(), pos: "", ml: [], syn: [], examples: [], source: "online", pending: true });
    const entry = await lookupOnline(word, (partial) => { if (id === reqId) render(partial); });
    if (id !== reqId) return;

    if (entry) {
      render(entry);
      store.setCached(entry);
      store.addRecent(entry.word);
      renderRecent();
    } else {
      renderMessage(
        word,
        navigator.onLine
          ? "Sorry, no result found for this word."
          : "This word is not stored offline and you appear to be offline. Connect to the internet and try again.",
        didYouMean(word)
      );
    }
  }

  function hideSuggestions() { sugg.hidden = true; sugg.replaceChildren(); }

  /* Live search: results appear while typing, no waiting. */
  input.addEventListener("input", () => {
    reqId++; // cancel any online lookup in flight
    setView("search");
    const q = input.value.trim();
    if (!q) { hideSuggestions(); renderWelcome(); return; }

    const matches = prefixMatches(q);
    sugg.replaceChildren();
    matches.forEach((m) => {
      const li = el("li");
      const b = el("button", "sugg", m);
      b.type = "button";
      b.addEventListener("click", () => search(m));
      li.append(b);
      sugg.append(li);
    });
    sugg.hidden = !matches.length;

    const hit = lookupInstant(q);
    if (hit) render(hit);
    else if (!matches.length) renderMessage(q, "Not stored offline. Press Search to look it up online.", didYouMean(q));
  });

  form.addEventListener("submit", (e) => { e.preventDefault(); search(input.value); });

  /* Theme: auto (follow phone), light, dark, AMOLED black */
  const THEMES = ["auto", "light", "dark", "amoled"];
  const THEME_LABEL = { auto: "Auto", light: "Light", dark: "Dark", amoled: "AMOLED" };
  const THEME_COLOR = { auto: "#0e4a47", light: "#0e4a47", dark: "#0b2b29", amoled: "#000000" };
  const themeMeta = document.querySelector('meta[name="theme-color"]');

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    themeBtn.textContent = "◐ " + THEME_LABEL[t];
    if (themeMeta) themeMeta.setAttribute("content", THEME_COLOR[t]);
    try { storage.setItem("theme", t); } catch (e) { /* ignore */ }
  }
  themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || "auto";
    applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
  });
  applyTheme(THEMES.includes(storage.getItem("theme")) ? storage.getItem("theme") : "auto");

  tabSearch.addEventListener("click", () => { setView("search"); input.focus(); });
  tabSaved.addEventListener("click", () => setView("saved"));

  renderWelcome();
  renderSaved();
  renderRecent();
  setView("search");
}
