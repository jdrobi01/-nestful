# Nestful — Backend Setup (Supabase + Brevo)

**Status: done for production.** Real accounts (Supabase), real password
reset emails routed through Brevo via the verified `nestfulapp.com` domain,
and the app fully wired — this guide is now the reference for how it's
configured, and the template to repeat for a second (staging) Supabase
project. `supabase-config.js` and `supabase-client.js` actually live in
`../app/` (Netlify's site root), not this folder — this folder holds the
schema, docs, and setup steps only.

Everything below was originally written as the parts that need your own
login — account creation, domain verification, and DNS — since I can't do
those for you. Repeat Phase 1 (with a new project) for the staging
environment; Phase 2 (Brevo) only needs doing once, production covers both.

---

## Phase 1 — Supabase (accounts & database)

### 1. Create your project
1. Go to [supabase.com](https://supabase.com) → **Start your project** → sign up (free).
2. **New project** → name it `nestful` → pick a region close to your users (e.g. US) → set a strong database password (save it somewhere safe — a password manager, not this repo) → **Create new project**. Takes ~2 minutes to provision.

### 2. Run the schema
1. In your project, open **SQL Editor** (left sidebar) → **New query**.
2. Open [`schema.sql`](schema.sql) in this folder, copy all of it, paste into the editor.
3. Click **Run**. You should see "Success. No rows returned." This creates the `profiles`, `likes`, and `usage_events` tables with security rules already applied.

### 3. Create the photo storage bucket
1. Left sidebar → **Storage** → **New bucket**.
2. Name it `avatars`, toggle **Public bucket** on (profile photos need to load without a login check, same as any dating app), → **Create bucket**.

### 4. Get your API keys
1. Left sidebar → **Settings** → **API**.
2. Copy the **Project URL** and the **anon public** key.
3. Paste them into [`../app/supabase-config.js`](../app/supabase-config.js) — for a staging project, they go into the `SUPABASE_STAGING` object; for production, `SUPABASE_PRODUCTION`. Send me the values (or just confirm the file is filled in) and I'll verify it's wired correctly.
   - ⚠️ Never paste the **service_role** key anywhere in this repo — that one bypasses all security and must stay server-side only (Phase 2 below).

### 5. Turn off forced email confirmation (recommended for BETA)
By default Supabase requires clicking a "confirm your email" link before first sign-in — that's an extra email you haven't designed yet. To keep the current one-step signup:
1. **Authentication** → **Providers** → **Email**.
2. Toggle **Confirm email** off.
3. You can turn this back on later once the confirmation email is designed in Brevo.

---

## Phase 2 — Brevo (real email sending)

### 1. Create your account
1. Go to [brevo.com](https://www.brevo.com) → **Sign up free**.
2. Use `support@nestfulapp.com` as the account email once it's active, or your personal email for now (you can add sender addresses separately either way).

### 2. Verify nestfulapp.com as a sender domain
1. **Senders, Domains & Dedicated IPs** → **Domains** → **Add a domain** → enter `nestfulapp.com`.
2. Brevo shows you 2–3 DNS records to add (usually a **SPF TXT record** and a **DKIM CNAME or TXT record** — exact values are generated per-account, so copy them directly from Brevo's screen).
3. Add those records at your domain's DNS host. Since you registered through GoDaddy: **GoDaddy → My Products → DNS** next to nestfulapp.com → **Add** a record for each one Brevo gave you, matching the type (TXT/CNAME), host, and value exactly.
4. Back in Brevo, click **Verify** (DNS can take a few minutes to a few hours to propagate — if it fails immediately, wait and retry).

### 3. Get SMTP credentials
1. **Senders, Domains & Dedicated IPs** → **SMTP & API** → **SMTP** tab.
2. Note the **SMTP server**, **port**, your **login**, and generate an **SMTP key** (this is your password for this purpose — treat it like one).

### 4. Connect Brevo to Supabase's auth emails
This makes password-reset and account emails send through your verified domain instead of Supabase's shared/rate-limited default sender.
1. In Supabase: **Project Settings** → **Authentication** → **SMTP Settings**.
2. Toggle **Enable Custom SMTP** on.
3. Fill in Brevo's SMTP server/port/login/key from the step above.
4. **Sender email:** `support@nestfulapp.com` · **Sender name:** `Nestful`.
5. Save, then send yourself a test password reset once Phase 3 (below) is wired up to confirm it arrives.

### 5. Customize Supabase's password-reset email template (do this — not yet done)
1. **Authentication** → **Emails** → **Templates** → **Reset Password** (repeat for both the production and staging Supabase projects — staging's is lower priority but nice for consistency).
2. Replace the default copy with this on-brand HTML:

   **Subject:** Reset your Nestful password

   **Body** (paste as HTML — Supabase's template editor accepts it):
   ```html
   <div style="background:#F3FBFF;padding:32px 16px;font-family:Arial,Helvetica,sans-serif">
     <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:22px;padding:32px 28px;color:#1D3557">
       <div style="text-align:center;font-size:40px;margin-bottom:6px">🪺</div>
       <div style="text-align:center;font-family:Georgia,serif;font-size:22px;color:#1D3557;font-weight:bold;margin-bottom:24px">Nestful</div>
       <p style="font-size:15px;line-height:1.65;margin:0 0 14px">Hi there,</p>
       <p style="font-size:15px;line-height:1.65;margin:0 0 14px">We got a request to reset your Nestful password. This link works for 1 hour:</p>
       <div style="text-align:center;margin:26px 0 8px">
         <a href="{{ .ConfirmationURL }}" style="background:#00C2CF;color:#1D3557;text-decoration:none;font-weight:bold;padding:13px 30px;border-radius:999px;font-size:15px;display:inline-block">Reset my password</a>
       </div>
       <p style="font-size:13px;color:#5876a3;margin:20px 0 0">If you didn't request this, you can safely ignore this email — your password stays unchanged.</p>
       <div style="text-align:center;margin-top:28px;padding-top:18px;border-top:1px solid #e2e0d9;font-size:12px;color:#5876a3">Nestful — where openness comes first.</div>
     </div>
   </div>
   ```

### 6. Welcome journey & other notifications — done (Phase 4, not Brevo Automations)
Originally planned as a Brevo Automation workflow — superseded by something more
reliable: a small **Netlify Function** (`netlify/functions/send-email.js`) that
calls Brevo's transactional email API directly with on-brand HTML templates
baked into the code. See **Phase 4** below for how it's wired and what's needed
to activate it (one environment variable, per site).

---

## Phase 3 — Wiring the app (done)

`app/app.js` calls the `nestfulDB` functions in [`../app/supabase-client.js`](../app/supabase-client.js)
for signup, sign-in, forgot/reset password, edit profile, account deletion,
and real member-to-member matching/likes — all verified live against
production. See **Phase 5** for how real matching and real likes work.

The curated `SAMPLES` deck in `app.js` still exists as a demo/staging-only
supplement — it's forced empty on production (`IS_PRODUCTION_HOST`, guarded
by a startup safety canary that fails loud if that's ever violated) so a
brand-new production account still has *something* pre-screened to look at
before more real members join, without ever mixing fake profiles into a
real user's deck.

**Not yet done:** the founder dashboard (`#admin`) can't list real members —
that needs a **Supabase Edge Function** using the service-role key (kept
server-side, never in this repo); not a launch blocker, just not built yet.

### Deleting an account for real (Edge Function, done)
Account deletion needs to remove the actual login (`auth.users`), not just
the `profiles` row — RLS structurally prevents a client from doing that
itself, since only the `service_role` key can delete another user's auth
record, even their own. `backend/edge-functions/delete-account/index.ts`
handles this: it verifies the caller's own session, then uses an admin
client to delete `auth.users` (which cascades to `profiles` via its foreign
key). Deployed to **both** Supabase projects via the dashboard (**Edge
Functions → Create a new function** → paste the code → **Deploy**), with
one setting flipped afterward in the function's **Settings** tab:
**"Verify JWT with legacy secret" → OFF** (this project uses the newer
publishable/secret key system, not the legacy one — every Edge Function
here needs this off, including `notify-like` in Phase 5). No extra secrets
needed beyond the ones Supabase auto-injects (`SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`).

---

## Phase 4 — Real notification emails (code done, one setup step left)

Four notifications now send for real, on-brand HTML, the moment their
trigger happens in the app — not simulated, not a Brevo Automation to
build in their UI:

| Notification | Fires when |
|---|---|
| **Welcome** | Right after signup |
| **Password changed** | Self-service change, or completing a password reset |
| **Nestful+ waitlist** | Joining the waitlist from a "you've hit today's limit" screen |
| **Account deleted** | Right before the account is actually removed |

**How it works:** `netlify/functions/send-email.js` is a small server-side
function (a Netlify Function, not part of the static site) that holds the
real Brevo **API key** — a genuine secret, unlike the Supabase anon key,
so it can never live in `app/` where the browser can read it. The app calls
this function (`fetch("/.netlify/functions/send-email", ...)`), which then
calls Brevo's transactional email API. The four templates are baked into
the function itself — the app can only pick *which* one by name, never send
arbitrary content, which keeps this endpoint from being usable as an open
spam relay.

### To activate it — one step, done twice
1. In Brevo: **Senders, Domains & Dedicated IPs → SMTP & API → API Keys tab**
   (a different tab from the SMTP credentials you already used) → **Generate a
   new API key** → copy it immediately, it's shown once.
2. In **each** Netlify site (production *and* staging — environment variables
   aren't shared between separate sites even in the same team):
   **Site configuration → Environment variables → Add a variable**.
   - Key: `BREVO_API_KEY`
   - Value: the key from step 1
   - Scope: all deploy contexts is fine
3. Trigger a redeploy on each site (env var changes only take effect on new
   deploys — push any small commit, or use Netlify's "Trigger deploy" button).

Until this is done, the function returns an error the app already handles
gracefully — the local Outbox log (`#admin → Outbox`) still records the
attempt either way, so nothing breaks and nothing sends silently into a
void.

**Local dev note:** plain `http-server` doesn't run Netlify Functions, so
these calls 404/405 locally — harmless, already caught, doesn't affect
anything else in the app.

---

## Phase 5 — Real matching, real likes, and like/message notifications (done)

Members now see real signups, not just the demo `SAMPLES` deck — filtered
through the same mutual pre-screening logic (`mutuallyOpen`,
`genderCompatible`, `countsAcceptable` in `app.js`) applied to real profile
rows from `nestfulDB.browseProfiles()`. Liking or noting a real member calls
`nestfulDB.sendLike()`, which writes a real row to `public.likes` — daily/
weekly cap *tracking* stays in browser localStorage either way (a future
hardening item, not required for caps to work correctly today).

A notification bell in the home header (🪺, shakes and hatches into 💌 the
moment there's something unread) shows real likes/notes received, backed by
`profiles.last_notifications_seen_at` and two `supabase-client.js` helpers:
`whoLikedMeSinceLastSeen()` and `markNotificationsSeen()`.

When someone receives a like or note, they also get a real email — this
needs one more server-side piece beyond the app itself, since looking up a
recipient's email address requires the `service_role` key (their email
lives in the protected `auth.users` table, unreachable from any signed-in
client, by design).

### 1. Schema — one column, one index
Already in [`schema.sql`](schema.sql); if you're applying this to a project
that predates Phase 5, just run:
```sql
alter table public.profiles
  add column if not exists last_notifications_seen_at timestamptz default now();

create index if not exists likes_likee_created_idx
  on public.likes (likee_id, created_at desc);
```

### 2. Deploy the notify-like Edge Function
**Edge Functions → Create a new function** → name it `notify-like` → paste
in [`edge-functions/notify-like/index.ts`](edge-functions/notify-like/index.ts)
→ **Deploy** → in its **Settings** tab, turn **"Verify JWT with legacy
secret" OFF** (same reason as `delete-account` in Phase 3).

It doesn't call Brevo directly — it looks up who to email and what to say,
then hands off to the already-built, already-verified
`netlify/functions/send-email.js` (now with two more templates:
`new_like` and `new_message`), so there's only one place in the whole
system that ever talks to Brevo's API.

### 3. Set its secret
In the function's secrets (or **Edge Functions → Secrets**, depending on
your dashboard version):
- **Name:** `SEND_EMAIL_ENDPOINT`
- **Value:** `https://nestfulapp.com/.netlify/functions/send-email` for
  production, or your staging Netlify site's equivalent
  `/.netlify/functions/send-email` URL for staging.

### 4. Create the Database Webhook
**Database → Webhooks** (if it's not under Database in your dashboard
version, `Ctrl/Cmd K` → search "webhooks", or go directly to
`/project/<ref>/database/hooks`) → **Create a new hook**:
- **Table:** `public.likes`, **Events:** `Insert` only
- **Type of webhook:** `Supabase Edge Functions`
- **Edge Function:** `notify-like`, **Method:** `POST`, default headers

This has to be **Insert** only — re-liking someone (which upserts the same
row) should not re-notify them every time.

### Repeat all four steps on both Supabase projects
Staging and production are separate projects with separate secrets and
separate webhooks — nothing here is shared between them. Verify on staging
first: two real test accounts, one likes the other with a note, check the
`notify-like` function's own **Logs** tab for a `200`/`{"ok":true}`
invocation, and check Brevo's **Transactional → Logs** for the send attempt
(a hard bounce is fine/expected for a synthetic test account's fake email —
it confirms the pipeline ran, which is what matters).
