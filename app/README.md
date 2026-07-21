# Nestful — Freemium BETA App

**Release state:** freemium beta, running on real infrastructure. Nest filters,
Rhythm Match, and see-who-liked-you are free; everyone has strict daily caps
(8 likes, 2 notes). The Nestful+ purchase funnel is fully built but disabled
via `FEATURES.upgradeEnabled = false` in `brand.js` — flip it to `true` once
the LLC has payment processing. Capped users see a "coming soon" screen with
a waitlist; waitlist joins are tracked per account.

## Real backend (live)

- **Accounts & data:** Supabase (Postgres + Auth), wired via `../backend/`.
  Onboarding, profile edits, sign-in/out, password change, and forgot/reset
  password are all real — see `backend/SETUP.md` for how it's configured.
- **Transactional email:** Supabase Auth emails (password reset, etc.) send
  through Brevo's SMTP relay, from the verified `nestfulapp.com` domain.
- **Matching deck:** still shows the curated `SAMPLES` in `app.js`, not real
  member-to-member matching — that's the next step once there's a second
  real signup (schema already supports it; see `backend/schema.sql`).
- **Founder visibility:** real member accounts live in Supabase's protected
  `auth.users` table (Dashboard → Authentication → Users) — the in-app
  `#admin` dashboard can't query that directly (by design) and says so.

## Environments — production vs. staging

The exact same code runs in both; only the domain serving it differs
(`backend/supabase-config.js` picks the right Supabase project automatically
based on `location.hostname`). Anything that isn't the literal production
domain — localhost, previews, a staging deploy — falls back to a separate
staging Supabase project, so testing can never touch real user data. A
yellow ribbon banner shows whenever you're not on production.

## Run it locally (free)

Any static file server works — there is no build step. The server must serve
the **`nestful/` parent folder**, not just `app/`, since `index.html` loads
files from the sibling `backend/` folder:

```
cd C:\Users\jrobi\nestful
npx http-server . -p 4517 -c-1
```

Then open **http://localhost:4517/app/** — this will use the staging
Supabase project (once one exists; see `backend/SETUP.md`), never production.

## Rebrand later — the two replaceable files

The brandmark is intentionally isolated:

| File | What lives there |
|---|---|
| `brand.js` | App name, tagline, logo mark (emoji now, `<img>` snippet later), badge names ("Full Nest" / "Nest-Ready"), storage namespace, support email |
| `brand.css` | All colors, fonts, corner radii, badge colors |

Nothing brand-specific exists anywhere else. Swap those two files and the
whole app rebrands.

## Deployment

Deployed via Netlify, connected to this git repo — `main` branch deploys to
`nestfulapp.com`; `staging` branch deploys to a separate staging URL. Push
to `staging` first, verify there, then merge to `main` for production.
