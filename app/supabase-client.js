/* ============================================================
   Nestful — Supabase client wrapper (live, wired into app.js)
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
    if (!error) return data;

    // PGRST116 = no row found. Happens for a login whose profile was
    // removed by deleteMyAccount() (which can only delete the profile —
    // removing the login itself needs a service-role key that must never
    // run client-side; see deleteMyAccount below). Rather than dead-end
    // the user, self-heal: recreate a blank profile so signing back in
    // just resumes onboarding, same as any first-time signup would.
    if (error.code === "PGRST116") {
      const name = (user.user_metadata && user.user_metadata.name) || "Member";
      const { data: created, error: insertError } = await client
        .from("profiles")
        .insert({ id: user.id, name: name, terms_accepted_at: new Date().toISOString() })
        .select()
        .single();
      if (insertError) throw insertError;
      return created;
    }
    throw error;
  }

  async function upsertMyProfile(patch) {
    const { data: { user } } = await client.auth.getUser();
    const { error } = await client.from("profiles").update(patch).eq("id", user.id);
    if (error) throw error;
  }

  async function deleteMyAccount() {
    // Calls the delete-account Edge Function (backend/edge-functions/
    // delete-account/) — the only place the service_role key is used,
    // server-side only. It derives the target user from the caller's
    // own verified session, deletes auth.users, and that cascades to
    // remove the profiles row too. This actually removes the login,
    // unlike a client-side-only profile delete.
    const { error } = await client.functions.invoke("delete-account");
    if (error) throw error;
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
