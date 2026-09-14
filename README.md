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
wrangler secret put AIRTABLE_TOKEN     # Airtable PAT, scopes data.records:read + write, this base only
wrangler deploy
```
Prints `https://wedding.<your-subdomain>.workers.dev`. Test the interest form; a row should appear in Airtable → RSVPs.

## Deploy on push (recommended)
Cloudflare dashboard → Workers & Pages → `wedding` → Settings → Builds → *Connect to Git* → choose this repo, branch `main`, build command empty, deploy command `wrangler deploy`. From then on, every push deploys.

## Custom domain
Workers & Pages → `wedding` → Settings → Domains & Routes → *Add custom domain*. If the domain is registered at Cloudflare, DNS and HTTPS are handled automatically. Then set `SITE.contactEmail` and re-render the cards with the real URL.

## Modes
`SITE.mode = "savethedate"` now → `"rsvp"` when invitations go out (January).

## Local preview
`wrangler dev` → http://localhost:8787 (real fonts, real hero, real API).

## Note
`public/index.html` and `public/hero-watercolour.png` are large; take them from `wedding-repo.zip` in the parent folder (or from the repo). The other files here are the current versions.
