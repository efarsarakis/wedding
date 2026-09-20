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
  if (!env.TURNSTILE_SECRET) { console.warn("TURNSTILE_SECRET not set — bot check skipped"); return true; }
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", String(token || ""));
  if (ip && ip !== "anon") body.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const j = await r.json();
    if (!j.success) console.warn("Turnstile rejected", JSON.stringify(j["error-codes"] || []));
    return !!j.success;
  } catch (e) {
    console.error("Turnstile check failed", e && e.message);
    return false;
  }
}

/* ---------- signed party tokens ---------- */
const enc = new TextEncoder();
const b64u    = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const b64uDec = s   => Uint8Array.from(atob(String(s).replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));

let keyCache;
function signingKey(env) {
  if (!env.RSVP_SIGNING_KEY) throw new Error("RSVP_SIGNING_KEY is not set");
  if (!keyCache) keyCache = crypto.subtle.importKey(
    "raw", enc.encode(env.RSVP_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return keyCache;
}

async function signToken(env, obj) {
  const payload = b64u(enc.encode(JSON.stringify(obj)));
  const sig = await crypto.subtle.sign("HMAC", await signingKey(env), enc.encode(payload));
  return payload + "." + b64u(sig);
}

// Returns the payload, or null if the token is forged, malformed or expired.
async function readToken(env, token) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", await signingKey(env), b64uDec(sig), enc.encode(payload)); } catch { return null; }
  if (!ok) return null;
  try {
    const obj = JSON.parse(new TextDecoder().decode(b64uDec(payload)));
    if (!obj || !Array.isArray(obj.g) || typeof obj.exp !== "number" || Date.now() > obj.exp) return null;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });

    const ip = request.headers.get("CF-Connecting-IP") || "anon";

    /* ---- GET /api/lookup ---- */
    if (request.method === "GET" && url.pathname === "/api/lookup") {
      if (env.LOOKUP_LIMIT && !(await env.LOOKUP_LIMIT.limit({ key: ip })).success)
        return json({ error: "Too many attempts. Please wait a minute and try again." }, 429, env);
      const surname = url.searchParams.get("surname") || url.searchParams.get("lookup") || "";
      try {
        return json({ parties: await lookup(env, surname) }, 200, env);
      } catch (e) {
        console.error("lookup failed", e && e.message);
        return json({ error: "Lookup is unavailable right now. Please email us." }, 503, env);
      }
    }

    /* ---- GET /api/bank ---- */
    // Bank details live in secrets, not in the HTML, so they are not in the repo, in Drive,
    // or in the page source. Each is a plain string — no JSON to quote or escape:
    //   wrangler secret put BANK_EU_NAME     (and BANK_EU_IBAN, BANK_EU_BIC)
    //   wrangler secret put BANK_UK_NAME     (and BANK_UK_SORT, BANK_UK_ACCOUNT)
    // Either half can be left unset; the page hides whichever card has no details.
    if (request.method === "GET" && url.pathname === "/api/bank") {
      if (env.BANK_LIMIT && !(await env.BANK_LIMIT.limit({ key: ip })).success)
        return json({ error: "Too many requests. Please wait a minute." }, 429, env);
      const out = {};
      if (env.BANK_EU_IBAN) out.eu = { name: env.BANK_EU_NAME || "", iban: env.BANK_EU_IBAN, bic: env.BANK_EU_BIC || "" };
      if (env.BANK_UK_ACCOUNT) out.uk = { name: env.BANK_UK_NAME || "", sort: env.BANK_UK_SORT || "", account: env.BANK_UK_ACCOUNT };
      if (!out.eu && !out.uk) { console.warn("No bank details configured — set BANK_EU_IBAN and/or BANK_UK_ACCOUNT"); return json({ error: "unconfigured" }, 503, env); }
      return json(out, 200, env);
    }

    if (request.method !== "POST" || url.pathname !== "/api/rsvp") return json({ error: "Not found" }, 404, env);
    if (env.RSVP_LIMIT && !(await env.RSVP_LIMIT.limit({ key: ip })).success)
      return json({ error: "Too many submissions. Please wait a minute and try again." }, 429, env);

    // Parse either multipart/urlencoded FormData or JSON.
    let data = {};
    const ct = request.headers.get("content-type") || "";
    try {
      if (ct.includes("application/json")) {
        data = await request.json();
      } else {
        const fd = await request.formData();
        for (const [k, v] of fd.entries()) {
          if (k in data) data[k] = [].concat(data[k], v); // repeated keys → array (checkboxes)
          else data[k] = v;
        }
      }
    } catch {
      return json({ error: "Bad request" }, 400, env);
    }

    // Honeypot: the form has a hidden "website" field that humans never fill.
    if (data.website) return json({ ok: true }, 200, env);

    if (!(await turnstileOk(env, data["cf-turnstile-response"], ip)))
      return json({ error: "We couldn't verify that you're human. Please reload and try again." }, 403, env);

    const name = cap(data.name || "", 200);
    const email = cap(data.email || "", 254);
    if (!name || !isEmail(email)) {
      return json({ error: "Name and a valid email are required" }, 400, env);
    }

    const phase = data.phase === "interest" ? "Interest (save-the-date)" : "RSVP";
    const fields = {
      [FIELD.name]: name,
      [FIELD.email]: email,
      [FIELD.phase]: phase,
    };

    // Everything below is either allowlisted or length-capped, so a submission can add
    // rows but can never introduce new select options or oversized cells.

    // Interest form (save-the-date phase)
    const likely = oneOf(data.likely, LIKELY);
    if (likely) fields[FIELD.likely] = likely;
    if (data.guests) fields[FIELD.guests] = Math.min(Math.max(Number(data.guests) || 1, 1), 20);
    if (data.message) fields[FIELD.message] = cap(data.message, 2000);
    if (data.room === "on" || data.room === "true") fields[FIELD.staying] = "Wants a room via us";

    // Full RSVP (phase 2)
    const attending = oneOf(data.attending, ATTENDING);
    if (attending) fields[FIELD.attending] = attending;
    if (data.events) {
      const ev = [...new Set([].concat(data.events).map(v => oneOf(v, EVENTS)).filter(Boolean))];
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
    // submission can only ever update the party its token was issued for.
    const wantsGuestTicks = Object.keys(data).some(k => /^g\d+$/.test(k));
    if (wantsGuestTicks || data.token) {
      const tok = await readToken(env, data.token);
      if (!tok) return json({ error: "Your session expired. Please look up your name again." }, 403, env);

      const updates = [];
      for (const [k, v] of Object.entries(data)) {
        const m = /^g(\d+)$/.exec(k);
        if (!m) continue;
        const id = tok.g[Number(m[1])];
        if (!id) continue;                       // index outside the signed list — ignore
        const ev = [].concat(data["ev" + m[1]] || []).map(String);
        updates.push({ id, fields: { [G.rsvp]: v === "coming" ? "Coming" : "Not coming",
          [G.sun]: ev.includes("Sunday welcome"), [G.mon]: ev.includes("Monday wedding"), [G.tue]: ev.includes("Tuesday lunch") } });
      }

      try {
        for (let i = 0; i < updates.length; i += 10)
          await atJson(env, env.GUESTS_TABLE, { method: "PATCH", body: JSON.stringify({ records: updates.slice(i, i + 10) }) });
      } catch {
        return json({ error: "Could not save your response" }, 502, env);
      }
      fields[FIELD.party] = [tok.p];             // the party comes from the token, never the client
    }

    try {
      // typecast is off: every select value is allowlisted above and already exists in the
      // base, so an unexpected value should fail loudly rather than create a new option.
      await atJson(env, env.AIRTABLE_TABLE, { method: "POST", body: JSON.stringify({ records: [{ fields }] }) });
    } catch {
      return json({ error: "Could not save your response" }, 502, env);
    }
    return json({ ok: true }, 200, env);
  },
};
