/**
 * RSVP endpoint for the wedding site.
 * Receives a form POST (FormData or JSON), validates lightly, and creates one
 * record in the Airtable "RSVPs" table. The Airtable token never leaves the Worker.
 *
 * Secrets / vars (set with `wrangler secret put` — see README):
 *   AIRTABLE_TOKEN   personal access token, scope: data.records:write on the wedding base
 *   AIRTABLE_BASE    appivWbWyQlQqGJTB
 *   AIRTABLE_TABLE   tblfcALpXOklfXfG0            (RSVPs)
 *   GUESTS_TABLE     tbllrariezt3kKrsq            (Guests — one row per person)
 *
 * Routes:
 *   GET  ?lookup=<surname>   → parties whose members match the surname, with each member's id/name/type
 *   POST (phase=interest)    → one row in RSVPs
 *   POST (phase=rsvp)        → one row in RSVPs, plus per-guest RSVP/event ticks on Guests (fields guest_<id>=coming|declined,
 *                              ev_<id>=Sunday welcome|Monday wedding|Tuesday lunch, repeated)
 *   ALLOWED_ORIGIN   https://wedding.farsarakis.com  (CORS — the site's origin)
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
};

const cors = (env) => ({
  "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

const json = (body, status, env) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(env) },
  });

const G = { full:"fldA7jCu6kwHedyV3", last:"fldwN5bOcSXwT1UcS", lookup:"fldRzXJbyHOWbVUwI", party:"fld0LbFHmkkJmahT5",
            type:"fld4kGC6dP4Pq4xXo", rsvp:"fldIehdhZfhVITN2B", sun:"fldMVTk5vfBRlU597", mon:"fld3xllk6lknr9ebK", tue:"fld3rTa7sR7z0jih0" };
const at = (env, path, init={}) => fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${path}`, {
  ...init, headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json", ...(init.headers||{}) } });
const norm = s => String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z\u0370-\u03ff]/g,"");

async function lookup(env, surname) {
  const q = norm(surname); if (q.length < 3) return [];
  // Pull surname + lookup fields for all guests (≤100 rows) and match in the Worker — avoids formula-injection games.
  let all = [], offset = "";
  do {
    const r = await at(env, `${env.GUESTS_TABLE}?pageSize=100&fields[]=${G.full}&fields[]=${G.last}&fields[]=${G.lookup}&fields[]=${G.party}&fields[]=${G.type}&fields[]=${G.rsvp}` + (offset ? `&offset=${offset}` : ""));
    const j = await r.json(); all = all.concat(j.records || []); offset = j.offset || "";
  } while (offset);
  const hitParties = new Set(all.filter(g => norm(g.fields[G.last]).includes(q) || norm(g.fields[G.lookup]).includes(q))
                                .flatMap(g => g.fields[G.party] || []));
  return [...hitParties].map(pid => ({
    party: pid,
    guests: all.filter(g => (g.fields[G.party]||[]).includes(pid))
               .map(g => ({ id: g.id, name: g.fields[G.full], type: g.fields[G.type], rsvp: g.fields[G.rsvp] }))
  }));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    const url = new URL(request.url);
    if (request.method === "GET" && url.searchParams.get("lookup"))
      return json({ parties: await lookup(env, url.searchParams.get("lookup")) }, 200, env);
    if (request.method !== "POST") return json({ error: "POST only" }, 405, env);

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

    const name = String(data.name || "").trim();
    const email = String(data.email || "").trim();
    if (!name || !email || !email.includes("@")) {
      return json({ error: "Name and a valid email are required" }, 400, env);
    }

    const phase = data.phase === "interest" ? "Interest (save-the-date)" : "RSVP";
    const fields = {
      [FIELD.name]: name,
      [FIELD.email]: email,
      [FIELD.phase]: phase,
    };

    // Interest form (save-the-date phase)
    if (data.likely) fields[FIELD.likely] = String(data.likely);
    if (data.guests) fields[FIELD.guests] = Number(data.guests) || 1;
    if (data.message) fields[FIELD.message] = String(data.message);
    if (data.room === "on" || data.room === "true") fields[FIELD.staying] = "Wants a room via us";

    // Full RSVP (phase 2)
    if (data.attending) fields[FIELD.attending] = String(data.attending);
    if (data.events) fields[FIELD.events] = [].concat(data.events).map(String);
    if (data.staying) fields[FIELD.staying] = String(data.staying);
    if (data.nights) fields[FIELD.nights] = String(data.nights);
    if (data.dietary) fields[FIELD.dietary] = String(data.dietary);
    if (data.song) fields[FIELD.song] = String(data.song);
    if (data.edinburgh) fields[FIELD.edinburgh] = true;
    if (data.lift === "on" || data.lift === "true") fields[FIELD.lift] = true;

    // Per-guest ticks from the party picker (phase 2)
    const updates = [];
    for (const [k, v] of Object.entries(data)) {
      if (!k.startsWith("guest_")) continue;
      const id = k.slice(6), ev = [].concat(data["ev_" + id] || []).map(String);
      updates.push({ id, fields: { [G.rsvp]: v === "coming" ? "Coming" : "Not coming",
        [G.sun]: ev.includes("Sunday welcome"), [G.mon]: ev.includes("Monday wedding"), [G.tue]: ev.includes("Tuesday lunch") } });
    }
    for (let i = 0; i < updates.length; i += 10)
      await at(env, env.GUESTS_TABLE, { method: "PATCH", body: JSON.stringify({ records: updates.slice(i, i + 10) }) });
    if (data.party) fields["fldIYJjlsLiSoQoZO"] = [String(data.party)]; // link RSVP row to the Party

    const res = await fetch(
      `https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${env.AIRTABLE_TABLE}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: [{ fields }], typecast: true }),
      }
    );

    if (!res.ok) {
      const detail = await res.text();
      console.error("Airtable error", res.status, detail);
      return json({ error: "Could not save your response" }, 502, env);
    }
    return json({ ok: true }, 200, env);
  },
};
