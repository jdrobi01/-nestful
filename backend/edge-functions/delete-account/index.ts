/* ============================================================
   Nestful — delete-account Edge Function
   ------------------------------------------------------------
   The one place the Supabase service_role key is ever used. That
   key bypasses Row Level Security entirely, so it can NEVER live
   in app/ (browser code) — this function is the sanctioned,
   server-side way to do the one thing RLS structurally can't
   allow a user to do to themselves: delete their own login.

   Security model: the target user is derived ONLY from the
   caller's own verified JWT (via the anon-key "user client" below)
   — never from anything in the request body. There is no way to
   pass a different user's id and delete their account instead.

   Deploy this to BOTH Supabase projects (production and staging)
   — see backend/SETUP.md, Phase 5.
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing authorization" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    // Identify the caller from their OWN token — this is the whole
    // security boundary. Nothing in the request body is ever trusted.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Admin client — service_role, never exposed to the browser.
    // Deleting the auth user cascades to delete their profiles row
    // too (schema.sql: profiles.id references auth.users(id) on
    // delete cascade), so a single call cleans up everything.
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(user.id);
    if (deleteError) {
      return new Response(JSON.stringify({ error: deleteError.message }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
