/* ============================================================
   Nestful — notify-like Edge Function
   ------------------------------------------------------------
   Triggered by a Supabase Database Webhook on INSERT into
   public.likes. Sends the recipient a real "someone liked you" /
   "you got a message" email — this has to happen server-side,
   because looking up the recipient's email address requires the
   service_role key (their email lives in the protected auth.users
   table, which even the sender's own signed-in client can never
   query — by design, same boundary as everywhere else in this app).

   Reuses the already-built, already-verified Netlify send-email
   function rather than duplicating Brevo-calling logic here — this
   function's only job is figuring out WHO to email and WHAT to say,
   then handing off to the existing template-locked sender.

   Deploy this to BOTH Supabase projects (production and staging).
   Requires one Edge Function secret per project:
     SEND_EMAIL_ENDPOINT — e.g. https://nestfulapp.com/.netlify/functions/send-email
                            (or the staging Netlify URL, for the staging deploy)
   See backend/SETUP.md, Phase 6.
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sendEmailEndpoint = Deno.env.get("SEND_EMAIL_ENDPOINT");

  if (!sendEmailEndpoint) {
    return new Response(JSON.stringify({ error: "SEND_EMAIL_ENDPOINT secret not configured" }), { status: 500 });
  }

  try {
    const payload = await req.json();
    const record = payload.record; // Supabase webhook shape: { type, table, record, old_record }
    if (!record || !record.likee_id || !record.liker_id) {
      return new Response(JSON.stringify({ error: "Malformed webhook payload" }), { status: 400 });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);

    // Who is receiving this notification? Their email lives in the
    // protected auth.users table — only reachable with the service
    // role key, which is why this whole function has to exist.
    const { data: recipientAuth, error: recipientErr } = await admin.auth.admin.getUserById(record.likee_id);
    if (recipientErr || !recipientAuth?.user?.email) {
      return new Response(JSON.stringify({ error: "Could not look up recipient" }), { status: 500 });
    }

    const { data: recipientProfile } = await admin
      .from("profiles")
      .select("name")
      .eq("id", record.likee_id)
      .single();
    const { data: senderProfile } = await admin
      .from("profiles")
      .select("name")
      .eq("id", record.liker_id)
      .single();

    const hasNote = typeof record.note === "string" && record.note.trim().length > 0;

    // SEND_EMAIL_ENDPOINT is already set per-environment (staging's own
    // Netlify URL vs production's), so its own origin is exactly the
    // right link for the email's CTA button — this used to be hardcoded
    // to production, which sent staging-triggered emails to the wrong site.
    const appUrl = new URL(sendEmailEndpoint).origin;

    const emailRes = await fetch(sendEmailEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Trusted server-to-server call — satisfies send-email.js's
        // origin allowlist the same way a real browser request would.
        "Origin": "https://nestfulapp.com",
      },
      body: JSON.stringify({
        type: hasNote ? "new_message" : "new_like",
        name: recipientProfile?.name || "there",
        email: recipientAuth.user.email,
        senderName: senderProfile?.name || "Someone",
        note: hasNote ? record.note : undefined,
        appUrl: appUrl,
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      return new Response(JSON.stringify({ error: "send-email failed: " + errText }), { status: 502 });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
