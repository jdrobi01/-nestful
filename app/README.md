# Nestful — Freemium BETA App

**Release state:** freemium beta. Nest filters, Rhythm Match, and see-who-liked-you
are free; everyone has strict daily caps (8 likes, 2 notes). The Nestful+ purchase
funnel is fully built but disabled via `FEATURES.upgradeEnabled = false` in
`brand.js` — flip it to `true` once the LLC has payment processing. Capped users
see a "coming soon" screen with a waitlist; waitlist joins are tracked per account.

## Founder tools

- **Signup dashboard:** open the app with `#admin` (e.g. `localhost:4517/#admin`) —
  signup totals, onboarding completion, waitlist count, search, per-user table with
  CSV export. Click a row for account actions: resend welcome email, send a password
  reset, or delete the account (two-click confirm).
- **Outbox tab:** every email the app has "sent" (welcome emails, password resets,
  password-changed confirmations) — no real ESP is connected yet, so nothing leaves
  the browser. Review copy here before wiring Resend/Postmark/SendGrid into
  `sendEmail()` in `app.js`.
- **Password management:** self-service change in Edit profile (current + new
  password); "Forgot your password?" on the sign-in screen sends a 1-hour token
  link (`?reset=...`) — same flow a real ESP will send later.
- **Sandbox vs production:** append `?sandbox` to the URL for a completely separate
  data environment (yellow ribbon shows when active). Play freely there; production
  accounts are untouched. `?sandbox#admin` shows the sandbox dashboard.
- **Legal pages:** `terms.html` and `privacy.html` (drafts — see `../legal/` for the
  full versions; attorney review required before launch). Signup requires consent
  and stores an acceptance timestamp on the account.

A zero-cost, no-backend demo of the Nestful concept: landing page, account
creation & sign-in, the three-step "Nest Profile" onboarding pre-screen,
badge reveal, and a match deck that demonstrates mutual pre-screening.

## Run it locally (free)

Any static file server works — there is no build step. The server must serve
the **`nestful/` parent folder**, not just `app/`, since `index.html` loads
files from the sibling `backend/` folder (your Supabase config):

```
cd C:\Users\jrobi\nestful
npx http-server . -p 4517 -c-1
```

Then open **http://localhost:4517/app/**

## Rebrand later — the two replaceable files

The brandmark is intentionally isolated:

| File | What lives there |
|---|---|
| `brand.js` | App name, tagline, logo mark (emoji now, `<img>` snippet later), badge names ("Full Nest" / "Nest-Ready"), storage namespace |
| `brand.css` | All colors, fonts, corner radii, badge colors |

Nothing brand-specific exists anywhere else. Swap those two files and the
whole app rebrands.

## How accounts work (demo grade)

- Accounts live in the browser's `localStorage` under `nestful.accounts`.
- Passwords are salted + SHA-256 hashed via WebCrypto before storage — so
  plaintext passwords are never stored, but this is **demo-grade only**.
  A real launch needs server-side auth (e.g. Supabase/Firebase free tier
  is a natural next step and keeps the "free first" constraint).
- "Sign out" keeps the account; clearing browser data resets everything.

## Free hosting when you want a shareable link

The app is pure static files, so all of these free tiers work as-is:

- **GitHub Pages** — push this folder to a repo, enable Pages.
- **Netlify / Vercel** — drag-and-drop the folder, free tier.
- **Cloudflare Pages** — same, free tier.

## Upgrade path

1. Swap localStorage for Supabase (free tier: real auth + Postgres).
2. Replace the sample match pool (`SAMPLES` in `app.js`) with real profiles.
3. Add photos, messaging, and the safety features from the business plan
   (`../business-plan.md`, Section 8) before any public launch.

**Scaffolding for step 1 is ready** in [`../backend/`](../backend/SETUP.md) —
schema, storage bucket setup, Supabase↔Brevo email wiring, and ready-to-paste
welcome/reset email copy. Follow `backend/SETUP.md` in order; it's written as
a click-by-click guide for the parts only you can do (account creation, DNS).
