/**
 * RSVP endpoint for the wedding site.
 * Receives a form POST (FormData or JSON), validates lightly, and creates one
 * record in the Airtable "RSVPs" table. The Airtable token never leaves the Worker.
 *
 * Secrets / vars (set with `wrangler secret put` — see README):
 *   AIRTABLE_TOKEN     personal access token, scopes: data.records:read AND data.records:write
 *   RSVP_SIGNING_KEY   random string used to sign party tokens (see below)
 *   AIRTABLE_BASE      appivWbWyQlQqGJTB
 *   AIRTABLE_TABLE     tblfcALpXOklfXfG0            (RSVPs)
 *   GUESTS_TABLE       tbllrariezt3kKrsq            (Guests — one row per person)
 *
 * Static site is served from ./public by the Workers assets binding; this script only
 * handles /api/*. Routes:
 *   GET  /api/lookup?surname=<surname>  → the parties whose members match that surname EXACTLY.
 *                              Returns each member's display name and type, plus a signed
 *                              token. Airtable record IDs are never exposed.
 *   POST /api/rsvp (phase=interest) → one row in RSVPs
 *   POST /api/rsvp (phase=rsvp)        → one row in RSVPs, plus per-guest RSVP/event ticks on Guests.
 *                              Guests are addressed by their index in the signed token (g0, g1, …
 *                              with repeated ev0, ev1, … for events), never by record ID, so a
 *                              submission can only ever touch the party the token was issued for.
 */

// Form field name → Airtable field ID. IDs are stable even if you rename fields.
const FIELD = {
  name:      "fldsuzKiBlqgLotnJ", // Name(s)
  email:     "fldykxSDuIhcNSYQY", // Email
  attending: "fldBfK0qCznZDDtJG", // Attending (single select)
  events:    "fld0GcrHpvYtcKrjn", // Events (multi select)
  guests:    "fldDOyeZ675aYZ39G", // Guests in party
  staying:   "fldBLXbLWfTrvEDEc", // Staying at
  nights:    "fldyaOgbH3Ac3oog6", // Nights requested
  dietary:   "fldthu1lwnqcjWjtg", // Dietary
  song:      "fldwLuYYwEdxtXRiH", // Song request
  message:   "fldKCNv9cRkQ7fsTD", // Message
  edinburgh: "fld6Mcq79UWDnNCEY", // Edinburgh interest (checkbox)
  lift:      "fldu1m4drlryuhliD", // Needs a lift (checkbox)
  phase:     "fldacVBxtB1sP2Xte", // Phase (single select)
  likely:    "fldFvNX6Gk2qbTDW8", // Likely coming (single select)
  party:     "fldIYJjlsLiSoQoZO", // Party (link to Parties)
};

const G = { full:"fldA7jCu6kwHedyV3", last:"fldwN5bOcSXwT1UcS", lookup:"fldRzXJbyHOWbVUwI", party:"fld0LbFHmkkJmahT5",
            type:"fld4kGC6dP4Pq4xXo", rsvp:"fldIehdhZfhVITN2B", sun:"fldMVTk5vfBRlU597", mon:"fld3xllk6lknr9ebK", tue:"fld3rTa7sR7z0jih0" };

// A party token is good for one sitting at the form.
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

// Every value that reaches a single/multi-select must already exist in the base, so that
// junk can never add new dropdown options. Keep these in step with the Airtable choices.
const ATTENDING = ["Joyfully accepts", "Regretfully declines"];
const LIKELY    = ["Yes", "Maybe", "No"];
const EVENTS    = ["Sunday welcome", "Monday wedding", "Tuesday lunch", "Staying the week"];

const oneOf = (v, allowed) => allowed.includes(String(v)) ? String(v) : null;
const cap   = (v, n) => String(v).trim().slice(0, n);
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254;

const cors = (env) => (env.ALLOWED_ORIGIN
  ? { "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type" }
  : {});   // same origin — no CORS headers needed

const json = (body, status, env) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(env) },
  });

const at = (env, path, init={}) => fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${path}`, {
  ...init, headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json", ...(init.headers||{}) } });

// Airtable failures must be loud. Silently returning "no matches" once hid a token
// that was missing the data.records:read scope for weeks.
async function atJson(env, path, init) {
  const r = await at(env, path, init);
  if (!r.ok) {
    console.error("Airtable", init?.method || "GET", path.split("?")[0], r.status, await r.text());
    throw new Error("airtable " + r.status);
  }
  return r.json();
}

const norm = s => String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-zͰ-Ͽ]/g,"");

/* ---------- Turnstile ---------- */
// Enforced only once TURNSTILE_SECRET is set, so the forms keep working until the widget
// is created. While it is unset every submission logs a warning — check the tail if you
// think the bot check is on and it isn't.
async function turnstileOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET) {
    // Fail closed in production. Skipping the check silently is how a misconfigured deploy
    // ends up with no bot defence and no sign of it; TURNSTILE_OPTIONAL is the explicit
    // opt-out, set only in .dev.vars and in tests.
    if (env.TURNSTILE_OPTIONAL === "true") return true;
    console.error("TURNSTILE_SECRET is not set — refusing submissions");
    return false;
  }
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  if (ip && ip !== "anon") body.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body, signal: AbortSignal.timeout(8000) });
    if (!r.ok) { console.error("Turnstile siteverify HTTP", r.status); return false; }
    const j = await r.json();
    if (!j.success) { console.warn("Turnstile rejected", JSON.stringify(j["error-codes"] || [])); return false; }
    // success alone is not enough: a token minted for another site's widget would also come
    // back successful. Pin the hostname the token was issued on.
    const allowed = String(env.TURNSTILE_HOSTNAMES || "").split(",").map(s => s.trim()).filter(Boolean);
    if (allowed.length && j.hostname && !allowed.includes(j.hostname)) {
      console.warn("Turnstile hostname mismatch", j.hostname);
      return false;
    }
    return true;
  } catch (e) {
    console.error("Turnstile check failed", e && e.message);
    return false;
  }
}

/* ---------- signed party tokens ---------- */
const enc = new TextEncoder();
const b64u    = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const b64uDec = s   => Uint8Array.from(atob(String(s).replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));

// Cached against the secret it was derived from. An isolate can outlive a secret change —
// Cloudflare may keep warm instances across a binding-only update — so a cache that ignored
// the secret would keep accepting and minting tokens under the old key, and rotating the
// secret (the only revocation lever there is) would silently not revoke anything.
let keyCache = { secret: null, key: null };
function signingKey(env) {
  const secret = env.RSVP_SIGNING_KEY;
  if (!secret) throw new Error("RSVP_SIGNING_KEY is not set");
  if (keyCache.secret !== secret) {
    keyCache = { secret, key: crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]) };
  }
  return keyCache.key;
}

async function signToken(env, obj) {
  const payload = b64u(enc.encode(JSON.stringify(obj)));
  const sig = await crypto.subtle.sign("HMAC", await signingKey(env), enc.encode(payload));
  return payload + "." + b64u(sig);
}

// Returns the payload, or null if the token is forged, malformed or expired.
// Everything, including coercing the input to a string, happens inside the guard: a JSON
// body can carry an object whose toString throws, and that must be a clean denial rather
// than a 500. A token is exactly two dot-separated parts — a trailing third was previously
// ignored, which is not forgeable but is not canonical either.
const MAX_TOKEN = 4096;
async function readToken(env, token) {
  try {
    if (typeof token !== "string" || !token || token.length > MAX_TOKEN) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    if (!payload || !sig) return null;
    if (!(await crypto.subtle.verify("HMAC", await signingKey(env), b64uDec(sig), enc.encode(payload)))) return null;
    const obj = JSON.parse(new TextDecoder().decode(b64uDec(payload)));
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    if (typeof obj.p !== "string" || !obj.p) return null;
    if (!Array.isArray(obj.g) || !obj.g.every(id => typeof id === "string" && id)) return null;
    if (!Number.isFinite(obj.exp) || Date.now() > obj.exp) return null;
    return obj;
  } catch { return null; }
}

/* ---------- lookup ---------- */

// The guest list changes rarely but is read on every lookup, so cache it briefly.
// Only the fields below are cached, and none of them are written by an RSVP, so a
// submission never leaves stale data behind — edits you make in Airtable show up
// within GUESTS_TTL_MS. The promise (not the result) is cached, so a burst of
// simultaneous lookups shares one Airtable call; failures are not cached.
const GUESTS_TTL_MS = 60 * 1000;
let guestCache = { at: 0, table: null, rows: null };

function guestRows(env) {
  if (!guestCache.rows || guestCache.table !== env.GUESTS_TABLE || Date.now() - guestCache.at > GUESTS_TTL_MS) {
    guestCache = {
      at: Date.now(),
      table: env.GUESTS_TABLE,
      rows: fetchGuests(env).catch(e => { guestCache = { at: 0, table: null, rows: null }; throw e; }),
    };
  }
  return guestCache.rows;
}

async function fetchGuests(env) {
  // Pull the guest list (≤100 rows) and match in the Worker — avoids formula-injection games.
  let all = [], offset = "";
  do {
    // returnFieldsByFieldId is essential: without it Airtable keys the response by field
    // NAME, every G.* lookup below is undefined, and every surname silently fails to match.
    const j = await atJson(env, `${env.GUESTS_TABLE}?pageSize=100&returnFieldsByFieldId=true&fields[]=${G.full}&fields[]=${G.last}&fields[]=${G.lookup}&fields[]=${G.party}&fields[]=${G.type}` + (offset ? `&offset=${offset}` : ""));
    all = all.concat(j.records || []); offset = j.offset || "";
  } while (offset);

  // If rows came back but none carry the field IDs we index by, we are reading the wrong
  // shape — almost certainly returnFieldsByFieldId got dropped, or a field was deleted and
  // recreated with a new ID. Fail loudly: the alternative is every lookup quietly matching
  // nobody, which is indistinguishable from "that surname isn't on the list".
  if (all.length && !all.some(g => g.fields[G.full] || g.fields[G.last])) {
    console.error("Guests returned without the expected field IDs — check returnFieldsByFieldId and the G.* ids. Got keys:",
      JSON.stringify(Object.keys(all[0].fields || {})));
    throw new Error("guest fields unrecognised");
  }
  return all;
}

async function lookup(env, surname) {
  const q = norm(surname);
  if (q.length < 2 || q.length > 40) return [];
  const all = await guestRows(env);

  // Exact surname only. "Lookup names" holds alternative spellings / Greek forms,
  // comma-separated; each alternative must also match in full.
  const matches = g => norm(g.fields[G.last]) === q
    || String(g.fields[G.lookup] || "").split(",").map(norm).filter(Boolean).includes(q);

  const hitParties = new Set(all.filter(matches).flatMap(g => g.fields[G.party] || []));
  return Promise.all([...hitParties].map(async pid => {
    const members = all.filter(g => (g.fields[G.party] || []).includes(pid));
    return {
      // The record IDs live inside the signed token, not in the response body.
      token: await signToken(env, { p: pid, g: members.map(m => m.id), exp: Date.now() + TOKEN_TTL_MS }),
      guests: members.map(m => ({ name: m.fields[G.full], type: m.fields[G.type] })),
    };
  }));
}

/* ---------- response hardening ---------- */
// The page is one HTML file with an inline <style> and an inline <script>, so the policy
// has to admit 'unsafe-inline' for both. Everything else is locked to what the page really
// uses: Google Fonts for the faces, Turnstile for the widget, self for the rest.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

function harden(res, isHttps) {
  const h = new Headers(res.headers);
  h.set("Content-Security-Policy", CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  if (isHttps) h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// RSVP mode is off until invitations go out in January. While it is off, the guest lookup,
// the per-guest writes and the bank details are not reachable at all — they are not used by
// the page yet, and leaving them live only exposes the guest list and the account details
// for no benefit. Flip RSVP_OPEN to "true" in wrangler.toml when the RSVP phase starts.
const rsvpOpen = env => env.RSVP_OPEN === "true";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Cloudflare terminates TLS, so an http:// visitor reaches us with the scheme intact.
    // Redirect before anything else. (Also turn on "Always Use HTTPS" in the dashboard —
    // this handles the Worker's own routes, that handles everything else.)
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol === "http:" && !local) {
      url.protocol = "https:";
      return new Response(null, { status: 301, headers: { Location: url.toString(), "Cache-Control": "no-store" } });
    }
    // HSTS only on real HTTPS responses; sending it from `wrangler dev` would pin localhost.
    const https = url.protocol === "https:";

    if (!url.pathname.startsWith("/api/")) return harden(await env.ASSETS.fetch(request), https);
    if (request.method === "OPTIONS") return harden(new Response(null, { headers: cors(env) }), https);

    const ip = request.headers.get("CF-Connecting-IP") || "anon";
    const done = res => harden(res, https);

    /* ---- GET /api/lookup ---- */
    if (request.method === "GET" && url.pathname === "/api/lookup") {
      if (!rsvpOpen(env)) return done(json({ error: "Not found" }, 404, env));
      if (env.LOOKUP_LIMIT && !(await env.LOOKUP_LIMIT.limit({ key: ip })).success)
        return done(json({ error: "Too many attempts. Please wait a minute and try again." }, 429, env));
      const surname = url.searchParams.get("surname") || url.searchParams.get("lookup") || "";
      try {
        return done(json({ parties: await lookup(env, surname) }, 200, env));
      } catch (e) {
        console.error("lookup failed", e && e.message);
        return done(json({ error: "Lookup is unavailable right now. Please email us." }, 503, env));
      }
    }

    /* ---- GET /api/bank ---- */
    // Bank details live in secrets, not in the HTML, so they are not in the repo, in Drive,
    // or in the page source. Each is a plain string — no JSON to quote or escape:
    //   wrangler secret put BANK_EU_NAME     (and BANK_EU_IBAN, BANK_EU_BIC)
    //   wrangler secret put BANK_UK_NAME     (and BANK_UK_SORT, BANK_UK_ACCOUNT)
    // Either half can be left unset; the page hides whichever card has no details.
    if (request.method === "GET" && url.pathname === "/api/bank") {
      // Only reachable once the RSVP phase opens. The gifts section is hidden before then,
      // so serving account details to anyone who asks bought nothing.
      if (!rsvpOpen(env)) return done(json({ error: "Not found" }, 404, env));
      if (env.BANK_LIMIT && !(await env.BANK_LIMIT.limit({ key: ip })).success)
        return done(json({ error: "Too many requests. Please wait a minute." }, 429, env));
      const out = {};
      if (env.BANK_EU_IBAN) out.eu = { name: env.BANK_EU_NAME || "", iban: env.BANK_EU_IBAN, bic: env.BANK_EU_BIC || "" };
      if (env.BANK_UK_ACCOUNT) out.uk = { name: env.BANK_UK_NAME || "", sort: env.BANK_UK_SORT || "", account: env.BANK_UK_ACCOUNT };
      if (!out.eu && !out.uk) { console.warn("No bank details configured — set BANK_EU_IBAN and/or BANK_UK_ACCOUNT"); return done(json({ error: "unconfigured" }, 503, env)); }
      return done(json(out, 200, env));
    }

    if (request.method !== "POST" || url.pathname !== "/api/rsvp") return done(json({ error: "Not found" }, 404, env));
    if (env.RSVP_LIMIT && !(await env.RSVP_LIMIT.limit({ key: ip })).success)
      return done(json({ error: "Too many submissions. Please wait a minute and try again." }, 429, env));

    // Parse either multipart/urlencoded FormData or JSON. A null-prototype object so that a
    // field literally called "constructor" or "__proto__" is ordinary data, and `dup` records
    // which keys arrived more than once — a repeated field is ambiguous, not a checkbox list,
    // for everything except the known multi-value ones.
    let data = Object.create(null);
    const dup = new Set();
    const ct = request.headers.get("content-type") || "";
    try {
      if (ct.includes("application/json")) {
        const body = await request.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) return done(json({ error: "Bad request" }, 400, env));
        Object.assign(data, body);
      } else {
        const fd = await request.formData();
        for (const [k, v] of fd.entries()) {
          if (k in data) { dup.add(k); data[k] = [].concat(data[k], v); }
          else data[k] = v;
        }
      }
    } catch {
      return done(json({ error: "Bad request" }, 400, env));
    }

    // Honeypot: the form has a hidden "website" field that humans never fill.
    if (data.website) return done(json({ ok: true }, 200, env));

    if (!(await turnstileOk(env, data["cf-turnstile-response"], ip)))
      return done(json({ error: "We couldn't verify that you're human. Please reload and try again." }, 403, env));

    // `phase` selects a schema; it is not a capability. Guest writes are gated on the token
    // and on RSVP being open, never on this value.
    const phaseIn = data.phase === "interest" ? "interest" : data.phase === "rsvp" ? "rsvp" : null;
    if (!phaseIn) return done(json({ error: "Bad request" }, 400, env));
    if (phaseIn === "rsvp" && !rsvpOpen(env))
      return done(json({ error: "RSVPs aren't open yet." }, 403, env));

    const name = cap(data.name || "", 200);
    const email = cap(data.email || "", 254);
    if (!name || !isEmail(email)) {
      return done(json({ error: "Name and a valid email are required" }, 400, env));
    }

    // A field that should appear once but arrived twice is ambiguous — silently taking one
    // of them is how "coming" became "Not coming". Reject it instead. `events` and the per-
    // guest `ev<n>` sets are the only fields legitimately repeated.
    const repeated = [...dup].filter(k => k !== "events" && !/^ev\d+$/.test(k));
    if (repeated.length) return done(json({ error: "That form was submitted twice over. Please reload and try again." }, 400, env));

    const phase = phaseIn === "interest" ? "Interest (save-the-date)" : "RSVP";
    const fields = {
      [FIELD.name]: name,
      [FIELD.email]: email,
      [FIELD.phase]: phase,
    };

    // Everything below is either allowlisted or length-capped, so a submission can add
    // rows but can never introduce new select options or oversized cells.

    // Interest form (save-the-date phase)
    if (data.likely !== undefined) {
      const likely = oneOf(data.likely, LIKELY);
      if (!likely) return done(json({ error: "Please choose one of the options offered." }, 400, env));
      fields[FIELD.likely] = likely;
    }
    if (data.guests !== undefined && data.guests !== "") {
      const n = Number(data.guests);
      if (!Number.isInteger(n) || n < 1 || n > 20)
        return done(json({ error: "Please give a whole number of guests." }, 400, env));
      fields[FIELD.guests] = n;
    }
    if (data.message) fields[FIELD.message] = cap(data.message, 2000);
    if (data.room === "on" || data.room === "true") fields[FIELD.staying] = "Wants a room via us";

    // Full RSVP (phase 2)
    let attending = null;
    if (data.attending !== undefined) {
      attending = oneOf(data.attending, ATTENDING);
      if (!attending) return done(json({ error: "Please choose one of the options offered." }, 400, env));
      fields[FIELD.attending] = attending;
    }
    if (data.events !== undefined) {
      const raw = [].concat(data.events);
      const ev = [...new Set(raw.map(v => oneOf(v, EVENTS)))];
      if (ev.includes(null)) return done(json({ error: "Please choose one of the options offered." }, 400, env));
      // Declining and ticking events is contradictory; taking both produces catering numbers
      // that disagree with the headcount.
      if (attending === "Regretfully declines" && ev.length)
        return done(json({ error: "You've declined but also selected events. Please reload and try again." }, 400, env));
      if (ev.length) fields[FIELD.events] = ev;
    }
    if (data.staying) fields[FIELD.staying] = cap(data.staying, 200);
    if (data.nights) fields[FIELD.nights] = cap(data.nights, 200);
    if (data.dietary) fields[FIELD.dietary] = cap(data.dietary, 1000);
    if (data.song) fields[FIELD.song] = cap(data.song, 200);
    if (data.edinburgh) fields[FIELD.edinburgh] = true;
    if (data.lift === "on" || data.lift === "true") fields[FIELD.lift] = true;

    /* ---- per-guest ticks, authorised by the signed party token ---- */
    // Guests are named by position (g0, g1, …) within the token's guest list, so a
    // submission can only ever update the party its token was issued for. Every index and
    // every answer is validated before a single write: an unreadable answer must be a 400,
    // never a quietly recorded decline.
    const GUEST_ANSWER = { coming: "Coming", declined: "Not coming" };
    const guestKeys = Object.keys(data).filter(k => /^g\d/.test(k));
    if (guestKeys.length || data.token !== undefined) {
      if (!rsvpOpen(env)) return done(json({ error: "RSVPs aren't open yet." }, 403, env));
      const tok = await readToken(env, data.token);
      if (!tok) return done(json({ error: "Your session expired. Please look up your name again." }, 403, env));

      const updates = [], seen = new Set();
      for (const k of guestKeys) {
        const m = /^g(\d+)$/.exec(k);
        // "g00", "g1e2", "g 1" and friends: canonical decimal only, so one guest cannot be
        // addressed twice under two spellings.
        if (!m || String(Number(m[1])) !== m[1]) return done(json({ error: "Bad request" }, 400, env));
        const i = Number(m[1]);
        const id = tok.g[i];
        if (!id) return done(json({ error: "Bad request" }, 400, env));
        if (seen.has(id)) return done(json({ error: "Bad request" }, 400, env));
        seen.add(id);

        const answer = GUEST_ANSWER[data[k]];
        if (!answer) return done(json({ error: "Please say whether each guest is coming." }, 400, env));

        const evRaw = data["ev" + m[1]] === undefined ? [] : [].concat(data["ev" + m[1]]);
        const ev = [...new Set(evRaw.map(v => oneOf(v, EVENTS)))];
        if (ev.includes(null)) return done(json({ error: "Please choose one of the options offered." }, 400, env));
        if (answer === "Not coming" && ev.length)
          return done(json({ error: "A guest marked as not coming also has events selected." }, 400, env));

        updates.push({ id, fields: { [G.rsvp]: answer,
          [G.sun]: ev.includes("Sunday welcome"), [G.mon]: ev.includes("Monday wedding"), [G.tue]: ev.includes("Tuesday lunch") } });
      }
      // An ev<n> with no matching g<n> means the form and the token disagree.
      for (const k of Object.keys(data)) {
        const m = /^ev(\d+)$/.exec(k);
        if (m && !(("g" + m[1]) in data)) return done(json({ error: "Bad request" }, 400, env));
      }

      try {
        for (let i = 0; i < updates.length; i += 10)
          await atJson(env, env.GUESTS_TABLE, { method: "PATCH", body: JSON.stringify({ records: updates.slice(i, i + 10) }) });
      } catch {
        return done(json({ error: "Could not save your response" }, 502, env));
      }
      fields[FIELD.party] = [tok.p];             // the party comes from the token, never the client
    }

    try {
      // typecast is off: every select value is allowlisted above and already exists in the
      // base, so an unexpected value should fail loudly rather than create a new option.
      await atJson(env, env.AIRTABLE_TABLE, { method: "POST", body: JSON.stringify({ records: [{ fields }] }) });
    } catch {
      return done(json({ error: "Could not save your response" }, 502, env));
    }
    return done(json({ ok: true }, 200, env));
  },
};
