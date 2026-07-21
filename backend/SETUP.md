# Nestful — Backend Setup (Supabase + Brevo)

Everything in this folder is prepped and ready. The steps below are the
parts that need your own login — account creation, domain verification,
and DNS. I can't do these for you, but every field you'll be asked to
fill in is spelled out here, and the copy-paste content (schema, email
templates) is already written.

**Where things stand when you're done with this guide:** real accounts
(Supabase) with real password reset emails, and a real sender domain
(Brevo) ready for welcome journeys — but the live app (`app/app.js`)
will still be running on localStorage until we do the wiring step
together at the end. Nothing breaks in the meantime.

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
3. Paste them into [`supabase-config.js`](supabase-config.js) in this folder (the two blank `const` values at the top). Send me those two values (or just confirm the file is filled in) and I'll wire the app to use them.
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

### 5. Customize Supabase's password-reset email template
1. **Authentication** → **Email Templates** → **Reset Password**.
2. Replace the default copy with something on-brand. Suggested:

   **Subject:** Reset your Nestful password

   **Body:**
   ```
   Hi there,

   We got a request to reset your Nestful password. Click below —
   this link works for 1 hour:

   {{ .ConfirmationURL }}

   If you didn't request this, you can safely ignore this email.

   — The Nestful team
   ```

### 6. Build the welcome journey in Brevo
This is the marketing/onboarding side — separate from the transactional reset email above.
1. **Automations** → **Create an automation** → **Welcome new contacts** (or start from a blank workflow: trigger = "contact added to a list").
2. First email in the journey — suggested copy (same content already drafted in `app/app.js`, formatted for Brevo):

   **Subject:** Welcome to Nestful 🪺

   **Body:**
   ```
   Hi {{contact.FIRSTNAME}},

   Welcome to Nestful — where openness comes first.

   You're in. Finish your Nest Profile to start seeing pre-screened
   matches who already share your openness to kids and dependents.

   [Finish my profile → nestfulapp.com]

   — The Nestful team
   ```
3. Optional second step (2–3 days later): a nudge for anyone who signed up but hasn't finished onboarding — "Your nest is waiting — 2 minutes to finish your profile."
4. **How contacts get in this journey:** once the app is wired to Supabase (Phase 3), new signups should call Brevo's API to add the contact and enroll them — I can write that call when we get there. Until then, you can test the journey by manually adding your own email as a contact.

---

## Phase 3 — Wiring the app (when you're ready)

Once Phase 1 step 4 is done (real URL + anon key in `supabase-config.js`), tell me and I'll:
1. Swap `app/app.js`'s localStorage calls for the `nestfulDB` functions already written in [`supabase-client.js`](supabase-client.js) — signup, sign-in, forgot/reset password, edit profile, likes, and the matching deck all move from fake `SAMPLES` data to real member profiles.
2. Add the Brevo API call so new signups actually enroll in the welcome journey above.
3. Test the whole loop end-to-end against your real project before calling it done.

**One thing to know now:** the founder dashboard (`#admin`) currently reads every account directly from localStorage — with real accounts, member email addresses live in Supabase's protected `auth.users` table, which even your own logged-in app can't query directly (by design, for security). Rebuilding `#admin` to work for real will need a small **Supabase Edge Function** using the service-role key (kept server-side, never in this repo) — that's a distinct next step after the core migration above, not a blocker to launching signups.
