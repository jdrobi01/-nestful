-- ============================================================
-- Nestful — Supabase schema
-- ------------------------------------------------------------
-- Run this once in your Supabase project's SQL Editor
-- (Dashboard → SQL Editor → New query → paste → Run).
--
-- This replaces the browser-localStorage data model used in the
-- BETA demo with real tables. Supabase's built-in `auth.users`
-- table already handles email + password (hashing, sessions,
-- password-reset tokens) — you do NOT need to build any of that
-- yourself. `profiles` below is the 1:1 companion table holding
-- everything specific to Nestful.
-- ============================================================

-- ---------- profiles ----------
-- One row per account, keyed to Supabase's own auth.users.id.
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  name              text not null,
  terms_accepted_at timestamptz,

  -- Identity & preference (see app.js viewOnbYou)
  gender            text,             -- 'woman' | 'man' | 'nonbinary'
  gender_detail     text,             -- optional free-text, shown on profile
  pronouns          text,
  seeking           text[] default '{}',   -- genders shown to this member

  -- Nest Profile (see app.js viewOnbDetails)
  contents          text[] default '{}',   -- ['young','teens','adult']; empty = Nest-Ready
  counts            jsonb  default '{}',   -- {"young":"2"} optional household counts
  rhythm            text,             -- time-rhythm key, Full Nest only
  open_to           text[] default '{}',   -- includes 'ready' for the exclusive Nest-Ready option
  open_to_counts    text[] default '{}',   -- private "how many kids am I open to" preference
  role              text,             -- Nest-Ready members only

  city              text,
  bio               text,
  photo_url         text,             -- Supabase Storage URL (see SETUP.md step 6)

  -- Nestful+ (all inert while FEATURES.upgradeEnabled = false)
  premium           boolean default false,
  premium_plan      text,
  premium_since     timestamptz,
  plus_waitlist     boolean default false,
  plus_waitlist_at  timestamptz,

  -- Notifications (see app.js notification bell): last time this
  -- member opened their notification panel — anything newer counts
  -- as unread.
  last_notifications_seen_at timestamptz default now(),

  -- Hidden founder/admin ghost-viewer mode (see app.js viewAdmin /
  -- admin-stats Edge Function). Never settable by the row's own owner
  -- via the client SDK — see protect_is_admin trigger below. Only
  -- flip this by hand in the SQL Editor (runs as a superuser, not
  -- through PostgREST/RLS) or from a service-role Edge Function.
  is_admin          boolean not null default false,

  -- Referral loop (see app.js viewInvite): who shared the link this
  -- member signed up through, if anyone. Low-stakes by design — unlike
  -- is_admin, this is client-settable (see the existing "members can
  -- update their own profile" policy below) since it powers a simple
  -- invite counter, not anything security- or payment-sensitive.
  referred_by       uuid references public.profiles(id),

  created_at        timestamptz default now()
);

-- Safe to re-run on a project that already has the table (adds the
-- column only if it's missing — needed when applying this schema
-- update to an existing Supabase project rather than a fresh one).
alter table public.profiles
  add column if not exists last_notifications_seen_at timestamptz default now();
alter table public.profiles
  add column if not exists is_admin boolean not null default false;
alter table public.profiles
  add column if not exists referred_by uuid references public.profiles(id);

alter table public.profiles enable row level security;

-- Everyone signed in can see everyone's dating profile — same as any
-- dating app. Nothing here is more sensitive than what's already shown
-- in the deck/detail view.
create policy "profiles are readable by any signed-in member"
  on public.profiles for select
  using (auth.role() = 'authenticated');

create policy "members can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "members can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

create policy "members can delete their own profile"
  on public.profiles for delete
  using (auth.uid() = id);

-- The update policy above only checks row ownership, not which columns
-- change — without this trigger, any signed-in member could self-promote
-- via a direct client SDK call (e.g. `.update({is_admin: true})`), since
-- they're allowed to update their own row and RLS has no per-column
-- granularity. auth.role() is NULL outside a PostgREST/RLS request (e.g.
-- the SQL Editor, or a service-role Edge Function), so coalescing it to
-- 'service_role' lets those contexts flip the flag while every real
-- client-side update gets silently reset back to its prior value.
create or replace function public.protect_is_admin()
returns trigger as $$
begin
  if new.is_admin is distinct from old.is_admin
     and coalesce(auth.role(), 'service_role') <> 'service_role' then
    new.is_admin := old.is_admin;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists protect_is_admin_trigger on public.profiles;
create trigger protect_is_admin_trigger
  before update on public.profiles
  for each row execute function public.protect_is_admin();


-- ---------- likes ----------
-- Real user-to-user likes (replaces the SAMPLES-based demo likes).
create table if not exists public.likes (
  id         uuid primary key default gen_random_uuid(),
  liker_id   uuid not null references public.profiles(id) on delete cascade,
  likee_id   uuid not null references public.profiles(id) on delete cascade,
  note       text default '',
  created_at timestamptz default now(),
  unique (liker_id, likee_id)
);

alter table public.likes enable row level security;

-- You can see likes you sent, and likes sent to you (powers "who liked you").
create policy "members can read their own sent or received likes"
  on public.likes for select
  using (auth.uid() = liker_id or auth.uid() = likee_id);

create policy "members can send likes as themselves"
  on public.likes for insert
  with check (auth.uid() = liker_id);

create policy "members can delete likes they sent"
  on public.likes for delete
  using (auth.uid() = liker_id);

-- Speeds up "how many unread likes do I have" on every login.
create index if not exists likes_likee_created_idx
  on public.likes (likee_id, created_at desc);


-- ---------- usage_events ----------
-- One row per like/note sent — powers the daily/weekly caps
-- (8 likes/day, 2 notes/day in beta) without trusting the client.
create table if not exists public.usage_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('like', 'note')),
  created_at timestamptz default now()
);

alter table public.usage_events enable row level security;

create policy "members can read their own usage"
  on public.usage_events for select
  using (auth.uid() = user_id);

create policy "members can log their own usage"
  on public.usage_events for insert
  with check (auth.uid() = user_id);


-- ---------- email_events ----------
-- Powers the admin dashboard's email-activity chart (see app.js
-- viewAdmin / admin-stats Edge Function): how many of each email type
-- went out, and when. Deliberately holds NO recipient, subject, or
-- body content — just a type label and a timestamp — so this table
-- can never become a PII exposure the way the old client-side Outbox
-- log was. RLS is enabled with ZERO policies for any client role, on
-- purpose: the only writer is netlify/functions/send-email.js (via
-- the service_role key, after a real Brevo send succeeds) and the
-- only reader is the admin-stats Edge Function (same key) — nothing
-- here is ever reachable through the public anon/authenticated API.
create table if not exists public.email_events (
  id         uuid primary key default gen_random_uuid(),
  type       text not null,
  created_at timestamptz default now()
);

alter table public.email_events enable row level security;

create index if not exists email_events_type_created_idx
  on public.email_events (type, created_at desc);


-- ---------- auto-create a profile row on signup ----------
-- Supabase Auth creates the auth.users row when someone signs up;
-- this trigger creates the matching (mostly empty) profiles row so
-- the app always has one to update during onboarding.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, terms_accepted_at)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', 'New member'), now());
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- NOT covered here (intentionally — see backend/SETUP.md):
--  - Photo storage: create a Storage bucket named "avatars" in the
--    Supabase dashboard (Storage tab) rather than SQL.
--  - Founder/admin dashboard reading ALL members' email addresses:
--    auth.users is not exposed to the client for any role, by
--    design. That needs a Supabase Edge Function using the service
--    role key (never shipped to the browser) — see SETUP.md, Phase 2.
-- ============================================================
