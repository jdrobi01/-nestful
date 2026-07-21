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

  created_at        timestamptz default now()
);

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
