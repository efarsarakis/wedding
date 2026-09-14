# George & Manos — wedding site

Static single-page site served by GitHub Pages. Everything guests see is `index.html`; the hero image is `hero-watercolour.png`.

- **Edit content:** all key details live in the `SITE` object at the bottom of `index.html` (names, dates, contact email, RSVP endpoint, PayPal, mode). Section text is in the HTML; Greek strings are in the `EL` dictionary just below `SITE`.
- **Modes:** `SITE.mode = "savethedate"` (now) or `"rsvp"` (when invitations go out).
- **RSVP backend:** `worker/` — a Cloudflare Worker that writes to the Airtable base. See `worker/README.md`.
- **Deploy:** push to `main`; Pages serves the root.
- **Custom domain:** add a `CNAME` file containing the domain and a CNAME DNS record pointing at `efarsarakis.github.io`.

The site carries `noindex` and a blocking `robots.txt` — it's for guests with the link, not for search.
