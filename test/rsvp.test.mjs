import worker from "../src/worker.js";

const G = { full:"fldA7jCu6kwHedyV3", last:"fldwN5bOcSXwT1UcS", lookup:"fldRzXJbyHOWbVUwI",
            party:"fld0LbFHmkkJmahT5", type:"fld4kGC6dP4Pq4xXo" };

const GUESTS = [
  { id:"recFAR1", fields:{ [G.full]:"Yanni Farsarakis", [G.last]:"Farsarakis", [G.party]:["recPartyA"], [G.type]:"Adult" } },
  { id:"recFAR2", fields:{ [G.full]:"Kay Farsarakis",   [G.last]:"Farsarakis", [G.party]:["recPartyA"], [G.type]:"Adult" } },
  { id:"recGRN1", fields:{ [G.full]:"Tom Green",        [G.last]:"Green",      [G.party]:["recPartyB"], [G.type]:"Adult" } },
  { id:"recSOP1", fields:{ [G.full]:"Giorgos Sopasis",  [G.last]:"Sopasis", [G.lookup]:"Σοπασης, Sopassis", [G.party]:["recPartyC"], [G.type]:"Adult" } },
];

let patches = [], getCount = 0, posted = [], turnstilePass = true;
globalThis.fetch = async (url, init={}) => {
  const u = String(url);
  if (u.includes("tblGUESTS")) {
    if (init.method === "PATCH") { patches.push(JSON.parse(init.body).records); return new Response('{"records":[]}',{status:200}); }
    getCount++;
    // Airtable keys the response by field NAME unless returnFieldsByFieldId=true.
    const byId = /returnFieldsByFieldId=true/.test(u);
    const NAME = { [G.full]:"Full name", [G.last]:"Last name", [G.lookup]:"Lookup names",
                   [G.party]:"Party", [G.type]:"Type" };
    const records = GUESTS.map(r => ({ id: r.id, fields: Object.fromEntries(
      Object.entries(r.fields).map(([k,v]) => [ byId ? k : (NAME[k] || k), v ]) ) }));
    return new Response(JSON.stringify({ records }), { status:200 });
  }
  if (u.includes("tblRSVPS")) { posted.push(JSON.parse(init.body)); return new Response('{"records":[]}', { status:200 }); }
  if (u.includes("challenges.cloudflare.com")) return new Response(JSON.stringify({ success: turnstilePass, "error-codes":[] }), { status:200 });
  return new Response("nope", { status:404 });
};

const env = { AIRTABLE_BASE:"appTEST", AIRTABLE_TABLE:"tblRSVPS", GUESTS_TABLE:"tblGUESTS",
              AIRTABLE_TOKEN:"tok", RSVP_SIGNING_KEY:"test-signing-key-32-chars-long!!", ASSETS:{fetch:async()=>new Response("asset")} };

const get  = p => worker.fetch(new Request("https://x"+p), env);
const post = body => { const fd=new FormData(); for(const [k,v] of body) fd.append(k,v);
  return worker.fetch(new Request("https://x/api/rsvp",{method:"POST",body:fd}), env); };

let pass=0, fail=0;
const t = (label, ok, extra="") => { ok ? (pass++, console.log("  PASS", label)) : (fail++, console.log("  FAIL", label, extra)); };

console.log("\n== lookup: exact match only ==");
let j = await (await get("/api/lookup?surname=far")).json();
t("partial 'far' returns nothing", j.parties.length === 0, JSON.stringify(j));

j = await (await get("/api/lookup?surname=arsarak")).json();
t("infix 'arsarak' returns nothing", j.parties.length === 0, JSON.stringify(j));

j = await (await get("/api/lookup?surname=Farsarakis")).json();
t("exact 'Farsarakis' returns the party", j.parties.length === 1, JSON.stringify(j));
t("party has both members", j.parties[0]?.guests.length === 2);
t("no Airtable record IDs in response", !JSON.stringify(j).includes("recFAR"), JSON.stringify(j));
t("no RSVP status leaked", !JSON.stringify(j).includes("rsvp"));

let alt = await (await get("/api/lookup?surname=Sopassis")).json();
t("alternative spelling matches", alt.parties.length === 1);
let greek = await (await get("/api/lookup?surname=Σοπασης")).json();
t("Greek spelling matches", greek.parties.length === 1, JSON.stringify(greek));

const tokenA = j.parties[0].token;

console.log("\n== write path: token required and scoped ==");
patches = [];
let r = await post([["name","Attacker"],["email","a@b.com"],["phase","rsvp"],["g0","declined"]]);
t("no token -> 403", r.status === 403, r.status);
t("no PATCH issued", patches.length === 0);

patches = [];
r = await post([["name","Attacker"],["email","a@b.com"],["phase","rsvp"],["token","forged.sig"],["g0","declined"]]);
t("forged token -> 403", r.status === 403, r.status);
t("no PATCH issued", patches.length === 0);

patches = [];
r = await post([["name","Yanni"],["email","y@b.com"],["phase","rsvp"],["token",tokenA],["g0","coming"],["ev0","Monday wedding"],["g1","declined"]]);
t("valid token -> 200", r.status === 200, await r.clone().text());
const recs = patches.flat();
t("patched exactly 2 records", recs.length === 2, JSON.stringify(recs));
t("only this party's records touched", recs.every(x => ["recFAR1","recFAR2"].includes(x.id)), JSON.stringify(recs.map(x=>x.id)));

patches = [];
r = await post([["name","Attacker"],["email","a@b.com"],["phase","rsvp"],["token",tokenA],["g9","declined"]]);
t("out-of-range index touches nothing", patches.flat().length === 0, JSON.stringify(patches));

console.log("\n== old attack from the review: raw record ID ==");
patches = [];
r = await post([["name","Attacker"],["email","a@b.com"],["phase","rsvp"],["guest_recGRN1","declined"]]);
t("guest_<recordId> is now inert", patches.flat().length === 0, JSON.stringify(patches));

console.log("\n== interest form still works without a token ==");
patches = [];
r = await post([["name","Someone"],["email","s@b.com"],["phase","interest"],["likely","Yes"],["guests","2"]]);
t("interest submit -> 200", r.status === 200, await r.clone().text());

console.log("\n== guest list is cached ==");
// a different table id gives this section a cold cache
const coldEnv = { ...env, GUESTS_TABLE:"tblGUESTS2" };
const cold = p => worker.fetch(new Request("https://x"+p), coldEnv);
getCount = 0;
await cold("/api/lookup?surname=Farsarakis");
const afterFirst = getCount;
await cold("/api/lookup?surname=Green");
await cold("/api/lookup?surname=Sopasis");
t("first lookup hits Airtable once", afterFirst === 1, afterFirst);
t("next two lookups are served from cache", getCount === 1, getCount);

console.log("\n== wrong field shape fails loudly, not silently ==");
// Simulate the real bug: Airtable answering with field NAMES because
// returnFieldsByFieldId was dropped from the query.
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init={}) => origFetch(String(url).replace("returnFieldsByFieldId=true","x=1"), init);
r = await worker.fetch(new Request("https://x/api/lookup?surname=Farsarakis"), { ...env, GUESTS_TABLE:"tblGUESTS3" });
t("name-keyed response -> 503, not an empty match", r.status === 503, r.status + " " + await r.clone().text());
globalThis.fetch = origFetch;

console.log("\n== Airtable failure is loud, not silent ==");
const badEnv = { ...env, GUESTS_TABLE:"tblMISSING" };
r = await worker.fetch(new Request("https://x/api/lookup?surname=Farsarakis"), badEnv);
t("read failure -> 503 (not empty 200)", r.status === 503, r.status);
r = await worker.fetch(new Request("https://x/api/lookup?surname=Farsarakis"), badEnv);
t("failure is not cached (still 503, retried)", r.status === 503, r.status);
const good = await (await get("/api/lookup?surname=Farsarakis")).json();
t("good env still works after a failure", good.parties.length === 1, JSON.stringify(good));

console.log("\n== select values are allowlisted (no schema pollution) ==");
posted = [];
r = await post([["name","Spammer"],["email","s@b.com"],["phase","rsvp"],
                ["attending","BUY CHEAP PILLS"],["likely","<script>"],
                ["events","Monday wedding"],["events","Free V1agra"]]);
t("junk submission still returns 200", r.status === 200, r.status);
let f = posted[0].records[0].fields;
t("typecast is off", posted[0].typecast === undefined, JSON.stringify(posted[0]).slice(0,120));
t("junk 'attending' dropped", f["fldBfK0qCznZDDtJG"] === undefined, f["fldBfK0qCznZDDtJG"]);
t("junk 'likely' dropped", f["fldFvNX6Gk2qbTDW8"] === undefined, f["fldFvNX6Gk2qbTDW8"]);
t("only the real event kept", JSON.stringify(f["fld0GcrHpvYtcKrjn"]) === '["Monday wedding"]', JSON.stringify(f["fld0GcrHpvYtcKrjn"]));

posted = [];
r = await post([["name","Kay"],["email","k@b.com"],["phase","rsvp"],["attending","Joyfully accepts"],["events","Sunday welcome"]]);
f = posted[0].records[0].fields;
t("valid values still pass through", f["fldBfK0qCznZDDtJG"] === "Joyfully accepts" && JSON.stringify(f["fld0GcrHpvYtcKrjn"]) === '["Sunday welcome"]', JSON.stringify(f));

posted = [];
r = await post([["name","x".repeat(500)],["email","k@b.com"],["phase","interest"],["message","m".repeat(5000)],["guests","9999"]]);
f = posted[0].records[0].fields;
t("name capped at 200", f["fldsuzKiBlqgLotnJ"].length === 200, f["fldsuzKiBlqgLotnJ"].length);
t("message capped at 2000", f["fldKCNv9cRkQ7fsTD"].length === 2000, f["fldKCNv9cRkQ7fsTD"].length);
t("party size clamped to 20", f["fldDOyeZ675aYZ39G"] === 20, f["fldDOyeZ675aYZ39G"]);

r = await post([["name","Bad"],["email","not-an-email"],["phase","interest"]]);
t("bad email -> 400", r.status === 400, r.status);

console.log("\n== Turnstile ==");
const tsEnv = { ...env, TURNSTILE_SECRET:"sec" };
const tsPost = body => { const fd=new FormData(); for(const [k,v] of body) fd.append(k,v);
  return worker.fetch(new Request("https://x/api/rsvp",{method:"POST",body:fd}), tsEnv); };
turnstilePass = false;
posted = [];
r = await tsPost([["name","Bot"],["email","b@b.com"],["phase","interest"],["cf-turnstile-response","bad"]]);
t("failed Turnstile -> 403", r.status === 403, r.status);
t("nothing written to Airtable", posted.length === 0);
turnstilePass = true;
r = await tsPost([["name","Real"],["email","r@b.com"],["phase","interest"],["cf-turnstile-response","good"]]);
t("passed Turnstile -> 200", r.status === 200, r.status);

console.log("\n== /api/bank ==");
r = await get("/api/bank");
t("no bank secrets -> 503", r.status === 503, r.status);

const bankEnv = { ...env, BANK_EU_NAME:"G & M", BANK_EU_IBAN:"GR1601101250000000012300695", BANK_EU_BIC:"ETHNGRAA",
                          BANK_UK_NAME:"G & M", BANK_UK_SORT:"04-00-04", BANK_UK_ACCOUNT:"12345678" };
r = await worker.fetch(new Request("https://x/api/bank"), bankEnv);
let bank = await r.json();
t("both halves configured -> 200", r.status === 200 && bank.eu.iban === "GR1601101250000000012300695" && bank.uk.account === "12345678", JSON.stringify(bank));

r = await worker.fetch(new Request("https://x/api/bank"), { ...env, BANK_UK_ACCOUNT:"12345678", BANK_UK_SORT:"04-00-04" });
bank = await r.json();
t("UK only -> no eu half returned", r.status === 200 && !bank.eu && bank.uk.account === "12345678", JSON.stringify(bank));

r = await worker.fetch(new Request("https://x/api/bank"), { ...env, BANK_EU_IBAN:"GR16" });
bank = await r.json();
t("EU only -> no uk half returned", r.status === 200 && !bank.uk && bank.eu.iban === "GR16", JSON.stringify(bank));

r = await worker.fetch(new Request("https://x/api/bank",{method:"POST"}), bankEnv);
t("POST /api/bank -> 404", r.status === 404, r.status);

console.log("\n== bank details are not in the page source ==");
const html = await (await import("node:fs/promises")).readFile(new URL("../public/index.html", import.meta.url), "utf8");
t("no bankEncoded left in HTML", !html.includes("bankEncoded"));
t("no base64 account blob left", !/eyJuYW1l/.test(html));

console.log("\n== every element id the script touches exists in the markup ==");
// A silent mismatch here (markup renamed, script not) leaves fields permanently blank,
// which no amount of Worker testing would catch.
const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const used = new Set([
  ...[...html.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]),
  ...[...html.matchAll(/(?<![.\w])set\('([^']+)'/g)].map(m => m[1]),  // the local set() helper, not searchParams.set
]);
const missing = [...used].filter(id => !declared.has(id));
t(`all ${used.size} referenced ids exist`, missing.length === 0, "missing: " + missing.join(", "));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
