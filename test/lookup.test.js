"use strict";
const assert = require("assert");
const { candidates, lookupLocal, didYouMean, prefixMatches } = require("../www/app.js");
const DICT = require("../www/data.js");

// Direct hits
let r = lookupLocal("Happy");
assert.strictEqual(r.word, "happy");
assert.ok(r.ml.length >= 1 && r.syn.length >= 1 && r.examples.length >= 1);

// Inflections map to base words
assert.strictEqual(lookupLocal("running").word, "run");
assert.strictEqual(lookupLocal("books").word, "book");
assert.strictEqual(lookupLocal("teaches").word, "teach");
assert.strictEqual(lookupLocal("went").word, "go");
assert.strictEqual(lookupLocal("children").word, "child");
assert.strictEqual(lookupLocal("studies") , null); // "study" is not stored; falls through to online

// Unknown words
assert.strictEqual(lookupLocal("xyzzy"), null);

// Suggestions
assert.ok(didYouMean("happpy").includes("happy"));
assert.deepStrictEqual(prefixMatches("tea").sort(), ["teach", "teacher", "tea"].sort());

// Bookmarks, recent searches and cache (using a fake storage)
const { makeStore } = require("../www/app.js");
function fakeStorage() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } };
}
const st = makeStore(fakeStorage());
const happy = lookupLocal("happy");
assert.strictEqual(st.isBookmarked("happy"), false);
assert.strictEqual(st.toggleBookmark(happy), true);
assert.strictEqual(st.isBookmarked("happy"), true);
assert.strictEqual(st.getBookmarks()[0].ml[0], happy.ml[0]);
assert.strictEqual(st.toggleBookmark({ ...happy, pending: true }), false); // second tap removes it
assert.strictEqual(st.getBookmarks().length, 0);

st.addRecent("a"); st.addRecent("b"); st.addRecent("a");
assert.deepStrictEqual(st.getRecent(), ["a", "b"]);
for (let i = 0; i < 20; i++) st.addRecent("w" + i);
assert.strictEqual(st.getRecent().length, 8);

st.setCached({ word: "serendipity", pos: "noun", ml: ["യാദൃച്ഛികമായ കണ്ടെത്തൽ"], syn: ["luck"], examples: [], source: "online", pending: false });
assert.strictEqual(st.getCached("serendipity").source, "cached");
assert.strictEqual(st.getCached("missing"), null);
for (let i = 0; i < 320; i++) st.setCached({ word: "x" + i, ml: [], syn: [], examples: [], source: "online" });
assert.strictEqual(st.getCached("x319").word, "x319");
assert.strictEqual(st.getCached("serendipity"), null); // oldest entries are trimmed

// A broken storage must not crash anything
const broken = makeStore({ getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); } });
assert.deepStrictEqual(broken.getBookmarks(), []);
assert.doesNotThrow(() => broken.addRecent("x"));

// Data integrity: every entry has Malayalam text, >=1 synonym, >=1 example with Malayalam translation
const ML = /[ഀ-ൿ]/;
for (const [word, [pos, ml, syn, ex]] of Object.entries(DICT)) {
  assert.ok(pos, word + ": missing part of speech");
  assert.ok(ml.length && ml.every((m) => ML.test(m)), word + ": bad Malayalam meaning");
  assert.ok(syn.length, word + ": no synonyms");
  assert.ok(ex.length && ex.every(([en, m]) => en && ML.test(m)), word + ": bad examples");
}

console.log("All tests passed. Words stored offline:", Object.keys(DICT).length);
