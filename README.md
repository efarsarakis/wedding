# George & Manos — wedding site

One Cloudflare Worker serves everything: the static site from `public/` and the RSVP API from `src/worker.js` (`/api/rsvp`, `/api/lookup`). Free tier, same origin, no CORS.

## Layout
- `public/index.html` — the site. Key details in the `SITE` object at the bottom; Greek strings in `EL`.
- `public/hero-1536.webp`, `public/hero-960.webp` — hero image; PNG master in `assets-src/`.
- `src/worker.js` — RSVP endpoint writing to Airtable.
- `wrangler.toml` — config. Base/table IDs are vars; the Airtable token is a secret.

## First deploy (once)
```bash
npm install -g wrangler
wrangler login
wrangler secret put AIRTABLE_TOKEN      # Airtable PAT, this base only
wrangler secret put RSVP_SIGNING_KEY    # any random string: openssl rand -base64 32
wrangler deploy
```
Prints `https://wedding-rsvp.<your-subdomain>.workers.dev`. Test the interest form; a row should appear in Airtable → RSVPs.

The Airtable PAT needs **both** `data.records:read` and `data.records:write`. Without the read
scope, `/api/lookup` returns no matches for every surname and the RSVP party picker silently
does nothing — check the token at Airtable → Developer hub → Personal access tokens.

## Turnstile (bot check)
Create a widget at Cloudflare dashboard → Turnstile, then:
```bash
wrangler secret put TURNSTILE_SECRET     # the widget's secret key
```
and paste the **site key** into `SITE.turnstileSiteKey` in `public/index.html`.
Both keys are needed, and the Worker **fails closed**: with no `TURNSTILE_SECRET` it refuses
every submission and logs an error, rather than quietly accepting them. Set the secret and
the site key together. For `wrangler dev` and the tests, `TURNSTILE_OPTIONAL = "true"` in
`.dev.vars` is the explicit opt-out — never set it on the deployed Worker.

`TURNSTILE_HOSTNAMES` in `wrangler.toml` lists the hostnames a token may be issued on.
Cloudflare's `siteverify` returns `success: true` for any valid token, including one minted
by a different site's widget, so the hostname is checked too.

Every value that reaches a dropdown is allowlisted against the choices already in the base
(`ATTENDING`, `LIKELY`, `EVENTS` at the top of `src/worker.js`) and `typecast` is off, so a
junk submission can never add a new select option. If you add a choice in Airtable, add it
to the matching list too.

## How the RSVP lookup is secured
`/api/lookup?surname=…` matches the **whole** surname (or a whole entry in the Guests
table's *Lookup names*), never a fragment, and is rate-limited per IP. It returns each party
member's display name and type, no RSVP status, plus a short-lived token signed with
`RSVP_SIGNING_KEY`.

That token is **signed, not encrypted**: anyone can base64-decode it and read the party and
guest record IDs inside. That is deliberate and harmless — every Airtable operation needs the
API token, which never leaves the Worker, so the IDs alone grant nothing, and you only get
them for a party whose surname you already matched in full. What the signature buys is that
the token cannot be forged or extended: you cannot mint one for a party you never looked up,
and adding a guest to the list invalidates it. If you ever want the IDs opaque too, encrypt
the payload with AES-GCM instead of signing it.

`/api/rsvp` will only tick guests named by their **index in that signed token** (`g0`, `g1`, …,
with repeated `ev0`, `ev1`, … for events). A submission therefore can't touch anybody outside
the party its token was issued for, and the Party link on the new RSVP row is taken from the
token rather than from the form. Run `npm test` to check all of this still holds.

## Deploy on push (recommended)
Cloudflare dashboard → Workers & Pages → `wedding-rsvp` → Settings → Builds → *Connect to Git* → choose this repo, branch `main`, build command empty, deploy command `wrangler deploy`. From then on, every push deploys.

## Custom domain
Workers & Pages → `wedding-rsvp` → Settings → Domains & Routes → *Add custom domain*. If the domain is registered at Cloudflare, DNS and HTTPS are handled automatically. Then set `SITE.contactEmail` and re-render the cards with the real URL.

## Gifts / bank details
Bank transfer is the main route — PayPal takes a percentage, so it's offered only as a
fallback underneath. The account details are **not** in `index.html`; they live in a Worker
secrets and are fetched from `/api/bank` when a guest scrolls to the gifts section. Each is a
plain string, so there's no JSON to quote:
```bash
wrangler secret put BANK_EU_NAME      # Greece / eurozone — SEPA transfer
wrangler secret put BANK_EU_IBAN
wrangler secret put BANK_EU_BIC
wrangler secret put BANK_UK_NAME      # UK — Faster Payments
wrangler secret put BANK_UK_SORT
wrangler secret put BANK_UK_ACCOUNT
```
Either half can be left out: the page hides a card whose details are missing. With neither
set, `/api/bank` returns 503 and the page replaces both cards with "write to us for our bank
details". **The endpoint only answers while `RSVP_OPEN` is `"true"`** — before that it 404s,
so the account details are not fetchable during the save-the-date phase. `SITE.paypal` in `public/index.html` still needs
your real PayPal handle for the fallback link.

For `wrangler dev`, put the same names in a `.dev.vars` file (gitignored). Note that
`wrangler dev` does **not** reload that file — restart it after an edit.

## Duplicate RSVPs
Every submission appends a row, so a change of mind is kept rather than overwritten and you
can see what someone said and when. For a clean headcount, make a view in Airtable → RSVPs:
*Group by* Email, *Sort* Submitted ↓ — the top row in each group is that guest's current
answer. The per-guest ticks on the **Guests** table are overwritten by each submission, so
it usually reflects the latest answer — but see the caveat below: two submissions that
overlap in time can leave Guests and the newest RSVP row disagreeing. Spot-check anything
that looks odd against the timestamps rather than trusting either blindly.

## Modes
`SITE.mode = "savethedate"` now → `"rsvp"` when invitations go out (January).

## Local preview
`wrangler dev` → http://localhost:8787 (real fonts, real hero, real API).

## Tests
`npm test` — runs `test/rsvp.test.mjs` against `src/worker.js` with Airtable mocked. It covers
the surname matching, the signed tokens, the select allowlists and the Turnstile check. No
network, no Airtable calls, runs in about a second. Worth running before any deploy.

## Why `.git` is a file, not a folder
This folder lives inside Google Drive, and Drive syncing a `.git` directory is a known way to
corrupt a repository. The git database therefore lives at `~/.git-stores/wedding-repo`, and
the `.git` here is a one-line pointer to it. Everything (`git status`, `commit`, `push`, your
editor) behaves normally; Drive only ever syncs the pointer.

One consequence: **`~/.git-stores/wedding-repo` is not backed up by Drive.** Push to GitHub
as usual and that is your backup.


## RSVP phase switch
`RSVP_OPEN` in `wrangler.toml` is `"false"` until invitations go out. While it is false,
`/api/lookup`, `/api/bank` and every per-guest write return 404 or 403 — the page does not
use them yet, and leaving them reachable exposed the guest list and the account details for
no benefit. Set it to `"true"` (and `SITE.mode = "rsvp"` in `public/index.html`) in January.

## Accepted risk: surname-only access
A guessed surname returns that household's member names and a token that can set their RSVP.
There is no second factor. This is a deliberate choice — no code is printed on the
invitations — and the mitigations around it (exact matching, rate limits, Turnstile on
writes, endpoints closed until January) **reduce abuse rather than remove the capability**.
A security review on 20 September 2026 judged this incompatible with the stated goals of a
private guest list and preventing others from altering an RSVP. If that trade stops feeling
right, per-party invitation links are the fix; nothing else in the design has to change.

## Known limitation: overlapping submissions
Guest ticks are written before the RSVP row is appended. Two submissions for the same party
that overlap can finish with the Guests table and the newest RSVP row disagreeing, and an
Airtable failure part-way through can leave guest rows updated with no RSVP row written.
Retrying converges the guest ticks, which are idempotent, but appends a duplicate row.
Fixing this properly needs a stable submission id and per-party serialisation; it is not
done. Before finalising catering numbers, reconcile the two tables rather than trusting one.
