# George & Manos — wedding site

One Cloudflare Worker serves everything: the static site from `public/` and the RSVP API from `src/worker.js` (`/api/rsvp`, `/api/lookup`). Free tier, same origin, no CORS.

## Layout
- `public/index.html` — the site. Key details in the `SITE` object at the bottom; Greek strings in `EL`.
- `public/hero-watercolour.png` — hero image.
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
Both keys are needed: until `TURNSTILE_SECRET` is set the Worker skips the check and logs a
warning on every submission (`wrangler tail` to see it); until the site key is set the forms
send no token and would be rejected. Set the secret and the site key together.

Every value that reaches a dropdown is allowlisted against the choices already in the base
(`ATTENDING`, `LIKELY`, `EVENTS` at the top of `src/worker.js`) and `typecast` is off, so a
junk submission can never add a new select option. If you add a choice in Airtable, add it
to the matching list too.

## How the RSVP lookup is secured
`/api/lookup?surname=…` matches the **whole** surname (or a whole entry in the Guests
table's *Lookup names*), never a fragment, and is rate-limited per IP. It returns each party
member's display name and type — no Airtable record IDs, no RSVP status — plus a short-lived
token signed with `RSVP_SIGNING_KEY`.

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
Either half can be left out: a card only appears if its `IBAN` / `ACCOUNT` is set. With
neither set, `/api/bank` returns 503 and the page replaces both cards with "write to us for
our bank details", so nothing looks broken. `SITE.paypal` in `public/index.html` still needs
your real PayPal handle for the fallback link.

For `wrangler dev`, put the same names in a `.dev.vars` file (gitignored). Note that
`wrangler dev` does **not** reload that file — restart it after an edit.

## Duplicate RSVPs
Every submission appends a row, so a change of mind is kept rather than overwritten and you
can see what someone said and when. For a clean headcount, make a view in Airtable → RSVPs:
*Group by* Email, *Sort* Submitted ↓ — the top row in each group is that guest's current
answer. The per-guest ticks on the **Guests** table are always overwritten, so that table
already reflects only the latest answer and is the one to count from.

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
