/* ============================================================
   Environment-aware Supabase config
   ------------------------------------------------------------
   This one file drives BOTH environments — the same code runs on
   nestfulapp.com (production) and on the staging deploy, and picks
   the right Supabase project automatically based on which domain
   is actually serving the page. No per-branch config divergence
   to keep in sync.

   Safety default: only the exact production hostname uses the
   production project. Everything else — staging deploys, Netlify
   preview URLs, localhost — falls back to staging. That way a
   mistake defaults to "can't touch real data," not the reverse.

   Values are safe to expose in client-side code — anon/publishable
   keys only grant what schema.sql's Row Level Security allows.
   Never put a service_role/secret key in this file.
   ============================================================ */

const PRODUCTION_HOSTNAMES = ["nestfulapp.com", "www.nestfulapp.com"];
const IS_PRODUCTION_HOST = PRODUCTION_HOSTNAMES.includes(location.hostname);

const SUPABASE_PRODUCTION = {
  url: "https://cxeibgrrrdvxadaxmxrw.supabase.co",
  anonKey: "sb_publishable_LYj5zoiEzfj-YCBr1PvM8A_hikDTFXP",
};

const SUPABASE_STAGING = {
  url: "https://kkgcjridxbjncvkcazdf.supabase.co",
  anonKey: "sb_publishable_V8b16q6ciNv86oroUYUWag_Jb_e6fOz",
};

const ACTIVE_SUPABASE = IS_PRODUCTION_HOST ? SUPABASE_PRODUCTION : SUPABASE_STAGING;

const SUPABASE_URL = ACTIVE_SUPABASE.url;
const SUPABASE_ANON_KEY = ACTIVE_SUPABASE.anonKey;
