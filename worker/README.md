# RSVP Worker — deploy in ten minutes

One Cloudflare Worker sits between the website's forms and Airtable. The site posts to it; it writes to the RSVPs table using a token stored as a secret. Free tier: 100,000 requests/day.

## 1. Airtable token

Airtable → Developer hub → Personal access tokens → *Create token*
- Scope: `data.records:read` and `data.records:write` (read is needed for the surname lookup)
- Access: only the base **Wedding RSVPs — George & Manos**

Copy the token; you'll paste it once below and never see it again.

## 2. Deploy the Worker

```bash
npm install -g wrangler
wrangler login
mkdir rsvp-worker && cd rsvp-worker
cp /path/to/worker.js .
cat > wrangler.toml <<'EOF'
name = "wedding-rsvp"
main = "worker.js"
compatibility_date = "2026-09-01"

[vars]
AIRTABLE_BASE  = "appivWbWyQlQqGJTB"
AIRTABLE_TABLE = "tblfcALpXOklfXfG0"
GUESTS_TABLE   = "tbllrariezt3kKrsq"
ALLOWED_ORIGIN = "https://wedding.farsarakis.com"
EOF
wrangler secret put AIRTABLE_TOKEN     # paste the token when prompted
wrangler deploy
```

Wrangler prints the endpoint, e.g. `https://wedding-rsvp.<your-subdomain>.workers.dev`. Put that in the website config as `rsvpEndpoint`.

Until the custom domain is live, set `ALLOWED_ORIGIN` to wherever the site is served from (e.g. `https://<user>.github.io`), or `*` while testing.

## 3. Test it

```bash
curl -X POST https://wedding-rsvp.<sub>.workers.dev \
  -F name="Test Guest" -F email="test@example.com" -F phase=interest -F likely=Yes
```

A row should appear in Airtable within a second. Delete it afterwards.

## How the site uses it

Both forms post to the same endpoint. The interest form (save-the-date mode) sends `phase=interest` plus `name`, `email`, `likely` (Yes/Maybe/No), `guests`, `room` and `message`. The full RSVP (phase 2) sends the rest. The Worker only writes fields it receives, so the two phases coexist in one table and the `Phase` column tells them apart.

## Spam

A hidden `website` field on the forms acts as a honeypot; bots fill it, humans can't see it, and the Worker silently drops those. If you ever see junk anyway, add Cloudflare Turnstile — it's a five-line change.

## Surname lookup (phase 2)

`GET https://wedding-rsvp.<sub>.workers.dev/?lookup=farsarakis` returns every party with a member whose Last name or Lookup names contains the text (accent- and case-insensitive, Greek or Latin). The RSVP form uses this: guest types a surname → sees the people in their party → ticks who's coming and to which days → the Worker updates each Guest row and files one RSVP row linked to the Party. Add Greek spellings to **Lookup names** in Airtable (e.g. `Φαρσαράκης`) so relatives can search in Greek.
