/**
 * Boots the inline script from public/index.html against a minimal DOM double.
 *
 * The Worker suite cannot see this class of bug at all: a `let` read before its declaration
 * threw during boot, which silently killed the countdown, the mobile menu, the calendar
 * button, both form handlers and the bank loader — everything after the throw. The page
 * still looked fine until you noticed the countdown showing dashes.
 *
 * This is deliberately a smoke test. It proves the script runs start to finish and that the
 * things it sets on load actually got set; it is not a rendering or layout test.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];

let pass = 0, fail = 0;
const t = (label, ok, extra = "") => { ok ? (pass++, console.log("  PASS", label)) : (fail++, console.log("  FAIL", label, extra)); };

/* ---------- the smallest DOM that lets the page boot ---------- */
const made = new Map();
const listeners = [];
function el(id = "") {
  const node = {
    id, dataset: {}, style: {}, classList: {
      _s: new Set(),
      add(c){ this._s.add(c); }, remove(c){ this._s.delete(c); },
      toggle(c){ this._s.has(c) ? this._s.delete(c) : this._s.add(c); return this._s.has(c); },
      contains(c){ return this._s.has(c); },
    },
    innerHTML: "", textContent: "", value: "", href: "", src: "",
    hidden: false, disabled: false, checked: false,
    addEventListener(type, fn){ listeners.push({ node: this, type, fn }); },
    removeEventListener(){}, setAttribute(k, v){ this[k] = v; }, getAttribute(k){ return this[k]; },
    insertBefore(){}, appendChild(){}, remove(){}, click(){},
    querySelector(){ return el(); }, querySelectorAll(){ return []; },
    reportValidity(){ return true; }, reset(){},
    getBoundingClientRect(){ return { top: 0 }; },
  };
  return node;
}
const byId = id => { if (!made.has(id)) made.set(id, el(id)); return made.get(id); };

const document = {
  documentElement: el("html"),
  head: el("head"),
  body: el("body"),
  getElementById: byId,
  createElement: () => el(),
  querySelector: sel => (sel.includes("attending") ? null : el()),
  // Only the selectors the boot path iterates need to yield anything.
  querySelectorAll: sel => {
    if (sel === "[data-i18n]") return [];
    if (sel === "#book-by-date") return [byId("book-by-date")];
    return [];
  },
};

const sandbox = {
  document,
  window: { turnstile: undefined },
  location: { search: "", origin: "https://georgeandmanos.com", pathname: "/", href: "https://georgeandmanos.com/" },
  history: { replaceState(){} },
  navigator: { language: "en" },
  URL, URLSearchParams, Intl, Date, Math, JSON, console,
  setInterval: () => 0, clearInterval(){}, setTimeout: () => 0,
  fetch: async () => ({ ok: false, json: async () => ({}) }),
  IntersectionObserver: class { observe(){} disconnect(){} },
  atob: s => Buffer.from(s, "base64").toString("binary"),
  btoa: s => Buffer.from(s, "binary").toString("base64"),
};
sandbox.window = Object.assign(sandbox.window, { document, location: sandbox.location });
sandbox.globalThis = sandbox;

console.log("\n== the page script boots without throwing ==");
let threw = null;
try { runInNewContext(code, sandbox, { filename: "index.html inline script" }); }
catch (e) { threw = e; }
t("inline script runs to completion", threw === null, threw && (threw.constructor.name + ": " + threw.message));

if (!threw) {
  console.log("\n== things the boot path is responsible for ==");
  // Everything below sits *after* setLang(startLang) in the file, so each one also proves
  // execution got past the point where the temporal-dead-zone bug used to abort.
  t("countdown days filled in", /^\d+$/.test(String(byId("cd-d").textContent)), byId("cd-d").textContent);
  t("countdown hours filled in", /^\d+$/.test(String(byId("cd-h").textContent)), byId("cd-h").textContent);
  t("countdown minutes filled in", /^\d+$/.test(String(byId("cd-m").textContent)), byId("cd-m").textContent);
  t("footer date formatted for Crete", byId("footer-date").textContent === "6 · 9 · 2027", byId("footer-date").textContent);
  t("monogram set", byId("nav-mono").textContent === "G · M", byId("nav-mono").textContent);
  t("language applied to <html>", document.documentElement.lang === "en", document.documentElement.lang);
  t("calendar button wired", listeners.some(l => l.node.id === "ics-btn" && l.type === "click"));
  t("both forms wired", ["interest-form", "rsvp-form"].every(
    id => listeners.some(l => l.node.id === id && l.type === "submit")), listeners.map(l => l.node.id).join(","));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
