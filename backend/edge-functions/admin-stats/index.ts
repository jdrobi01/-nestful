/* ============================================================
   Nestful — admin-stats Edge Function
   ------------------------------------------------------------
   Returns aggregate, non-identifying counts for the hidden founder
   dashboard (app.js viewAdmin): total real members, Full Nest vs
   Nest-Ready split, likes/notes sent. Needs the service_role key
   because `likes` RLS only lets a member read likes they sent or
   received themselves — an admin-wide count has to happen server-side.

   Security model: the caller is identified from their OWN verified
   JWT (never trusted from the request), then their own profiles.is_admin
   flag is checked with the service-role client before returning
   anything. Being signed in is not enough — you must actually be
   flagged admin (see schema.sql's protect_is_admin trigger, which is
   what keeps that flag from being self-service-settable in the first
   place).

   Deploy this to BOTH Supabase projects (production and staging) —
   see backend/SETUP.md, Phase 6. No extra secrets needed beyond the
   ones Supabase auto-injects into every Edge Function.
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

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: callerProfile, error: callerError } = await adminClient
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single();
    if (callerError || !callerProfile?.is_admin) {
      return new Response(JSON.stringify({ error: "Not authorized" }), {
        status: 403,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const [{ data: profiles, error: profilesError }, { data: likes, error: likesError }] = await Promise.all([
      adminClient.from("profiles").select("contents").eq("is_admin", false),
      adminClient.from("likes").select("note"),
    ]);
    if (profilesError) throw profilesError;
    if (likesError) throw likesError;

    const totalMembers = profiles?.length || 0;
    const fullNest = (profiles || []).filter((p) => p.contents && p.contents.length > 0).length;
    const totalLikes = likes?.length || 0;
    const totalNotes = (likes || []).filter((l) => l.note && l.note.trim().length > 0).length;

    return new Response(JSON.stringify({
      totalMembers,
      fullNest,
      nestReady: totalMembers - fullNest,
      totalLikes,
      totalNotes,
    }), {
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
