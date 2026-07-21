/* ============================================================
   Nestful — Supabase client wrapper (scaffold, not yet wired in)
   ------------------------------------------------------------
   This file is ready to use once supabase-config.js has your real
   URL + anon key. It is NOT loaded by index.html yet — the live
   app still runs on localStorage (app/app.js) so the beta keeps
   working today. Wiring this in means editing app/app.js to call
   these functions instead of the `store`/`updateUser` helpers.
   That's a real migration — happy to do it with you once your
   Supabase project is created and this file has real keys in it.

   Load order when you're ready to wire it in (in index.html,
   before app.js):
     <script src="https://unpkg.com/@supabase/supabase-js@2"></script>
     <script src="../backend/supabase-config.js"></script>
     <script src="../backend/supabase-client.js"></script>
   ============================================================ */

const nestfulDB = (function () {
  if (typeof SUPABASE_URL === "undefined" || !SUPABASE_URL) {
    console.warn("Nestful: supabase-config.js is not filled in yet — nestfulDB is inactive.");
    return null;
  }

  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  /* ---------- Auth (replaces app.js: signup/signin/signout, hashPassword, makeSalt) ---------- */

  async function signUp(name, email, password) {
    // Passes `name` through so the schema.sql trigger can seed profiles.name.
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { name } },
    });
    if (error) throw error;
    return data.user;
  }

  async function signIn(email, password) {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  }

  async function signOut() {
    await client.auth.signOut();
  }

  function currentSession() {
    return client.auth.getSession(); // async — returns { data: { session } }
  }

  /* ---------- Password management (replaces app.js: viewForgotPassword, viewResetPassword, pw-form) ---------- */

  async function sendPasswordReset(email) {
    // Supabase emails the link itself (via the SMTP you connect in
    // SETUP.md step 5) — no more local Outbox simulation needed.
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname,
    });
    if (error) throw error;
  }

  async function updatePassword(newPassword) {
    const { error } = await client.auth.updateUser({ password: newPassword });
    if (error) throw error;
  }

  /* ---------- Profile (replaces app.js: currentUser().profile, updateUser({profile: ...})) ---------- */

  async function getMyProfile() {
    const { data: { user } } = await client.auth.getUser();
    if (!user) return null;
    const { data, error } = await client.from("profiles").select("*").eq("id", user.id).single();
    if (error) throw error;
    return data;
  }

  async function upsertMyProfile(patch) {
    const { data: { user } } = await client.auth.getUser();
    const { error } = await client.from("profiles").update(patch).eq("id", user.id);
    if (error) throw error;
  }

  async function deleteMyAccount() {
    // Client-side delete removes the profiles row (RLS-permitted),
    // but auth.users itself can only be deleted with the service
    // role key — that needs a small Edge Function. See SETUP.md
    // Phase 2. Until that exists, deletion is profile-level only.
    const { data: { user } } = await client.auth.getUser();
    await client.from("profiles").delete().eq("id", user.id);
    await signOut();
  }

  /* ---------- Matching pool (replaces app.js: SAMPLES + visibleMatches) ---------- */

  async function browseProfiles() {
    const { data: { user } } = await client.auth.getUser();
    const { data, error } = await client
      .from("profiles")
      .select("*")
      .neq("id", user.id);
    if (error) throw error;
    // Mutual-openness / gender / kid-count filtering (mutuallyOpen(),
    // genderCompatible(), countsAcceptable() in app.js) still runs
    // client-side over this real list — same logic, real data.
    return data;
  }

  /* ---------- Likes & usage caps (replaces app.js: recordLike, likesToday, notesUsed) ---------- */

  async function sendLike(likeeId, note) {
    const { data: { user } } = await client.auth.getUser();
    const { error } = await client.from("likes").upsert(
      { liker_id: user.id, likee_id: likeeId, note: note || "" },
      { onConflict: "liker_id,likee_id" }
    );
    if (error) throw error;
    await client.from("usage_events").insert({ user_id: user.id, kind: note ? "note" : "like" });
  }

  async function whoLikedMe() {
    const { data: { user } } = await client.auth.getUser();
    const { data, error } = await client
      .from("likes")
      .select("liker_id, note, created_at, profiles:liker_id(*)")
      .eq("likee_id", user.id);
    if (error) throw error;
    return data;
  }

  async function usageCountSince(kind, sinceISO) {
    const { data: { user } } = await client.auth.getUser();
    const { count, error } = await client
      .from("usage_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("kind", kind)
      .gte("created_at", sinceISO);
    if (error) throw error;
    return count;
  }

  /* ---------- Nestful+ waitlist (replaces app.js: viewComingSoon's cs-waitlist button) ---------- */

  async function joinWaitlist() {
    await upsertMyProfile({ plus_waitlist: true, plus_waitlist_at: new Date().toISOString() });
  }

  return {
    client, // escape hatch for anything not wrapped above
    signUp, signIn, signOut, currentSession,
    sendPasswordReset, updatePassword,
    getMyProfile, upsertMyProfile, deleteMyAccount,
    browseProfiles,
    sendLike, whoLikedMe, usageCountSince,
    joinWaitlist,
  };
})();
