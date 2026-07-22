/* ============================================================
   Nestful application
   - View router + templates (vanilla JS, no build step)
   - Real accounts via Supabase (see ../backend/). The matching
     deck still shows the curated SAMPLES below — real member-to-
     member matching is a follow-up once there's a second real
     signup (see backend/SETUP.md, Phase 3 note).
   ============================================================ */

(function () {
  "use strict";

  const $app = document.getElementById("app");

  /* ---------------- Environment (production vs staging) ----------------
     Driven by which domain is actually serving the page (see
     backend/supabase-config.js's IS_PRODUCTION_HOST) — the same code
     and same deploy config work on both; only the hostname differs.
     Staging talks to a completely separate Supabase project, so
     testing there can never touch real production data. */

  const ENV = (typeof IS_PRODUCTION_HOST !== "undefined" && IS_PRODUCTION_HOST) ? "production" : "staging";

  /* ---------------- Storage layer ---------------- */

  const PREFIX = BRAND.storagePrefix + (ENV === "staging" ? "-staging" : "");
  const KEY_VIEWMODE = PREFIX + ".viewmode";
  const KEY_FILTERS = PREFIX + ".filters";
  const KEY_EMAILS = PREFIX + ".emails";
  const KEY_DEMO = PREFIX + ".demo"; // per-user demo-deck likes/usage — see recordLike() below

  const store = {
    getDemoState(userId) {
      try {
        const all = JSON.parse(localStorage.getItem(KEY_DEMO)) || {};
        return all[userId] || { likes: [], usage: { likes: [], notes: [] } };
      } catch { return { likes: [], usage: { likes: [], notes: [] } }; }
    },
    saveDemoState(userId, state) {
      let all;
      try { all = JSON.parse(localStorage.getItem(KEY_DEMO)) || {}; }
      catch { all = {}; }
      all[userId] = state;
      localStorage.setItem(KEY_DEMO, JSON.stringify(all));
    },
    getViewMode() { return localStorage.getItem(KEY_VIEWMODE) || "list"; },
    setViewMode(m) { localStorage.setItem(KEY_VIEWMODE, m); },
    getFilters() {
      const empty = { keys: [], rhythm: "", rhythmMatch: false, kidCounts: [] };
      try {
        const f = JSON.parse(localStorage.getItem(KEY_FILTERS));
        return f ? Object.assign(empty, f) : empty;
      }
      catch { return empty; }
    },
    setFilters(f) { localStorage.setItem(KEY_FILTERS, JSON.stringify(f)); },
    getEmails() {
      try { return JSON.parse(localStorage.getItem(KEY_EMAILS)) || []; }
      catch { return []; }
    },
    addEmail(email) {
      const list = store.getEmails();
      list.unshift(Object.assign({ id: "e_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sentAt: new Date().toISOString() }, email));
      localStorage.setItem(KEY_EMAILS, JSON.stringify(list.slice(0, 200)));
    },
  };

  /* ---------------- Auth state (backed by Supabase) ----------------
     currentUser() stays SYNCHRONOUS and shaped exactly like the old
     localStorage account object, so every render function elsewhere in
     this file keeps working unchanged — it just now reads from a cache
     populated asynchronously from Supabase (see refreshAuthState()). */

  let authUser = null;    // Supabase auth.users row (id, email, ...)
  let authProfile = null; // public.profiles row for authUser

  function dbProfileToLocal(row) {
    return {
      gender: row.gender || "",
      genderDetail: row.gender_detail || "",
      pronouns: row.pronouns || "",
      seeking: row.seeking || [],
      contents: row.contents || [],
      counts: row.counts || {},
      rhythm: row.rhythm || "",
      openTo: row.open_to || [],
      openToCounts: row.open_to_counts || [],
      role: row.role || "",
      city: row.city || "",
      bio: row.bio || "",
      photo: row.photo_url || null,
    };
  }

  /* Accepts either { profile: {...} } (onboarding/edit save) or flat
     top-level fields (premium, plusWaitlist, ...) and maps both onto
     the profiles table's real column names. */
  function localPatchToColumns(patch) {
    const out = {};
    if (patch.profile) {
      const p = patch.profile;
      const map = {
        gender: "gender", genderDetail: "gender_detail", pronouns: "pronouns",
        seeking: "seeking", contents: "contents", counts: "counts", rhythm: "rhythm",
        openTo: "open_to", openToCounts: "open_to_counts", role: "role",
        city: "city", bio: "bio", photo: "photo_url",
      };
      Object.keys(map).forEach(function (k) {
        if (k in p) out[map[k]] = p[k];
      });
    }
    const topMap = {
      premium: "premium", premiumPlan: "premium_plan", premiumSince: "premium_since",
      plusWaitlist: "plus_waitlist", plusWaitlistAt: "plus_waitlist_at",
    };
    Object.keys(topMap).forEach(function (k) {
      if (k in patch) out[topMap[k]] = patch[k];
    });
    return out;
  }

  async function refreshAuthState() {
    if (!nestfulDB) { authUser = null; authProfile = null; return; }
    const { data: { session } } = await nestfulDB.client.auth.getSession();
    if (!session) { authUser = null; authProfile = null; return; }
    authUser = session.user;
    try {
      authProfile = await nestfulDB.getMyProfile();
    } catch (err) {
      // Most commonly: schema.sql hasn't been run yet (backend/SETUP.md,
      // Phase 1 step 2), so public.profiles doesn't exist. Fail loud
      // instead of leaving the page blank.
      authProfile = null;
      throw new Error(
        "Couldn't load your profile from Supabase (" + err.message + "). " +
        "If this is a fresh project, make sure backend/schema.sql has been run " +
        "in the SQL Editor."
      );
    }
  }

  function currentUser() {
    if (!authUser || !authProfile) return null;
    const demo = store.getDemoState(authUser.id);
    const onboarded = !!(authProfile.city && authProfile.bio);
    return {
      id: authUser.id,
      name: authProfile.name,
      email: authUser.email,
      createdAt: authProfile.created_at,
      termsAcceptedAt: authProfile.terms_accepted_at,
      likes: demo.likes,
      usage: demo.usage,
      premium: !!authProfile.premium,
      premiumPlan: authProfile.premium_plan,
      premiumSince: authProfile.premium_since,
      plusWaitlist: !!authProfile.plus_waitlist,
      plusWaitlistAt: authProfile.plus_waitlist_at,
      profile: onboarded ? dbProfileToLocal(authProfile) : null,
    };
  }

  async function updateUser(patch) {
    if (!authUser) return null;
    const columns = localPatchToColumns(patch);
    if (Object.keys(columns).length) {
      await nestfulDB.upsertMyProfile(columns);
      Object.assign(authProfile, columns);
    }
    return currentUser();
  }

  /* ---------------- Email (local activity log) ----------------
     Password reset/change now really happens through Supabase (and,
     once backend/SETUP.md Phase 2 is done, through your verified
     nestfulapp.com sender). This log is just a founder-visible record
     of that activity (#admin → Outbox) — not a delivery mechanism. */
  function sendEmail(to, subject, body) {
    store.addEmail({ to: to, subject: subject, body: body });
  }

  /* Fire-and-forget call to the real sender (netlify/functions/send-email.js).
     Never blocks the UI and never surfaces a failure to the end user — the
     local Outbox log above is the fallback record if this silently fails
     (e.g. BREVO_API_KEY not yet configured on this Netlify site). */
  function sendRealEmail(type, name, email) {
    if (!email) return;
    fetch("/.netlify/functions/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: type, name: name, email: email }),
    }).catch(function () { /* local Outbox log is the fallback record */ });
  }

  function sendWelcomeEmail(account) {
    sendEmail(
      account.email,
      "Welcome to " + BRAND.name + " 🪺",
      "Hi " + account.name + ",\n\n" +
      "Welcome to " + BRAND.name + " — " + BRAND.tagline + "\n\n" +
      "You're in. Finish your Nest Profile to start seeing pre-screened matches " +
      "who already share your openness to kids and dependents.\n\n" +
      "— The " + BRAND.name + " team"
    );
    sendRealEmail("welcome", account.name, account.email);
  }

  function sendPasswordChangedEmail(account) {
    sendEmail(
      account.email,
      "Your " + BRAND.name + " password was changed",
      "Hi " + account.name + ",\n\n" +
      "This confirms your " + BRAND.name + " password was just changed. " +
      "If that wasn't you, reset your password right away from the sign-in screen."
    );
    sendRealEmail("password_changed", account.name, account.email);
  }

  function sendWaitlistEmail(account) {
    sendEmail(
      account.email,
      "You're on the " + BRAND.name + "+ list ✨",
      "Hi " + account.name + ",\n\n" +
      BRAND.name + "+ is coming — unlimited likes, Private Nest mode, a weekly " +
      "Boost, and more. You'll be first to know when it opens.\n\n" +
      "— The " + BRAND.name + " team"
    );
    sendRealEmail("waitlist", account.name, account.email);
  }

  function sendAccountDeletedEmail(account) {
    sendEmail(
      account.email,
      "Your " + BRAND.name + " account has been deleted",
      "Hi " + account.name + ",\n\n" +
      "This confirms your profile, photo, and Nest Profile answers have been " +
      "permanently deleted, along with every like and note you sent."
    );
    sendRealEmail("account_deleted", account.name, account.email);
  }

  /* ---------------- Nest vocabulary ---------------- */

  const NEST_ITEMS = [
    { key: "young", label: "Young kids (0–12)", icon: "🧸" },
    { key: "teens", label: "Teens (13–17)", icon: "🎧" },
    { key: "adult", label: "Adult dependent / caregiving", icon: "🤝" },
  ];

  const RHYTHMS = [
    ["fulltime", "With me full-time"],
    ["alternating", "Alternating weeks"],
    ["weekends", "Weekends / part-time"],
    ["varies", "It varies"],
  ];

  const ROLES = [
    ["handson", "A hands-on family role"],
    ["supportive", "A supportive-partner role"],
    ["open", "Still figuring it out — and that's okay"],
  ];

  /* Gender & seeking — identity and preference are separate questions.
     "Show me" is a multi-select (never a binary "both"), and matching is
     mutual: you only see people whose preferences include you too. */
  const GENDERS = [
    ["woman", "Woman"],
    ["man", "Man"],
    ["nonbinary", "Nonbinary"],
  ];

  const SEEK_LABELS = { woman: "Women", man: "Men", nonbinary: "Nonbinary people" };

  const PRONOUN_SETS = ["she/her", "he/him", "they/them", "she/they", "he/they"];

  function genderLabel(key) {
    const g = GENDERS.find(function (x) { return x[0] === key; });
    return g ? g[1] : "";
  }

  function labelFor(key) {
    if (key === "ready") return "Nest-Ready (no kids or dependents)";
    const item = NEST_ITEMS.find((n) => n.key === key);
    return item ? item.label : key;
  }

  function rhythmLabel(key) {
    const r = RHYTHMS.find((x) => x[0] === key);
    return r ? r[1] : "";
  }

  /* ---------------- Sample community (demo matching pool) ----------------
     Fabricated profiles for testing/demoing the deck UI — never shown to
     real production users, since presenting fake people as real potential
     matches is a real trust problem for a dating app. Only used on
     staging/local, where real member-to-member matching doesn't exist yet
     either. Production users see a genuinely empty deck until real members
     join (see the empty-deck message in viewHome). */
  const DEMO_SAMPLES = [
    { name: "Maya", age: 34, city: "Austin, TX", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: ["young"], counts: { young: "1" }, openTo: ["young", "teens", "ready"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/65.jpg",
      bio: "Mom of a 6-year-old adventurer. Sunday pancakes are sacred, museum memberships are maxed out, and I will absolutely beat you at mini golf." },
    { name: "Derek", age: 41, city: "Round Rock, TX", hue: 3, gender: "man", pronouns: "he/him", seeking: ["woman"], contents: ["teens"], counts: { teens: "2" }, openTo: ["young", "teens", "adult", "ready"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/65.jpg",
      bio: "Dad to two teenagers who think my jokes are terrible. They're wrong. High school baseball coach, amateur smoker of briskets, professional carpool driver." },
    { name: "Priya", age: 29, city: "Austin, TX", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["man", "nonbinary"], contents: [], openTo: ["young"], photo: "https://randomuser.me/api/portraits/women/66.jpg",
      bio: "No kids yet — but I've always pictured a full, loud house. Pediatric nurse, so tiny humans don't faze me. Looking for someone whose weekend plans include juice boxes." },
    { name: "Sam", age: 36, city: "Cedar Park, TX", hue: 4, gender: "nonbinary", pronouns: "they/them", seeking: ["woman", "man", "nonbinary"], contents: [], openTo: ["young", "teens", "adult"], photo: "https://randomuser.me/api/portraits/men/66.jpg",
      bio: "Open book, open nest. Family is whoever you show up for — I learned that helping raise my nieces. Give me farmers markets, live music, and someone worth showing up for." },
    { name: "Alex", age: 38, city: "Austin, TX", hue: 3, gender: "man", pronouns: "he/him", seeking: ["woman", "nonbinary"], contents: ["adult"], openTo: ["young", "adult", "ready"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/67.jpg",
      bio: "My mom lives with me and she's honestly the fun one. Software dev by day, her sous-chef by night. Seeking someone who gets that caregiving is love in action." },
    { name: "Jordan", age: 31, city: "Pflugerville, TX", hue: 1, gender: "man", pronouns: "he/him", seeking: ["woman", "man"], contents: [], openTo: ["teens"], photo: "https://randomuser.me/api/portraits/men/68.jpg",
      bio: "Middle-school coach. Teenagers don't scare me — they're hilarious. Weekends are for trail runs and taco crawls." },
    { name: "Elena", age: 44, city: "Georgetown, TX", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["man", "woman"], contents: ["teens", "adult"], counts: { teens: "1" }, openTo: ["teens", "adult"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/67.jpg",
      bio: "Raising a teen and helping my dad. Busy nest, big heart. If your idea of romance includes patience and a good calendar app, we'll get along." },
    { name: "Chris", age: 33, city: "Austin, TX", hue: 4, gender: "man", pronouns: "he/him", seeking: ["woman"], contents: ["young"], counts: { young: "2" }, openTo: ["young"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/69.jpg",
      bio: "Single dad of twins. Yes, I can do pigtails. No, not well. Firefighter, so I'm calm in chaos — which twin toddlers provide daily." },
    { name: "Harper", age: 46, city: "Madison, WI", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: [], openTo: ["teens"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/0.jpg",
      bio: "Still gets excited about terrible puns. Great with kids, better with snacks, best with patience. Kindness is the only dealbreaker that matters." },
    { name: "Kaya", age: 34, city: "Boise, ID", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["man", "woman"], contents: [], openTo: ["young", "adult", "teens"], role: "open", photo: "https://randomuser.me/api/portraits/women/1.jpg",
      bio: "Considers themself an amateur expert in thrift store finds. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. No games, just someone worth rearranging a Tuesday for." },
    { name: "Harper", age: 55, city: "Eugene, OR", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["nonbinary"], contents: ["teens", "adult"], counts: { teens: "3+", adult: "2" }, openTo: ["young", "adult", "teens"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/2.jpg",
      bio: "Finds any excuse to bring up gardening disasters. Caregiving rearranged my whole life, and I wouldn't undo it. Family is whoever you choose to show up for — every time." },
    { name: "Cyrus", age: 43, city: "Austin, TX", hue: 3, gender: "man", pronouns: "he/him", seeking: ["woman"], contents: [], openTo: ["teens", "adult", "young"], role: "open", photo: "https://randomuser.me/api/portraits/men/0.jpg",
      bio: "Runs on strong coffee and stronger opinions about local trivia nights. Ready to be the steady, dependable one in someone else's story. No games, just someone worth rearranging a Tuesday for." },
    { name: "Diego", age: 49, city: "Madison, WI", hue: 2, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "man"], contents: ["adult"], openTo: ["young", "ready"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/1.jpg",
      bio: "Runs on strong coffee and stronger opinions about terrible puns. Most nights end with one more glass of water and one more hug. Kindness is the only dealbreaker that matters." },
    { name: "Grant", age: 24, city: "Georgetown, TX", hue: 4, gender: "man", pronouns: "he/they", seeking: ["nonbinary"], contents: ["young", "adult", "teens"], counts: { young: "2", adult: "1", teens: "1" }, openTo: ["adult"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/2.jpg",
      bio: "Considers themself an amateur expert in neighborhood potlucks. My weekends run on a schedule I didn't choose but wouldn't change. Slow and steady is the whole plan." },
    { name: "Ravi", age: 27, city: "Fort Collins, CO", hue: 3, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: ["teens", "young"], counts: { teens: "2", young: "1" }, openTo: ["adult"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/3.jpg",
      bio: "Finds any excuse to bring up weekend car repairs. Co-parenting has taught me more patience than I ever thought I had. Here for the long, unglamorous, worth-it version of things." },
    { name: "Ingrid", age: 57, city: "Cedar Park, TX", hue: 2, gender: "woman", pronouns: "she/they", seeking: ["nonbinary"], contents: ["young", "adult"], counts: { young: "2", adult: "2" }, openTo: ["teens"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/3.jpg",
      bio: "Spends most weekends chasing down a good used bookstore. Homework help is a nightly event around here. Looking for someone who means what they say." },
    { name: "Diego", age: 26, city: "Columbus, OH", hue: 2, gender: "man", pronouns: "he/him", seeking: ["woman", "nonbinary"], contents: [], openTo: ["young"], role: "open", photo: "https://randomuser.me/api/portraits/men/4.jpg",
      bio: "Considers themself an amateur expert in bad karaoke. Great with kids, better with snacks, best with patience. No games, just someone worth rearranging a Tuesday for." },
    { name: "Nate", age: 33, city: "Portland, OR", hue: 1, gender: "man", pronouns: "he/they", seeking: ["man", "woman"], contents: ["young"], counts: { young: "1" }, openTo: ["young", "adult", "ready"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/5.jpg",
      bio: "Spends most weekends chasing down home-brewed iced tea. Co-parenting has taught me more patience than I ever thought I had. Patience and a good sense of humor go a long way here." },
    { name: "Jordan", age: 24, city: "Boulder, CO", hue: 3, gender: "man", pronouns: "he/they", seeking: ["nonbinary"], contents: ["young"], counts: { young: "1" }, openTo: ["adult", "young", "teens"], openToCounts: ["2", "1"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/6.jpg",
      bio: "Still gets excited about a great taco truck. Caregiving rearranged my whole life, and I wouldn't undo it. Patience and a good sense of humor go a long way here." },
    { name: "Tobias", age: 38, city: "Kansas City, MO", hue: 2, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "man"], contents: ["adult"], counts: { adult: "1" }, openTo: ["teens", "young"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/7.jpg",
      bio: "Genuinely obsessed with farmers market tomatoes. My weekends run on a schedule I didn't choose but wouldn't change. Here for the long, unglamorous, worth-it version of things." },
    { name: "Zoe", age: 42, city: "Richmond, VA", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["man", "woman"], contents: ["young", "teens"], counts: { young: "2", teens: "2" }, openTo: ["teens"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/4.jpg",
      bio: "Considers themself an amateur expert in farmers market tomatoes. Homework help is a nightly event around here. Patience and a good sense of humor go a long way here." },
    { name: "Owen", age: 55, city: "Boulder, CO", hue: 3, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "woman"], contents: [], openTo: ["adult", "teens", "young"], openToCounts: ["3+"], role: "open", photo: "https://randomuser.me/api/portraits/men/8.jpg",
      bio: "Will absolutely talk your ear off about gardening disasters. Open to whatever shape a family ends up taking. Here for the long, unglamorous, worth-it version of things." },
    { name: "Maya", age: 47, city: "San Diego, CA", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: ["teens", "young", "adult"], counts: { young: "3+", adult: "2" }, openTo: ["adult", "ready"], openToCounts: ["2"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/5.jpg",
      bio: "Will absolutely talk your ear off about terrible puns. My weekends run on a schedule I didn't choose but wouldn't change. No games, just someone worth rearranging a Tuesday for." },
    { name: "Malik", age: 34, city: "Cedar Park, TX", hue: 1, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: ["young"], counts: { young: "3+" }, openTo: ["adult", "young", "ready"], openToCounts: ["1"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/9.jpg",
      bio: "Runs on strong coffee and stronger opinions about Sunday pancakes. Bedtime negotiations are basically a part-time job at this point. Patience and a good sense of humor go a long way here." },
    { name: "Kwame", age: 45, city: "Eugene, OR", hue: 2, gender: "man", pronouns: "he/they", seeking: ["man", "woman"], contents: ["adult"], openTo: ["young", "teens", "adult"], openToCounts: ["2", "1"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/10.jpg",
      bio: "Will absolutely talk your ear off about home-brewed iced tea. Most nights end with one more glass of water and one more hug. Not chasing perfect, just chasing real." },
    { name: "Ellis", age: 33, city: "Cincinnati, OH", hue: 2, gender: "man", pronouns: "he/they", seeking: ["woman", "nonbinary"], contents: [], openTo: ["teens", "young"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/11.jpg",
      bio: "Spends most weekends chasing down farmers market tomatoes. No kids of my own yet, but I've always pictured a full house. Patience and a good sense of humor go a long way here." },
    { name: "Hassan", age: 53, city: "Cedar Park, TX", hue: 4, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: ["young"], counts: { young: "2" }, openTo: ["teens", "young"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/12.jpg",
      bio: "Runs on strong coffee and stronger opinions about farmers market tomatoes. My nest is loud, a little chaotic, and exactly how I like it. No games, just someone worth rearranging a Tuesday for." },
    { name: "Theo", age: 31, city: "Austin, TX", hue: 4, gender: "man", pronouns: "he/they", seeking: ["woman"], contents: [], openTo: ["young"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/13.jpg",
      bio: "Considers themself an amateur expert in weekend trail runs. Open to whatever shape a family ends up taking. No games, just someone worth rearranging a Tuesday for." },
    { name: "Alex", age: 41, city: "Columbus, OH", hue: 4, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "man"], contents: ["adult"], counts: { adult: "1" }, openTo: ["teens", "adult", "young"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/14.jpg",
      bio: "Has a running joke about Sunday pancakes. Bedtime negotiations are basically a part-time job at this point. Good conversation over a good meal, most days of the week." },
    { name: "Derek", age: 30, city: "Tucson, AZ", hue: 1, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "man"], contents: ["young"], counts: { young: "3+" }, openTo: ["young", "adult"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/15.jpg",
      bio: "Spends most weekends chasing down neighborhood potlucks. My weekends run on a schedule I didn't choose but wouldn't change. Patience and a good sense of humor go a long way here." },
    { name: "Odette", age: 44, city: "St. Louis, MO", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: [], openTo: ["young"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/6.jpg",
      bio: "Runs on strong coffee and stronger opinions about a great taco truck. No kids of my own yet, but I've always pictured a full house. Not chasing perfect, just chasing real." },
    { name: "Elena", age: 45, city: "Portland, OR", hue: 4, gender: "woman", pronouns: "she/they", seeking: ["man", "woman"], contents: ["young"], openTo: ["teens"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/7.jpg",
      bio: "Genuinely obsessed with neighborhood potlucks. My nest is loud, a little chaotic, and exactly how I like it. Family is whoever you choose to show up for — every time." },
    { name: "Harper", age: 24, city: "Cedar Park, TX", hue: 3, gender: "woman", pronouns: "she/they", seeking: ["woman", "nonbinary"], contents: ["adult", "young", "teens"], counts: { adult: "1", young: "3+", teens: "1" }, openTo: ["teens", "young", "adult"], openToCounts: ["3+"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/8.jpg",
      bio: "Can't stop recommending farmers market tomatoes. Bedtime negotiations are basically a part-time job at this point. Family is whoever you choose to show up for — every time." },
    { name: "Ines", age: 52, city: "Austin, TX", hue: 4, gender: "woman", pronouns: "she/her", seeking: ["nonbinary"], contents: ["teens"], counts: { teens: "2" }, openTo: ["adult", "teens", "young"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/9.jpg",
      bio: "Can't stop recommending bad karaoke. Co-parenting has taught me more patience than I ever thought I had. Family is whoever you choose to show up for — every time." },
    { name: "Camille", age: 40, city: "Salt Lake City, UT", hue: 4, gender: "woman", pronouns: "she/they", seeking: ["woman", "nonbinary"], contents: [], openTo: ["teens", "adult"], role: "open", photo: "https://randomuser.me/api/portraits/women/10.jpg",
      bio: "Finds any excuse to bring up terrible puns. Ready to be the steady, dependable one in someone else's story. Here for the long, unglamorous, worth-it version of things." },
    { name: "Gideon", age: 36, city: "San Diego, CA", hue: 1, gender: "man", pronouns: "he/him", seeking: ["man"], contents: ["young", "adult", "teens"], counts: { adult: "2" }, openTo: ["adult", "teens", "young"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/16.jpg",
      bio: "Never says no to Sunday pancakes. My weekends run on a schedule I didn't choose but wouldn't change. Not chasing perfect, just chasing real." },
    { name: "Vance", age: 35, city: "Raleigh, NC", hue: 4, gender: "man", pronouns: "he/him", seeking: ["man"], contents: [], openTo: ["teens", "young"], openToCounts: ["1"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/17.jpg",
      bio: "Never says no to weekend trail runs. Not in a rush, just genuinely open. Not chasing perfect, just chasing real." },
    { name: "Ellis", age: 26, city: "Asheville, NC", hue: 2, gender: "man", pronouns: "he/they", seeking: ["man", "nonbinary"], contents: ["young"], counts: { young: "3+" }, openTo: ["adult"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/18.jpg",
      bio: "Runs on strong coffee and stronger opinions about thrift store finds. My nest is loud, a little chaotic, and exactly how I like it. No games, just someone worth rearranging a Tuesday for." },
    { name: "Diego", age: 54, city: "Denver, CO", hue: 3, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "man"], contents: [], openTo: ["young"], role: "handson", photo: "https://randomuser.me/api/portraits/men/19.jpg",
      bio: "Will absolutely talk your ear off about a solid playlist. No kids of my own yet, but I've always pictured a full house. Family is whoever you choose to show up for — every time." },
    { name: "Micah", age: 27, city: "Charlottesville, VA", hue: 3, gender: "man", pronouns: "he/they", seeking: ["man"], contents: [], openTo: ["adult"], role: "handson", photo: "https://randomuser.me/api/portraits/men/20.jpg",
      bio: "Genuinely obsessed with the perfect brisket. Open to whatever shape a family ends up taking. Family is whoever you choose to show up for — every time." },
    { name: "Kenji", age: 50, city: "Phoenix, AZ", hue: 3, gender: "man", pronouns: "he/him", seeking: ["man"], contents: [], openTo: ["young"], role: "handson", photo: "https://randomuser.me/api/portraits/men/21.jpg",
      bio: "Considers themself an amateur expert in weekend car repairs. Open to whatever shape a family ends up taking. Slow and steady is the whole plan." },
    { name: "Owen", age: 55, city: "Kansas City, MO", hue: 3, gender: "man", pronouns: "he/him", seeking: ["man", "woman"], contents: [], openTo: ["adult"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/22.jpg",
      bio: "Never says no to home-brewed iced tea. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. Kindness is the only dealbreaker that matters." },
    { name: "Ravi", age: 38, city: "Pflugerville, TX", hue: 1, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "woman"], contents: ["adult", "young"], counts: { adult: "2", young: "2" }, openTo: ["teens", "ready"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/23.jpg",
      bio: "Genuinely obsessed with neighborhood potlucks. Most nights end with one more glass of water and one more hug. Here for the long, unglamorous, worth-it version of things." },
    { name: "Ines", age: 31, city: "Madison, WI", hue: 1, gender: "woman", pronouns: "she/they", seeking: ["man"], contents: ["adult", "teens", "young"], counts: { adult: "1", teens: "2" }, openTo: ["teens"], openToCounts: ["3+", "2"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/11.jpg",
      bio: "Can't stop recommending weekend trail runs. Homework help is a nightly event around here. Good conversation over a good meal, most days of the week." },
    { name: "Theo", age: 31, city: "Pflugerville, TX", hue: 4, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "man"], contents: [], openTo: ["young", "teens", "adult"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/24.jpg",
      bio: "Can't stop recommending thrift store finds. Ready to be the steady, dependable one in someone else's story. No games, just someone worth rearranging a Tuesday for." },
    { name: "Marlowe", age: 48, city: "Raleigh, NC", hue: 3, gender: "nonbinary", pronouns: "he/they", seeking: ["woman", "man", "nonbinary"], contents: ["adult", "teens", "young"], counts: { teens: "3+", young: "3+" }, openTo: ["adult", "teens", "ready"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/25.jpg",
      bio: "Has a running joke about a solid playlist. Caregiving rearranged my whole life, and I wouldn't undo it. Slow and steady is the whole plan." },
    { name: "Lena", age: 57, city: "Cincinnati, OH", hue: 1, gender: "woman", pronouns: "she/they", seeking: ["man", "woman"], contents: ["adult", "teens", "young"], counts: { adult: "3+", teens: "2", young: "3+" }, openTo: ["teens", "adult", "ready"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/12.jpg",
      bio: "Genuinely obsessed with the family group chat. Co-parenting has taught me more patience than I ever thought I had. No games, just someone worth rearranging a Tuesday for." },
    { name: "Micah", age: 25, city: "San Diego, CA", hue: 2, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "man"], contents: [], openTo: ["teens", "young", "adult"], role: "handson", photo: "https://randomuser.me/api/portraits/men/26.jpg",
      bio: "Will absolutely talk your ear off about board game night. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. Looking for someone who shows up, on time and on purpose." },
    { name: "Ines", age: 57, city: "Cincinnati, OH", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["woman", "nonbinary"], contents: ["young", "teens", "adult"], counts: { young: "3+", teens: "1", adult: "2" }, openTo: ["teens"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/13.jpg",
      bio: "Never says no to Sunday pancakes. Co-parenting has taught me more patience than I ever thought I had. Family is whoever you choose to show up for — every time." },
    { name: "Quinn", age: 45, city: "Charlottesville, VA", hue: 4, gender: "nonbinary", pronouns: "they/them", seeking: ["nonbinary", "man"], contents: [], openTo: ["teens", "adult", "young"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/27.jpg",
      bio: "Still gets excited about gardening disasters. No kids of my own yet, but I've always pictured a full house. Here for the long, unglamorous, worth-it version of things." },
    { name: "Gideon", age: 56, city: "Asheville, NC", hue: 2, gender: "man", pronouns: "he/him", seeking: ["woman", "nonbinary"], contents: [], openTo: ["young", "adult", "teens"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/28.jpg",
      bio: "Never says no to neighborhood potlucks. Great with kids, better with snacks, best with patience. Here for the long, unglamorous, worth-it version of things." },
    { name: "Ellis", age: 49, city: "Fort Collins, CO", hue: 1, gender: "man", pronouns: "he/him", seeking: ["woman", "man"], contents: ["teens", "young"], counts: { teens: "2" }, openTo: ["young", "adult", "teens", "ready"], openToCounts: ["3+"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/29.jpg",
      bio: "Will absolutely talk your ear off about Sunday pancakes. Homework help is a nightly event around here. Kindness is the only dealbreaker that matters." },
    { name: "Camille", age: 32, city: "Asheville, NC", hue: 2, gender: "woman", pronouns: "she/they", seeking: ["woman"], contents: [], openTo: ["young", "teens"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/14.jpg",
      bio: "Can't stop recommending bad karaoke. Open to whatever shape a family ends up taking. Looking for someone who means what they say." },
    { name: "Sam", age: 46, city: "Georgetown, TX", hue: 1, gender: "woman", pronouns: "she/they", seeking: ["man"], contents: ["young", "teens"], counts: { young: "3+", teens: "1" }, openTo: ["young", "adult", "ready"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/15.jpg",
      bio: "Has a running joke about weekend car repairs. Caregiving rearranged my whole life, and I wouldn't undo it. Good conversation over a good meal, most days of the week." },
    { name: "Kenji", age: 26, city: "Denver, CO", hue: 4, gender: "man", pronouns: "he/him", seeking: ["man", "nonbinary"], contents: [], openTo: ["young"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/30.jpg",
      bio: "Still gets excited about weekend car repairs. Great with kids, better with snacks, best with patience. Kindness is the only dealbreaker that matters." },
    { name: "Yuki", age: 42, city: "Phoenix, AZ", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["woman", "nonbinary"], contents: ["teens"], openTo: ["adult", "young", "teens"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/16.jpg",
      bio: "Will absolutely talk your ear off about a solid playlist. My weekends run on a schedule I didn't choose but wouldn't change. Looking for someone who shows up, on time and on purpose." },
    { name: "Rosa", age: 49, city: "Kansas City, MO", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: [], openTo: ["teens", "adult"], role: "open", photo: "https://randomuser.me/api/portraits/women/17.jpg",
      bio: "Spends most weekends chasing down board game night. No kids of my own yet, but I've always pictured a full house. Family is whoever you choose to show up for — every time." },
    { name: "Ines", age: 27, city: "Durham, NC", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: ["young"], counts: { young: "3+" }, openTo: ["adult", "young", "teens"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/18.jpg",
      bio: "Runs on strong coffee and stronger opinions about home-brewed iced tea. Caregiving rearranged my whole life, and I wouldn't undo it. Looking for someone who shows up, on time and on purpose." },
    { name: "Aaron", age: 51, city: "Minneapolis, MN", hue: 1, gender: "man", pronouns: "he/him", seeking: ["woman", "man"], contents: [], openTo: ["young"], role: "handson", photo: "https://randomuser.me/api/portraits/men/31.jpg",
      bio: "Still gets excited about weekend trail runs. Great with kids, better with snacks, best with patience. Here for the long, unglamorous, worth-it version of things." },
    { name: "Hassan", age: 41, city: "San Diego, CA", hue: 1, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: ["adult", "teens", "young"], counts: { adult: "3+", young: "1" }, openTo: ["teens", "ready"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/32.jpg",
      bio: "Never says no to live music on a school night. Caregiving rearranged my whole life, and I wouldn't undo it. Good conversation over a good meal, most days of the week." },
    { name: "Ingrid", age: 44, city: "Pflugerville, TX", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: ["adult"], counts: { adult: "1" }, openTo: ["teens"], openToCounts: ["3+", "2"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/19.jpg",
      bio: "Runs on strong coffee and stronger opinions about a well-organized junk drawer. Most nights end with one more glass of water and one more hug. Slow and steady is the whole plan." },
    { name: "Nate", age: 47, city: "Chattanooga, TN", hue: 1, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "man"], contents: [], openTo: ["adult", "young", "teens"], openToCounts: ["2"], role: "handson", photo: "https://randomuser.me/api/portraits/men/33.jpg",
      bio: "Considers themself an amateur expert in bad karaoke. Not in a rush, just genuinely open. Not chasing perfect, just chasing real." },
    { name: "Kaya", age: 32, city: "Milwaukee, WI", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: ["young"], counts: { young: "1" }, openTo: ["adult", "young"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/20.jpg",
      bio: "Will absolutely talk your ear off about farmers market tomatoes. My nest is loud, a little chaotic, and exactly how I like it. Good conversation over a good meal, most days of the week." },
    { name: "Zoe", age: 32, city: "Milwaukee, WI", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["man", "woman"], contents: [], openTo: ["teens", "adult", "young"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/21.jpg",
      bio: "Runs on strong coffee and stronger opinions about weekend trail runs. Great with kids, better with snacks, best with patience. Family is whoever you choose to show up for — every time." },
    { name: "Bianca", age: 27, city: "St. Louis, MO", hue: 3, gender: "woman", pronouns: "she/they", seeking: ["woman", "nonbinary"], contents: [], openTo: ["adult", "young", "teens"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/22.jpg",
      bio: "Considers themself an amateur expert in farmers market tomatoes. Open to whatever shape a family ends up taking. Patience and a good sense of humor go a long way here." },
    { name: "Cyrus", age: 50, city: "Round Rock, TX", hue: 3, gender: "man", pronouns: "he/they", seeking: ["nonbinary", "woman"], contents: [], openTo: ["teens", "young"], role: "open", photo: "https://randomuser.me/api/portraits/men/34.jpg",
      bio: "Still gets excited about backyard birdwatching. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. Not chasing perfect, just chasing real." },
    { name: "Emil", age: 48, city: "Columbus, OH", hue: 3, gender: "man", pronouns: "he/him", seeking: ["man", "nonbinary"], contents: ["teens", "adult", "young"], counts: { teens: "2", adult: "1", young: "1" }, openTo: ["adult", "young", "teens", "ready"], openToCounts: ["2", "1"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/35.jpg",
      bio: "Considers themself an amateur expert in farmers market tomatoes. Caregiving rearranged my whole life, and I wouldn't undo it. No games, just someone worth rearranging a Tuesday for." },
    { name: "Owen", age: 41, city: "Columbus, OH", hue: 3, gender: "man", pronouns: "he/him", seeking: ["man"], contents: [], openTo: ["adult", "teens"], role: "open", photo: "https://randomuser.me/api/portraits/men/36.jpg",
      bio: "Can't stop recommending neighborhood potlucks. Ready to be the steady, dependable one in someone else's story. Patience and a good sense of humor go a long way here." },
    { name: "Sage", age: 55, city: "Eugene, OR", hue: 4, gender: "nonbinary", pronouns: "they/them", seeking: ["man"], contents: ["adult"], counts: { adult: "1" }, openTo: ["teens", "young", "adult"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/23.jpg",
      bio: "Never says no to local trivia nights. Homework help is a nightly event around here. No games, just someone worth rearranging a Tuesday for." },
    { name: "Priya", age: 27, city: "Nashville, TN", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["woman", "man"], contents: ["teens", "adult"], counts: { teens: "2", adult: "1" }, openTo: ["adult", "young", "teens", "ready"], openToCounts: ["1"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/24.jpg",
      bio: "Still gets excited about terrible puns. My nest is loud, a little chaotic, and exactly how I like it. Patience and a good sense of humor go a long way here." },
    { name: "Gideon", age: 32, city: "Boulder, CO", hue: 4, gender: "man", pronouns: "he/they", seeking: ["nonbinary"], contents: [], openTo: ["adult", "young"], openToCounts: ["3+", "1"], role: "open", photo: "https://randomuser.me/api/portraits/men/37.jpg",
      bio: "Genuinely obsessed with a good used bookstore. Great with kids, better with snacks, best with patience. Patience and a good sense of humor go a long way here." },
    { name: "Priya", age: 35, city: "Austin, TX", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["nonbinary", "woman"], contents: ["young", "adult", "teens"], counts: { young: "2", adult: "3+" }, openTo: ["young", "adult", "teens"], openToCounts: ["2"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/25.jpg",
      bio: "Will absolutely talk your ear off about a great taco truck. Caregiving rearranged my whole life, and I wouldn't undo it. Slow and steady is the whole plan." },
    { name: "Tobias", age: 52, city: "Sacramento, CA", hue: 2, gender: "man", pronouns: "he/him", seeking: ["woman", "man"], contents: [], openTo: ["young", "teens"], openToCounts: ["2", "1"], role: "handson", photo: "https://randomuser.me/api/portraits/men/38.jpg",
      bio: "Spends most weekends chasing down terrible puns. No kids of my own yet, but I've always pictured a full house. Family is whoever you choose to show up for — every time." },
    { name: "Sienna", age: 52, city: "Phoenix, AZ", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: ["adult", "young"], counts: { young: "3+" }, openTo: ["teens", "adult", "ready"], openToCounts: ["3+", "1"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/26.jpg",
      bio: "Will absolutely talk your ear off about a solid playlist. Homework help is a nightly event around here. Here for the long, unglamorous, worth-it version of things." },
    { name: "Reese", age: 45, city: "Boulder, CO", hue: 1, gender: "nonbinary", pronouns: "they/them", seeking: ["woman"], contents: ["adult", "teens", "young"], counts: { adult: "3+" }, openTo: ["adult", "teens"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/27.jpg",
      bio: "Has a running joke about bad karaoke. My weekends run on a schedule I didn't choose but wouldn't change. Good conversation over a good meal, most days of the week." },
    { name: "Delphine", age: 37, city: "Austin, TX", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["woman", "nonbinary"], contents: [], openTo: ["adult", "young", "teens"], role: "open", photo: "https://randomuser.me/api/portraits/women/28.jpg",
      bio: "Spends most weekends chasing down terrible puns. Not in a rush, just genuinely open. Looking for someone who shows up, on time and on purpose." },
    { name: "Rian", age: 29, city: "Fort Collins, CO", hue: 4, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: [], openTo: ["teens"], role: "handson", photo: "https://randomuser.me/api/portraits/men/39.jpg",
      bio: "Still gets excited about a great taco truck. No kids of my own yet, but I've always pictured a full house. Looking for someone who shows up, on time and on purpose." },
    { name: "Ruby", age: 33, city: "Columbus, OH", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: ["teens", "adult"], counts: { teens: "2", adult: "3+" }, openTo: ["adult"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/29.jpg",
      bio: "Genuinely obsessed with a good used bookstore. Caregiving rearranged my whole life, and I wouldn't undo it. Not chasing perfect, just chasing real." },
    { name: "Gideon", age: 33, city: "Pflugerville, TX", hue: 4, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: ["adult", "young"], counts: { adult: "2", young: "2" }, openTo: ["young"], openToCounts: ["3+", "1"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/40.jpg",
      bio: "Runs on strong coffee and stronger opinions about thrift store finds. Bedtime negotiations are basically a part-time job at this point. Good conversation over a good meal, most days of the week." },
    { name: "Avery", age: 41, city: "Kansas City, MO", hue: 1, gender: "nonbinary", pronouns: "he/they", seeking: ["man", "nonbinary"], contents: ["teens", "adult", "young"], counts: { teens: "2" }, openTo: ["young"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/41.jpg",
      bio: "Still gets excited about board game night. Most nights end with one more glass of water and one more hug. Looking for someone who shows up, on time and on purpose." },
    { name: "Amir", age: 50, city: "Fort Collins, CO", hue: 3, gender: "man", pronouns: "he/him", seeking: ["woman", "nonbinary"], contents: [], openTo: ["teens", "adult"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/42.jpg",
      bio: "Has a running joke about home-brewed iced tea. Ready to be the steady, dependable one in someone else's story. Good conversation over a good meal, most days of the week." },
    { name: "Beckett", age: 28, city: "Richmond, VA", hue: 2, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: ["teens", "adult"], counts: { teens: "1", adult: "1" }, openTo: ["teens", "adult"], openToCounts: ["2", "1"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/43.jpg",
      bio: "Has a running joke about backyard birdwatching. Co-parenting has taught me more patience than I ever thought I had. Kindness is the only dealbreaker that matters." },
    { name: "Bianca", age: 48, city: "Charlottesville, VA", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: [], openTo: ["young", "adult", "teens"], role: "open", photo: "https://randomuser.me/api/portraits/women/30.jpg",
      bio: "Finds any excuse to bring up thrift store finds. Not in a rush, just genuinely open. Not chasing perfect, just chasing real." },
    { name: "Hassan", age: 36, city: "Tucson, AZ", hue: 1, gender: "man", pronouns: "he/him", seeking: ["man"], contents: [], openTo: ["young"], role: "open", photo: "https://randomuser.me/api/portraits/men/44.jpg",
      bio: "Genuinely obsessed with thrift store finds. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. No games, just someone worth rearranging a Tuesday for." },
    { name: "Jules", age: 41, city: "Sacramento, CA", hue: 4, gender: "nonbinary", pronouns: "they/them", seeking: ["nonbinary"], contents: ["teens", "young"], counts: { teens: "3+" }, openTo: ["young", "adult", "ready"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/31.jpg",
      bio: "Will absolutely talk your ear off about weekend trail runs. Co-parenting has taught me more patience than I ever thought I had. Slow and steady is the whole plan." },
    { name: "Ingrid", age: 26, city: "Nashville, TN", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["nonbinary"], contents: ["young"], counts: { young: "3+" }, openTo: ["young"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/32.jpg",
      bio: "Finds any excuse to bring up weekend trail runs. Homework help is a nightly event around here. Kindness is the only dealbreaker that matters." },
    { name: "Camille", age: 49, city: "St. Louis, MO", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: ["adult", "teens"], counts: { adult: "2" }, openTo: ["young", "adult", "ready"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/33.jpg",
      bio: "Considers themself an amateur expert in a great taco truck. Caregiving rearranged my whole life, and I wouldn't undo it. Kindness is the only dealbreaker that matters." },
    { name: "Nate", age: 46, city: "Asheville, NC", hue: 1, gender: "man", pronouns: "he/him", seeking: ["woman", "man"], contents: ["young", "adult", "teens"], counts: { young: "2", adult: "3+" }, openTo: ["young"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/45.jpg",
      bio: "Genuinely obsessed with weekend car repairs. My weekends run on a schedule I didn't choose but wouldn't change. Slow and steady is the whole plan." },
    { name: "Petra", age: 35, city: "Tucson, AZ", hue: 1, gender: "woman", pronouns: "she/they", seeking: ["man"], contents: ["teens"], counts: { teens: "1" }, openTo: ["adult", "young"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/34.jpg",
      bio: "Has a running joke about live music on a school night. Bedtime negotiations are basically a part-time job at this point. Looking for someone who shows up, on time and on purpose." },
    { name: "Odette", age: 24, city: "Madison, WI", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: ["young", "teens"], counts: { young: "2" }, openTo: ["adult"], openToCounts: ["3+", "2"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/35.jpg",
      bio: "Still gets excited about home-brewed iced tea. Caregiving rearranged my whole life, and I wouldn't undo it. Kindness is the only dealbreaker that matters." },
    { name: "Ellis", age: 50, city: "Columbus, OH", hue: 1, gender: "man", pronouns: "he/him", seeking: ["woman", "man"], contents: [], openTo: ["adult", "teens", "young"], role: "open", photo: "https://randomuser.me/api/portraits/men/46.jpg",
      bio: "Runs on strong coffee and stronger opinions about a solid playlist. Great with kids, better with snacks, best with patience. Kindness is the only dealbreaker that matters." },
    { name: "Julian", age: 39, city: "Salt Lake City, UT", hue: 3, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: ["adult", "teens", "young"], counts: { adult: "2", teens: "1", young: "1" }, openTo: ["adult", "young", "ready"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/47.jpg",
      bio: "Finds any excuse to bring up a well-organized junk drawer. Homework help is a nightly event around here. Patience and a good sense of humor go a long way here." },
    { name: "Jordan", age: 41, city: "Round Rock, TX", hue: 2, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: [], openTo: ["young"], role: "handson", photo: "https://randomuser.me/api/portraits/men/48.jpg",
      bio: "Runs on strong coffee and stronger opinions about backyard birdwatching. Not in a rush, just genuinely open. Kindness is the only dealbreaker that matters." },
    { name: "Hassan", age: 33, city: "Portland, OR", hue: 2, gender: "man", pronouns: "he/him", seeking: ["man", "nonbinary"], contents: ["young"], counts: { young: "2" }, openTo: ["young", "teens", "adult"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/49.jpg",
      bio: "Never says no to board game night. Caregiving rearranged my whole life, and I wouldn't undo it. Looking for someone who shows up, on time and on purpose." },
    { name: "Micah", age: 38, city: "Asheville, NC", hue: 3, gender: "man", pronouns: "he/they", seeking: ["nonbinary"], contents: ["adult", "teens"], counts: { adult: "1", teens: "3+" }, openTo: ["young", "adult", "teens"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/50.jpg",
      bio: "Runs on strong coffee and stronger opinions about board game night. My nest is loud, a little chaotic, and exactly how I like it. Family is whoever you choose to show up for — every time." },
    { name: "Diego", age: 30, city: "Columbus, OH", hue: 1, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "woman"], contents: ["young", "teens", "adult"], counts: { teens: "3+", adult: "1" }, openTo: ["teens"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/51.jpg",
      bio: "Never says no to farmers market tomatoes. Bedtime negotiations are basically a part-time job at this point. No games, just someone worth rearranging a Tuesday for." },
    { name: "Sam", age: 47, city: "Minneapolis, MN", hue: 4, gender: "nonbinary", pronouns: "he/they", seeking: ["nonbinary", "woman", "man"], contents: ["adult", "young"], counts: { adult: "2" }, openTo: ["young"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/36.jpg",
      bio: "Will absolutely talk your ear off about farmers market tomatoes. Most nights end with one more glass of water and one more hug. Here for the long, unglamorous, worth-it version of things." },
    { name: "Delphine", age: 44, city: "Asheville, NC", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["nonbinary", "woman"], contents: [], openTo: ["teens"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/37.jpg",
      bio: "Considers themself an amateur expert in a good used bookstore. Open to whatever shape a family ends up taking. Patience and a good sense of humor go a long way here." },
    { name: "Wren", age: 29, city: "Boise, ID", hue: 2, gender: "woman", pronouns: "she/they", seeking: ["woman"], contents: [], openTo: ["young", "adult", "teens"], role: "open", photo: "https://randomuser.me/api/portraits/women/38.jpg",
      bio: "Will absolutely talk your ear off about the perfect brisket. Open to whatever shape a family ends up taking. Here for the long, unglamorous, worth-it version of things." },
    { name: "Sam", age: 42, city: "Fort Collins, CO", hue: 3, gender: "nonbinary", pronouns: "they/them", seeking: ["man"], contents: [], openTo: ["teens", "adult"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/39.jpg",
      bio: "Has a running joke about board game night. Open to whatever shape a family ends up taking. Slow and steady is the whole plan." },
    { name: "Silas", age: 45, city: "Cincinnati, OH", hue: 3, gender: "man", pronouns: "he/him", seeking: ["woman", "nonbinary"], contents: ["young", "adult"], counts: { young: "2", adult: "1" }, openTo: ["teens"], openToCounts: ["1"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/52.jpg",
      bio: "Finds any excuse to bring up terrible puns. My weekends run on a schedule I didn't choose but wouldn't change. Family is whoever you choose to show up for — every time." },
    { name: "Alex", age: 29, city: "Durham, NC", hue: 4, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "man"], contents: ["adult", "teens"], counts: { adult: "3+" }, openTo: ["adult", "young", "teens", "ready"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/53.jpg",
      bio: "Runs on strong coffee and stronger opinions about board game night. Bedtime negotiations are basically a part-time job at this point. Here for the long, unglamorous, worth-it version of things." },
    { name: "Leo", age: 35, city: "Durham, NC", hue: 2, gender: "man", pronouns: "he/they", seeking: ["nonbinary", "woman"], contents: ["adult"], counts: { adult: "1" }, openTo: ["adult"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/54.jpg",
      bio: "Spends most weekends chasing down a solid playlist. Co-parenting has taught me more patience than I ever thought I had. Looking for someone who means what they say." },
    { name: "Malik", age: 36, city: "Phoenix, AZ", hue: 3, gender: "man", pronouns: "he/him", seeking: ["woman", "man"], contents: ["young", "teens"], counts: { young: "3+" }, openTo: ["adult", "teens"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/55.jpg",
      bio: "Will absolutely talk your ear off about terrible puns. Co-parenting has taught me more patience than I ever thought I had. Looking for someone who means what they say." },
    { name: "Camille", age: 48, city: "San Diego, CA", hue: 4, gender: "woman", pronouns: "she/they", seeking: ["woman"], contents: ["teens", "adult"], counts: { teens: "2", adult: "3+" }, openTo: ["teens", "ready"], openToCounts: ["2"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/40.jpg",
      bio: "Still gets excited about bad karaoke. Homework help is a nightly event around here. Here for the long, unglamorous, worth-it version of things." },
    { name: "Kenji", age: 39, city: "Charlottesville, VA", hue: 3, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: [], openTo: ["teens", "young"], role: "open", photo: "https://randomuser.me/api/portraits/men/56.jpg",
      bio: "Will absolutely talk your ear off about local trivia nights. Not in a rush, just genuinely open. Family is whoever you choose to show up for — every time." },
    { name: "Sam", age: 40, city: "Milwaukee, WI", hue: 3, gender: "nonbinary", pronouns: "they/them", seeking: ["woman"], contents: [], openTo: ["teens"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/41.jpg",
      bio: "Runs on strong coffee and stronger opinions about home-brewed iced tea. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. Kindness is the only dealbreaker that matters." },
    { name: "Tobias", age: 26, city: "Charlottesville, VA", hue: 3, gender: "man", pronouns: "he/him", seeking: ["man"], contents: ["adult", "young", "teens"], counts: { adult: "3+", young: "3+", teens: "1" }, openTo: ["adult", "teens", "young", "ready"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/57.jpg",
      bio: "Will absolutely talk your ear off about Sunday pancakes. My weekends run on a schedule I didn't choose but wouldn't change. Not chasing perfect, just chasing real." },
    { name: "Vance", age: 29, city: "San Diego, CA", hue: 4, gender: "man", pronouns: "he/they", seeking: ["man", "woman"], contents: [], openTo: ["adult", "teens", "young"], role: "handson", photo: "https://randomuser.me/api/portraits/men/58.jpg",
      bio: "Spends most weekends chasing down weekend car repairs. Great with kids, better with snacks, best with patience. Not chasing perfect, just chasing real." },
    { name: "Owen", age: 47, city: "Minneapolis, MN", hue: 2, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "woman"], contents: [], openTo: ["young", "teens", "adult"], role: "handson", photo: "https://randomuser.me/api/portraits/men/59.jpg",
      bio: "Has a running joke about live music on a school night. Open to whatever shape a family ends up taking. Slow and steady is the whole plan." },
    { name: "Rian", age: 41, city: "Kansas City, MO", hue: 2, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "man"], contents: [], openTo: ["teens", "young", "adult"], role: "open", photo: "https://randomuser.me/api/portraits/men/60.jpg",
      bio: "Never says no to weekend trail runs. Great with kids, better with snacks, best with patience. Family is whoever you choose to show up for — every time." },
    { name: "Nate", age: 35, city: "Eugene, OR", hue: 3, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: ["young", "adult", "teens"], counts: { young: "2", adult: "1", teens: "2" }, openTo: ["young", "ready"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/61.jpg",
      bio: "Spends most weekends chasing down terrible puns. Homework help is a nightly event around here. Here for the long, unglamorous, worth-it version of things." },
    { name: "Alex", age: 38, city: "Madison, WI", hue: 2, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "woman"], contents: ["young", "teens"], counts: { young: "2", teens: "2" }, openTo: ["adult", "teens"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/62.jpg",
      bio: "Has a running joke about weekend car repairs. Homework help is a nightly event around here. Good conversation over a good meal, most days of the week." },
    { name: "Beckett", age: 53, city: "San Diego, CA", hue: 2, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "woman"], contents: ["young"], counts: { young: "3+" }, openTo: ["young", "teens", "ready"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/63.jpg",
      bio: "Genuinely obsessed with the perfect brisket. My weekends run on a schedule I didn't choose but wouldn't change. No games, just someone worth rearranging a Tuesday for." },
    { name: "Fiona", age: 46, city: "Phoenix, AZ", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: ["adult", "teens"], counts: { adult: "3+", teens: "3+" }, openTo: ["adult", "young", "teens", "ready"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/42.jpg",
      bio: "Never says no to a great taco truck. Homework help is a nightly event around here. Good conversation over a good meal, most days of the week." },
    { name: "Sienna", age: 33, city: "Pflugerville, TX", hue: 2, gender: "woman", pronouns: "she/they", seeking: ["woman"], contents: ["young"], counts: { young: "1" }, openTo: ["young"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/43.jpg",
      bio: "Considers themself an amateur expert in weekend trail runs. Caregiving rearranged my whole life, and I wouldn't undo it. Patience and a good sense of humor go a long way here." },
    { name: "Nico", age: 46, city: "Cincinnati, OH", hue: 1, gender: "nonbinary", pronouns: "she/they", seeking: ["woman", "nonbinary"], contents: [], openTo: ["teens", "adult", "young"], role: "open", photo: "https://randomuser.me/api/portraits/women/44.jpg",
      bio: "Still gets excited about weekend car repairs. Open to whatever shape a family ends up taking. No games, just someone worth rearranging a Tuesday for." },
    { name: "Nate", age: 41, city: "Minneapolis, MN", hue: 4, gender: "man", pronouns: "he/him", seeking: ["woman"], contents: [], openTo: ["young"], openToCounts: ["1", "3+"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/64.jpg",
      bio: "Genuinely obsessed with the family group chat. Ready to be the steady, dependable one in someone else's story. No games, just someone worth rearranging a Tuesday for." },
    { name: "Marlowe", age: 27, city: "Kansas City, MO", hue: 4, gender: "nonbinary", pronouns: "he/they", seeking: ["man", "woman", "nonbinary"], contents: ["teens", "adult", "young"], counts: { teens: "3+", adult: "1", young: "1" }, openTo: ["adult", "young", "teens"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/65.jpg",
      bio: "Has a running joke about local trivia nights. My weekends run on a schedule I didn't choose but wouldn't change. Patience and a good sense of humor go a long way here." },
    { name: "Rian", age: 45, city: "Austin, TX", hue: 1, gender: "man", pronouns: "he/him", seeking: ["woman", "nonbinary"], contents: ["adult", "teens"], counts: { adult: "2", teens: "3+" }, openTo: ["teens"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/66.jpg",
      bio: "Has a running joke about bad karaoke. My nest is loud, a little chaotic, and exactly how I like it. Here for the long, unglamorous, worth-it version of things." },
    { name: "Malik", age: 53, city: "Portland, OR", hue: 1, gender: "man", pronouns: "he/him", seeking: ["man"], contents: ["teens", "adult", "young"], counts: { adult: "2" }, openTo: ["adult", "young", "teens", "ready"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/67.jpg",
      bio: "Considers themself an amateur expert in gardening disasters. Homework help is a nightly event around here. Looking for someone who means what they say." },
    { name: "Silas", age: 24, city: "Austin, TX", hue: 1, gender: "man", pronouns: "he/they", seeking: ["nonbinary"], contents: ["adult"], counts: { adult: "2" }, openTo: ["teens", "young", "adult"], openToCounts: ["2"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/68.jpg",
      bio: "Has a running joke about live music on a school night. Homework help is a nightly event around here. Not chasing perfect, just chasing real." },
    { name: "Zoe", age: 24, city: "Cincinnati, OH", hue: 4, gender: "woman", pronouns: "she/they", seeking: ["nonbinary"], contents: ["adult", "teens"], counts: { adult: "2" }, openTo: ["teens", "young", "adult", "ready"], openToCounts: ["2", "3+"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/45.jpg",
      bio: "Finds any excuse to bring up local trivia nights. Most nights end with one more glass of water and one more hug. Family is whoever you choose to show up for — every time." },
    { name: "Felix", age: 57, city: "Portland, OR", hue: 4, gender: "man", pronouns: "he/him", seeking: ["man"], contents: ["young", "teens", "adult"], counts: { teens: "3+" }, openTo: ["young", "ready"], openToCounts: ["3+"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/69.jpg",
      bio: "Never says no to board game night. My weekends run on a schedule I didn't choose but wouldn't change. No games, just someone worth rearranging a Tuesday for." },
    { name: "Grant", age: 50, city: "Asheville, NC", hue: 2, gender: "man", pronouns: "he/him", seeking: ["woman", "man"], contents: [], openTo: ["young"], role: "open", photo: "https://randomuser.me/api/portraits/men/70.jpg",
      bio: "Still gets excited about home-brewed iced tea. Not in a rush, just genuinely open. Here for the long, unglamorous, worth-it version of things." },
    { name: "Blair", age: 28, city: "Nashville, TN", hue: 1, gender: "nonbinary", pronouns: "she/they", seeking: ["woman", "nonbinary", "man"], contents: [], openTo: ["teens", "adult"], role: "handson", photo: "https://randomuser.me/api/portraits/women/46.jpg",
      bio: "Still gets excited about farmers market tomatoes. No kids of my own yet, but I've always pictured a full house. Family is whoever you choose to show up for — every time." },
    { name: "Micah", age: 49, city: "Fort Collins, CO", hue: 1, gender: "man", pronouns: "he/they", seeking: ["nonbinary"], contents: [], openTo: ["young", "adult"], role: "open", photo: "https://randomuser.me/api/portraits/men/71.jpg",
      bio: "Never says no to the perfect brisket. Great with kids, better with snacks, best with patience. Here for the long, unglamorous, worth-it version of things." },
    { name: "Emil", age: 40, city: "Pflugerville, TX", hue: 2, gender: "man", pronouns: "he/they", seeking: ["man", "woman"], contents: ["adult", "young", "teens"], counts: { young: "2" }, openTo: ["young", "teens"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/72.jpg",
      bio: "Still gets excited about the family group chat. My weekends run on a schedule I didn't choose but wouldn't change. Patience and a good sense of humor go a long way here." },
    { name: "Reese", age: 56, city: "Boulder, CO", hue: 1, gender: "nonbinary", pronouns: "she/they", seeking: ["man", "woman"], contents: [], openTo: ["young", "adult"], role: "open", photo: "https://randomuser.me/api/portraits/men/73.jpg",
      bio: "Runs on strong coffee and stronger opinions about Sunday pancakes. Open to whatever shape a family ends up taking. Good conversation over a good meal, most days of the week." },
    { name: "Diego", age: 45, city: "Boise, ID", hue: 1, gender: "man", pronouns: "he/they", seeking: ["nonbinary"], contents: [], openTo: ["adult", "young"], role: "open", photo: "https://randomuser.me/api/portraits/men/74.jpg",
      bio: "Can't stop recommending weekend car repairs. Great with kids, better with snacks, best with patience. Good conversation over a good meal, most days of the week." },
    { name: "Sienna", age: 50, city: "Raleigh, NC", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["nonbinary"], contents: ["teens", "young"], counts: { teens: "2" }, openTo: ["teens", "young"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/47.jpg",
      bio: "Genuinely obsessed with weekend car repairs. Most nights end with one more glass of water and one more hug. Looking for someone who means what they say." },
    { name: "Silas", age: 35, city: "Nashville, TN", hue: 2, gender: "man", pronouns: "he/him", seeking: ["woman", "nonbinary"], contents: ["young", "teens"], openTo: ["adult", "young", "teens"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/75.jpg",
      bio: "Can't stop recommending a solid playlist. My nest is loud, a little chaotic, and exactly how I like it. No games, just someone worth rearranging a Tuesday for." },
    { name: "Julian", age: 26, city: "Durham, NC", hue: 1, gender: "man", pronouns: "he/him", seeking: ["man"], contents: [], openTo: ["adult", "teens"], role: "handson", photo: "https://randomuser.me/api/portraits/men/76.jpg",
      bio: "Considers themself an amateur expert in bad karaoke. Ready to be the steady, dependable one in someone else's story. Looking for someone who shows up, on time and on purpose." },
    { name: "Ravi", age: 30, city: "Cedar Park, TX", hue: 4, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: [], openTo: ["teens", "adult", "young"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/77.jpg",
      bio: "Has a running joke about neighborhood potlucks. No kids of my own yet, but I've always pictured a full house. Slow and steady is the whole plan." },
    { name: "Xochitl", age: 38, city: "St. Louis, MO", hue: 4, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: [], openTo: ["adult"], role: "open", photo: "https://randomuser.me/api/portraits/women/48.jpg",
      bio: "Will absolutely talk your ear off about local trivia nights. Ready to be the steady, dependable one in someone else's story. Family is whoever you choose to show up for — every time." },
    { name: "Delphine", age: 41, city: "Raleigh, NC", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["nonbinary", "man"], contents: ["adult"], counts: { adult: "3+" }, openTo: ["teens", "adult"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/49.jpg",
      bio: "Finds any excuse to bring up a good used bookstore. Homework help is a nightly event around here. Patience and a good sense of humor go a long way here." },
    { name: "Rian", age: 48, city: "Asheville, NC", hue: 2, gender: "man", pronouns: "he/him", seeking: ["woman"], contents: ["young", "teens"], openTo: ["adult"], openToCounts: ["3+", "1"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/78.jpg",
      bio: "Spends most weekends chasing down bad karaoke. My nest is loud, a little chaotic, and exactly how I like it. No games, just someone worth rearranging a Tuesday for." },
    { name: "Nova", age: 39, city: "Cedar Park, TX", hue: 4, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: ["young", "adult"], counts: { young: "3+", adult: "3+" }, openTo: ["adult", "teens", "ready"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/50.jpg",
      bio: "Will absolutely talk your ear off about farmers market tomatoes. Caregiving rearranged my whole life, and I wouldn't undo it. Kindness is the only dealbreaker that matters." },
    { name: "Nate", age: 35, city: "Round Rock, TX", hue: 1, gender: "man", pronouns: "he/him", seeking: ["woman", "nonbinary"], contents: ["young", "adult", "teens"], counts: { adult: "3+", teens: "3+" }, openTo: ["adult", "young"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/79.jpg",
      bio: "Has a running joke about board game night. Most nights end with one more glass of water and one more hug. Good conversation over a good meal, most days of the week." },
    { name: "Petra", age: 37, city: "Raleigh, NC", hue: 4, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: [], openTo: ["young"], role: "open", photo: "https://randomuser.me/api/portraits/women/51.jpg",
      bio: "Has a running joke about farmers market tomatoes. Not in a rush, just genuinely open. No games, just someone worth rearranging a Tuesday for." },
    { name: "Sam", age: 57, city: "Round Rock, TX", hue: 3, gender: "woman", pronouns: "she/they", seeking: ["man"], contents: [], openTo: ["teens"], openToCounts: ["2", "1"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/52.jpg",
      bio: "Genuinely obsessed with a solid playlist. No kids of my own yet, but I've always pictured a full house. Here for the long, unglamorous, worth-it version of things." },
    { name: "Felix", age: 32, city: "Boise, ID", hue: 4, gender: "man", pronouns: "he/him", seeking: ["woman", "nonbinary"], contents: ["adult", "teens"], counts: { adult: "3+", teens: "1" }, openTo: ["adult", "teens", "young", "ready"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/80.jpg",
      bio: "Can't stop recommending bad karaoke. Caregiving rearranged my whole life, and I wouldn't undo it. Family is whoever you choose to show up for — every time." },
    { name: "Vance", age: 46, city: "Round Rock, TX", hue: 3, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "woman"], contents: [], openTo: ["adult"], openToCounts: ["1"], role: "handson", photo: "https://randomuser.me/api/portraits/men/81.jpg",
      bio: "Considers themself an amateur expert in neighborhood potlucks. Great with kids, better with snacks, best with patience. Looking for someone who shows up, on time and on purpose." },
    { name: "Emil", age: 43, city: "Kansas City, MO", hue: 2, gender: "man", pronouns: "he/him", seeking: ["man"], contents: ["young", "teens", "adult"], counts: { young: "3+", teens: "1", adult: "3+" }, openTo: ["adult", "teens"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/82.jpg",
      bio: "Finds any excuse to bring up local trivia nights. My nest is loud, a little chaotic, and exactly how I like it. Here for the long, unglamorous, worth-it version of things." },
    { name: "Xochitl", age: 25, city: "Kansas City, MO", hue: 4, gender: "woman", pronouns: "she/her", seeking: ["woman", "nonbinary"], contents: [], openTo: ["teens"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/53.jpg",
      bio: "Has a running joke about backyard birdwatching. Open to whatever shape a family ends up taking. No games, just someone worth rearranging a Tuesday for." },
    { name: "Quinn", age: 52, city: "Eugene, OR", hue: 3, gender: "nonbinary", pronouns: "she/they", seeking: ["nonbinary", "woman", "man"], contents: [], openTo: ["teens"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/83.jpg",
      bio: "Can't stop recommending bad karaoke. Great with kids, better with snacks, best with patience. Good conversation over a good meal, most days of the week." },
    { name: "Tanvi", age: 44, city: "Raleigh, NC", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["man", "woman"], contents: ["young", "adult", "teens"], counts: { young: "1", adult: "1", teens: "2" }, openTo: ["adult", "young", "ready"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/54.jpg",
      bio: "Finds any excuse to bring up Sunday pancakes. My weekends run on a schedule I didn't choose but wouldn't change. Slow and steady is the whole plan." },
    { name: "Marisol", age: 28, city: "Kansas City, MO", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["nonbinary", "man"], contents: ["teens", "adult", "young"], counts: { teens: "2", adult: "1", young: "3+" }, openTo: ["teens", "adult", "ready"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/55.jpg",
      bio: "Considers themself an amateur expert in neighborhood potlucks. Co-parenting has taught me more patience than I ever thought I had. Patience and a good sense of humor go a long way here." },
    { name: "Leo", age: 55, city: "Madison, WI", hue: 3, gender: "man", pronouns: "he/him", seeking: ["woman"], contents: ["teens", "young", "adult"], counts: { young: "2", adult: "3+" }, openTo: ["teens"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/84.jpg",
      bio: "Finds any excuse to bring up weekend trail runs. My weekends run on a schedule I didn't choose but wouldn't change. Looking for someone who shows up, on time and on purpose." },
    { name: "Tanvi", age: 40, city: "Phoenix, AZ", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["man", "nonbinary"], contents: ["adult"], counts: { adult: "1" }, openTo: ["teens", "ready"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/56.jpg",
      bio: "Spends most weekends chasing down local trivia nights. Most nights end with one more glass of water and one more hug. Family is whoever you choose to show up for — every time." },
    { name: "Vance", age: 42, city: "Minneapolis, MN", hue: 1, gender: "man", pronouns: "he/him", seeking: ["woman", "man"], contents: ["teens"], counts: { teens: "1" }, openTo: ["young", "ready"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/85.jpg",
      bio: "Considers themself an amateur expert in neighborhood potlucks. Homework help is a nightly event around here. Kindness is the only dealbreaker that matters." },
    { name: "Priya", age: 27, city: "Durham, NC", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["man", "woman"], contents: [], openTo: ["young", "teens"], role: "handson", photo: "https://randomuser.me/api/portraits/women/57.jpg",
      bio: "Genuinely obsessed with Sunday pancakes. No kids of my own yet, but I've always pictured a full house. No games, just someone worth rearranging a Tuesday for." },
    { name: "Nico", age: 33, city: "Cincinnati, OH", hue: 3, gender: "nonbinary", pronouns: "they/them", seeking: ["man"], contents: ["young", "adult", "teens"], counts: { young: "2", adult: "1", teens: "3+" }, openTo: ["teens", "ready"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/58.jpg",
      bio: "Spends most weekends chasing down a solid playlist. Co-parenting has taught me more patience than I ever thought I had. Here for the long, unglamorous, worth-it version of things." },
    { name: "Rowan", age: 49, city: "Portland, OR", hue: 4, gender: "nonbinary", pronouns: "she/they", seeking: ["man"], contents: [], openTo: ["young", "adult"], role: "handson", photo: "https://randomuser.me/api/portraits/men/86.jpg",
      bio: "Still gets excited about board game night. Open to whatever shape a family ends up taking. Patience and a good sense of humor go a long way here." },
    { name: "Alex", age: 38, city: "St. Louis, MO", hue: 2, gender: "man", pronouns: "he/him", seeking: ["man", "nonbinary"], contents: ["adult"], counts: { adult: "2" }, openTo: ["teens", "young"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/87.jpg",
      bio: "Never says no to a solid playlist. My nest is loud, a little chaotic, and exactly how I like it. Slow and steady is the whole plan." },
    { name: "Reese", age: 55, city: "Chattanooga, TN", hue: 4, gender: "nonbinary", pronouns: "he/they", seeking: ["man"], contents: [], openTo: ["young", "adult", "teens"], role: "open", photo: "https://randomuser.me/api/portraits/women/59.jpg",
      bio: "Has a running joke about local trivia nights. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. Not chasing perfect, just chasing real." },
    { name: "Theo", age: 45, city: "Richmond, VA", hue: 1, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: ["young", "teens", "adult"], counts: { young: "1", adult: "2" }, openTo: ["adult"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/88.jpg",
      bio: "Finds any excuse to bring up backyard birdwatching. My weekends run on a schedule I didn't choose but wouldn't change. Patience and a good sense of humor go a long way here." },
    { name: "Petra", age: 39, city: "Charlottesville, VA", hue: 4, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: ["adult", "teens"], counts: { adult: "2" }, openTo: ["adult", "ready"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/60.jpg",
      bio: "Runs on strong coffee and stronger opinions about a good used bookstore. Caregiving rearranged my whole life, and I wouldn't undo it. Kindness is the only dealbreaker that matters." },
    { name: "Leo", age: 42, city: "Kansas City, MO", hue: 1, gender: "man", pronouns: "he/him", seeking: ["man"], contents: [], openTo: ["adult", "teens", "young"], role: "handson", photo: "https://randomuser.me/api/portraits/men/89.jpg",
      bio: "Runs on strong coffee and stronger opinions about a solid playlist. Not in a rush, just genuinely open. Family is whoever you choose to show up for — every time." },
    { name: "Silas", age: 48, city: "Cedar Park, TX", hue: 3, gender: "man", pronouns: "he/him", seeking: ["man"], contents: [], openTo: ["young", "adult"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/90.jpg",
      bio: "Spends most weekends chasing down the family group chat. Great with kids, better with snacks, best with patience. Here for the long, unglamorous, worth-it version of things." },
    { name: "Alex", age: 36, city: "Cincinnati, OH", hue: 2, gender: "man", pronouns: "he/him", seeking: ["woman"], contents: ["young"], counts: { young: "1" }, openTo: ["young"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/91.jpg",
      bio: "Can't stop recommending local trivia nights. Most nights end with one more glass of water and one more hug. Family is whoever you choose to show up for — every time." },
    { name: "Owen", age: 44, city: "Cedar Park, TX", hue: 4, gender: "man", pronouns: "he/him", seeking: ["man"], contents: [], openTo: ["adult", "teens"], role: "open", photo: "https://randomuser.me/api/portraits/men/92.jpg",
      bio: "Will absolutely talk your ear off about Sunday pancakes. Not in a rush, just genuinely open. No games, just someone worth rearranging a Tuesday for." },
    { name: "Ingrid", age: 32, city: "Tucson, AZ", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: [], openTo: ["adult", "teens"], openToCounts: ["3+"], role: "handson", photo: "https://randomuser.me/api/portraits/women/61.jpg",
      bio: "Has a running joke about board game night. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. Looking for someone who shows up, on time and on purpose." },
    { name: "Petra", age: 24, city: "Durham, NC", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["man", "woman"], contents: ["young", "teens"], counts: { young: "3+", teens: "3+" }, openTo: ["teens", "young", "adult"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/62.jpg",
      bio: "Genuinely obsessed with backyard birdwatching. Homework help is a nightly event around here. Not chasing perfect, just chasing real." },
    { name: "Leo", age: 32, city: "Kansas City, MO", hue: 3, gender: "man", pronouns: "he/they", seeking: ["woman"], contents: ["adult", "teens"], counts: { adult: "1" }, openTo: ["adult", "ready"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/93.jpg",
      bio: "Runs on strong coffee and stronger opinions about farmers market tomatoes. Bedtime negotiations are basically a part-time job at this point. Looking for someone who shows up, on time and on purpose." },
    { name: "Harper", age: 40, city: "Round Rock, TX", hue: 2, gender: "woman", pronouns: "she/they", seeking: ["nonbinary"], contents: [], openTo: ["adult", "young"], openToCounts: ["2"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/63.jpg",
      bio: "Will absolutely talk your ear off about the perfect brisket. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. Slow and steady is the whole plan." },
    { name: "Nova", age: 38, city: "Sacramento, CA", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["woman", "nonbinary"], contents: ["young", "teens", "adult"], counts: { young: "1", teens: "3+", adult: "3+" }, openTo: ["young", "teens", "adult"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/64.jpg",
      bio: "Runs on strong coffee and stronger opinions about a well-organized junk drawer. Most nights end with one more glass of water and one more hug. Looking for someone who means what they say." },
    { name: "Lena", age: 44, city: "Columbus, OH", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["woman", "man"], contents: ["adult", "young", "teens"], counts: { young: "3+" }, openTo: ["adult", "ready"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/65.jpg",
      bio: "Considers themself an amateur expert in local trivia nights. My nest is loud, a little chaotic, and exactly how I like it. Kindness is the only dealbreaker that matters." },
    { name: "Remy", age: 35, city: "Eugene, OR", hue: 1, gender: "nonbinary", pronouns: "they/them", seeking: ["man"], contents: [], openTo: ["adult", "teens", "young"], role: "handson", photo: "https://randomuser.me/api/portraits/men/94.jpg",
      bio: "Finds any excuse to bring up terrible puns. Great with kids, better with snacks, best with patience. Good conversation over a good meal, most days of the week." },
    { name: "Priya", age: 46, city: "Milwaukee, WI", hue: 1, gender: "woman", pronouns: "she/they", seeking: ["man"], contents: ["young", "teens", "adult"], counts: { young: "1", teens: "3+", adult: "3+" }, openTo: ["adult", "teens", "ready"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/66.jpg",
      bio: "Can't stop recommending weekend trail runs. Caregiving rearranged my whole life, and I wouldn't undo it. Slow and steady is the whole plan." },
    { name: "Nate", age: 43, city: "Fort Collins, CO", hue: 3, gender: "man", pronouns: "he/they", seeking: ["woman", "man"], contents: [], openTo: ["adult"], role: "open", photo: "https://randomuser.me/api/portraits/men/95.jpg",
      bio: "Runs on strong coffee and stronger opinions about a well-organized junk drawer. Not in a rush, just genuinely open. Looking for someone who shows up, on time and on purpose." },
    { name: "Beckett", age: 44, city: "Pflugerville, TX", hue: 4, gender: "man", pronouns: "he/they", seeking: ["man", "nonbinary"], contents: ["young"], counts: { young: "1" }, openTo: ["teens", "young", "adult"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/96.jpg",
      bio: "Can't stop recommending Sunday pancakes. Bedtime negotiations are basically a part-time job at this point. Kindness is the only dealbreaker that matters." },
    { name: "Elena", age: 30, city: "Portland, OR", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["nonbinary"], contents: ["young", "adult"], counts: { young: "2", adult: "1" }, openTo: ["adult", "teens", "ready"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/67.jpg",
      bio: "Runs on strong coffee and stronger opinions about terrible puns. Bedtime negotiations are basically a part-time job at this point. Slow and steady is the whole plan." },
    { name: "Nico", age: 32, city: "San Diego, CA", hue: 4, gender: "nonbinary", pronouns: "she/they", seeking: ["nonbinary", "man", "woman"], contents: ["adult", "teens"], counts: { teens: "3+" }, openTo: ["teens", "adult", "young", "ready"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/68.jpg",
      bio: "Genuinely obsessed with neighborhood potlucks. Homework help is a nightly event around here. Here for the long, unglamorous, worth-it version of things." },
    { name: "Tobias", age: 31, city: "Denver, CO", hue: 4, gender: "man", pronouns: "he/him", seeking: ["woman"], contents: ["teens", "young", "adult"], counts: { young: "1", adult: "2" }, openTo: ["teens"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/97.jpg",
      bio: "Spends most weekends chasing down farmers market tomatoes. My nest is loud, a little chaotic, and exactly how I like it. Family is whoever you choose to show up for — every time." },
    { name: "Ines", age: 25, city: "Salt Lake City, UT", hue: 1, gender: "woman", pronouns: "she/they", seeking: ["man", "woman"], contents: [], openTo: ["adult"], openToCounts: ["3+", "2"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/69.jpg",
      bio: "Spends most weekends chasing down a great taco truck. Open to whatever shape a family ends up taking. Looking for someone who shows up, on time and on purpose." },
    { name: "Fiona", age: 49, city: "Columbus, OH", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["man", "nonbinary"], contents: [], openTo: ["young", "adult", "teens"], role: "handson", photo: "https://randomuser.me/api/portraits/women/70.jpg",
      bio: "Can't stop recommending local trivia nights. Great with kids, better with snacks, best with patience. Good conversation over a good meal, most days of the week." },
    { name: "Remy", age: 27, city: "Charlottesville, VA", hue: 2, gender: "nonbinary", pronouns: "she/they", seeking: ["man", "woman", "nonbinary"], contents: [], openTo: ["adult"], openToCounts: ["2"], role: "handson", photo: "https://randomuser.me/api/portraits/men/98.jpg",
      bio: "Genuinely obsessed with farmers market tomatoes. Great with kids, better with snacks, best with patience. Not chasing perfect, just chasing real." },
    { name: "Jules", age: 45, city: "Milwaukee, WI", hue: 3, gender: "nonbinary", pronouns: "they/them", seeking: ["man", "woman"], contents: ["young", "adult", "teens"], counts: { young: "2", teens: "1" }, openTo: ["teens", "adult", "young", "ready"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/71.jpg",
      bio: "Genuinely obsessed with gardening disasters. Caregiving rearranged my whole life, and I wouldn't undo it. Kindness is the only dealbreaker that matters." },
    { name: "Lena", age: 43, city: "Minneapolis, MN", hue: 1, gender: "woman", pronouns: "she/they", seeking: ["nonbinary", "woman"], contents: ["adult", "teens"], counts: { adult: "2", teens: "2" }, openTo: ["adult", "young"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/women/72.jpg",
      bio: "Runs on strong coffee and stronger opinions about a well-organized junk drawer. My nest is loud, a little chaotic, and exactly how I like it. Good conversation over a good meal, most days of the week." },
    { name: "Sam", age: 53, city: "Raleigh, NC", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: ["young", "teens"], counts: { young: "2" }, openTo: ["teens", "ready"], openToCounts: ["3+", "1"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/73.jpg",
      bio: "Genuinely obsessed with backyard birdwatching. Co-parenting has taught me more patience than I ever thought I had. Family is whoever you choose to show up for — every time." },
    { name: "Sam", age: 51, city: "Pflugerville, TX", hue: 3, gender: "nonbinary", pronouns: "they/them", seeking: ["nonbinary", "man"], contents: ["adult", "young"], counts: { adult: "3+", young: "1" }, openTo: ["teens", "young", "adult", "ready"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/74.jpg",
      bio: "Considers themself an amateur expert in weekend car repairs. Homework help is a nightly event around here. Not chasing perfect, just chasing real." },
    { name: "Petra", age: 54, city: "Eugene, OR", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["man", "woman"], contents: [], openTo: ["young", "teens"], openToCounts: ["1", "3+"], role: "handson", photo: "https://randomuser.me/api/portraits/women/75.jpg",
      bio: "Spends most weekends chasing down a good used bookstore. Open to whatever shape a family ends up taking. Slow and steady is the whole plan." },
    { name: "Gideon", age: 29, city: "Boise, ID", hue: 2, gender: "man", pronouns: "he/they", seeking: ["nonbinary"], contents: ["young"], counts: { young: "3+" }, openTo: ["adult"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/99.jpg",
      bio: "Finds any excuse to bring up board game night. Homework help is a nightly event around here. Kindness is the only dealbreaker that matters." },
    { name: "Amir", age: 40, city: "Chattanooga, TN", hue: 4, gender: "man", pronouns: "he/they", seeking: ["nonbinary", "woman"], contents: ["young", "teens"], openTo: ["teens", "adult", "young"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/0.jpg",
      bio: "Still gets excited about terrible puns. My weekends run on a schedule I didn't choose but wouldn't change. Slow and steady is the whole plan." },
    { name: "Colette", age: 26, city: "Denver, CO", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["woman", "man"], contents: ["teens", "young"], counts: { young: "2" }, openTo: ["adult", "young", "ready"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/76.jpg",
      bio: "Has a running joke about live music on a school night. My nest is loud, a little chaotic, and exactly how I like it. Here for the long, unglamorous, worth-it version of things." },
    { name: "Maya", age: 30, city: "Nashville, TN", hue: 4, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: ["young", "teens", "adult"], counts: { young: "2", teens: "2", adult: "2" }, openTo: ["young", "ready"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/77.jpg",
      bio: "Never says no to a good used bookstore. Bedtime negotiations are basically a part-time job at this point. Patience and a good sense of humor go a long way here." },
    { name: "Kenji", age: 57, city: "Asheville, NC", hue: 1, gender: "man", pronouns: "he/they", seeking: ["man"], contents: ["young", "adult", "teens"], counts: { young: "1", adult: "1", teens: "1" }, openTo: ["adult", "teens", "young"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/1.jpg",
      bio: "Can't stop recommending a solid playlist. My nest is loud, a little chaotic, and exactly how I like it. No games, just someone worth rearranging a Tuesday for." },
    { name: "Colette", age: 32, city: "Austin, TX", hue: 4, gender: "woman", pronouns: "she/her", seeking: ["woman", "man"], contents: [], openTo: ["teens", "adult", "young"], role: "open", photo: "https://randomuser.me/api/portraits/women/78.jpg",
      bio: "Genuinely obsessed with gardening disasters. Great with kids, better with snacks, best with patience. Here for the long, unglamorous, worth-it version of things." },
    { name: "Kenji", age: 29, city: "Chattanooga, TN", hue: 3, gender: "man", pronouns: "he/they", seeking: ["man"], contents: ["young", "adult", "teens"], openTo: ["adult"], openToCounts: ["2", "3+"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/2.jpg",
      bio: "Finds any excuse to bring up farmers market tomatoes. Most nights end with one more glass of water and one more hug. Good conversation over a good meal, most days of the week." },
    { name: "Nate", age: 54, city: "Georgetown, TX", hue: 3, gender: "man", pronouns: "he/him", seeking: ["man", "nonbinary"], contents: [], openTo: ["teens", "adult"], role: "handson", photo: "https://randomuser.me/api/portraits/men/3.jpg",
      bio: "Will absolutely talk your ear off about home-brewed iced tea. Great with kids, better with snacks, best with patience. Here for the long, unglamorous, worth-it version of things." },
    { name: "Wren", age: 50, city: "Pflugerville, TX", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["nonbinary", "woman"], contents: ["teens", "adult", "young"], counts: { adult: "2", young: "3+" }, openTo: ["adult", "teens", "young", "ready"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/79.jpg",
      bio: "Genuinely obsessed with a good used bookstore. Most nights end with one more glass of water and one more hug. Kindness is the only dealbreaker that matters." },
    { name: "Marisol", age: 27, city: "Raleigh, NC", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: ["young", "adult"], counts: { adult: "1" }, openTo: ["adult", "young", "ready"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/80.jpg",
      bio: "Spends most weekends chasing down bad karaoke. My nest is loud, a little chaotic, and exactly how I like it. Here for the long, unglamorous, worth-it version of things." },
    { name: "Gideon", age: 32, city: "San Diego, CA", hue: 3, gender: "man", pronouns: "he/him", seeking: ["woman"], contents: ["adult"], counts: { adult: "3+" }, openTo: ["teens", "young", "ready"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/4.jpg",
      bio: "Can't stop recommending neighborhood potlucks. Most nights end with one more glass of water and one more hug. Not chasing perfect, just chasing real." },
    { name: "Priya", age: 24, city: "Sacramento, CA", hue: 4, gender: "woman", pronouns: "she/her", seeking: ["nonbinary", "woman"], contents: [], openTo: ["young"], role: "handson", photo: "https://randomuser.me/api/portraits/women/81.jpg",
      bio: "Genuinely obsessed with backyard birdwatching. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. Here for the long, unglamorous, worth-it version of things." },
    { name: "Odette", age: 33, city: "Charlottesville, VA", hue: 4, gender: "woman", pronouns: "she/her", seeking: ["man", "woman"], contents: [], openTo: ["young", "adult"], openToCounts: ["1", "3+"], role: "open", photo: "https://randomuser.me/api/portraits/women/82.jpg",
      bio: "Spends most weekends chasing down bad karaoke. Open to whatever shape a family ends up taking. Kindness is the only dealbreaker that matters." },
    { name: "Ingrid", age: 47, city: "Pflugerville, TX", hue: 2, gender: "woman", pronouns: "she/they", seeking: ["woman"], contents: [], openTo: ["teens", "adult"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/83.jpg",
      bio: "Will absolutely talk your ear off about live music on a school night. Not in a rush, just genuinely open. Looking for someone who shows up, on time and on purpose." },
    { name: "Fiona", age: 52, city: "Denver, CO", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: [], openTo: ["teens"], openToCounts: ["1", "2"], role: "handson", photo: "https://randomuser.me/api/portraits/women/84.jpg",
      bio: "Spends most weekends chasing down a good used bookstore. Ready to be the steady, dependable one in someone else's story. Family is whoever you choose to show up for — every time." },
    { name: "Hassan", age: 45, city: "Boise, ID", hue: 4, gender: "man", pronouns: "he/they", seeking: ["nonbinary", "woman"], contents: [], openTo: ["adult", "teens"], role: "handson", photo: "https://randomuser.me/api/portraits/men/5.jpg",
      bio: "Will absolutely talk your ear off about backyard birdwatching. No kids of my own yet, but I've always pictured a full house. Looking for someone who shows up, on time and on purpose." },
    { name: "Quinn", age: 31, city: "Madison, WI", hue: 1, gender: "nonbinary", pronouns: "he/they", seeking: ["nonbinary", "man"], contents: [], openTo: ["adult"], role: "handson", photo: "https://randomuser.me/api/portraits/men/6.jpg",
      bio: "Will absolutely talk your ear off about live music on a school night. No kids of my own yet, but I've always pictured a full house. Patience and a good sense of humor go a long way here." },
    { name: "Gideon", age: 53, city: "Milwaukee, WI", hue: 2, gender: "man", pronouns: "he/they", seeking: ["woman", "nonbinary"], contents: [], openTo: ["young"], role: "handson", photo: "https://randomuser.me/api/portraits/men/7.jpg",
      bio: "Will absolutely talk your ear off about terrible puns. No kids of my own yet, but I've always pictured a full house. No games, just someone worth rearranging a Tuesday for." },
    { name: "Felix", age: 40, city: "Eugene, OR", hue: 2, gender: "man", pronouns: "he/they", seeking: ["nonbinary"], contents: [], openTo: ["young", "teens"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/8.jpg",
      bio: "Genuinely obsessed with thrift store finds. Open to whatever shape a family ends up taking. Not chasing perfect, just chasing real." },
    { name: "Elena", age: 43, city: "Madison, WI", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["man", "nonbinary"], contents: ["teens"], counts: { teens: "2" }, openTo: ["teens", "adult"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/85.jpg",
      bio: "Will absolutely talk your ear off about local trivia nights. My weekends run on a schedule I didn't choose but wouldn't change. Patience and a good sense of humor go a long way here." },
    { name: "Beckett", age: 44, city: "Durham, NC", hue: 3, gender: "man", pronouns: "he/they", seeking: ["nonbinary", "man"], contents: ["young"], counts: { young: "3+" }, openTo: ["young", "ready"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/9.jpg",
      bio: "Considers themself an amateur expert in a solid playlist. Caregiving rearranged my whole life, and I wouldn't undo it. Kindness is the only dealbreaker that matters." },
    { name: "Colette", age: 37, city: "Denver, CO", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["woman", "man"], contents: [], openTo: ["teens", "adult"], openToCounts: ["1", "3+"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/86.jpg",
      bio: "Spends most weekends chasing down weekend trail runs. Open to whatever shape a family ends up taking. No games, just someone worth rearranging a Tuesday for." },
    { name: "Aaron", age: 34, city: "Round Rock, TX", hue: 2, gender: "man", pronouns: "he/they", seeking: ["man"], contents: ["teens"], openTo: ["teens", "young"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/10.jpg",
      bio: "Considers themself an amateur expert in a good used bookstore. Bedtime negotiations are basically a part-time job at this point. Slow and steady is the whole plan." },
    { name: "Zoe", age: 40, city: "Round Rock, TX", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["nonbinary", "man"], contents: ["teens", "adult"], counts: { teens: "3+", adult: "2" }, openTo: ["teens", "young"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/87.jpg",
      bio: "Never says no to Sunday pancakes. Homework help is a nightly event around here. Looking for someone who shows up, on time and on purpose." },
    { name: "Felix", age: 42, city: "Eugene, OR", hue: 3, gender: "man", pronouns: "he/him", seeking: ["man"], contents: [], openTo: ["adult", "young", "teens"], role: "open", photo: "https://randomuser.me/api/portraits/men/11.jpg",
      bio: "Has a running joke about the family group chat. Ready to be the steady, dependable one in someone else's story. Looking for someone who means what they say." },
    { name: "Emil", age: 34, city: "Denver, CO", hue: 1, gender: "man", pronouns: "he/they", seeking: ["nonbinary"], contents: ["adult", "teens", "young"], counts: { teens: "1", young: "2" }, openTo: ["teens", "ready"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/12.jpg",
      bio: "Finds any excuse to bring up farmers market tomatoes. Caregiving rearranged my whole life, and I wouldn't undo it. Good conversation over a good meal, most days of the week." },
    { name: "Malik", age: 55, city: "Phoenix, AZ", hue: 4, gender: "man", pronouns: "he/him", seeking: ["woman"], contents: ["teens"], counts: { teens: "3+" }, openTo: ["adult", "young", "teens", "ready"], openToCounts: ["1", "3+"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/13.jpg",
      bio: "Never says no to backyard birdwatching. Homework help is a nightly event around here. Kindness is the only dealbreaker that matters." },
    { name: "Sienna", age: 52, city: "Round Rock, TX", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: ["teens"], counts: { teens: "2" }, openTo: ["young", "teens"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/88.jpg",
      bio: "Considers themself an amateur expert in the perfect brisket. My weekends run on a schedule I didn't choose but wouldn't change. Not chasing perfect, just chasing real." },
    { name: "Theo", age: 36, city: "Fort Collins, CO", hue: 2, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "man"], contents: [], openTo: ["teens", "young", "adult"], openToCounts: ["2"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/14.jpg",
      bio: "Considers themself an amateur expert in bad karaoke. Not in a rush, just genuinely open. No games, just someone worth rearranging a Tuesday for." },
    { name: "Xochitl", age: 28, city: "Boise, ID", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["man", "woman"], contents: ["teens"], counts: { teens: "1" }, openTo: ["adult", "young"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/89.jpg",
      bio: "Finds any excuse to bring up farmers market tomatoes. Homework help is a nightly event around here. Here for the long, unglamorous, worth-it version of things." },
    { name: "Reese", age: 41, city: "Fort Collins, CO", hue: 3, gender: "nonbinary", pronouns: "he/they", seeking: ["man", "nonbinary"], contents: ["young", "adult", "teens"], counts: { young: "1", adult: "2" }, openTo: ["teens", "adult", "ready"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/men/15.jpg",
      bio: "Will absolutely talk your ear off about home-brewed iced tea. Co-parenting has taught me more patience than I ever thought I had. No games, just someone worth rearranging a Tuesday for." },
    { name: "Felix", age: 42, city: "Madison, WI", hue: 4, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: [], openTo: ["teens", "young", "adult"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/16.jpg",
      bio: "Spends most weekends chasing down a good used bookstore. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. Patience and a good sense of humor go a long way here." },
    { name: "Beckett", age: 51, city: "Richmond, VA", hue: 4, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: [], openTo: ["teens", "young", "adult"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/17.jpg",
      bio: "Will absolutely talk your ear off about bad karaoke. Great with kids, better with snacks, best with patience. Here for the long, unglamorous, worth-it version of things." },
    { name: "Ingrid", age: 57, city: "St. Paul, MN", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: [], openTo: ["teens", "adult"], role: "open", photo: "https://randomuser.me/api/portraits/women/90.jpg",
      bio: "Never says no to gardening disasters. Not in a rush, just genuinely open. Kindness is the only dealbreaker that matters." },
    { name: "Delphine", age: 36, city: "Cincinnati, OH", hue: 4, gender: "woman", pronouns: "she/her", seeking: ["man", "nonbinary"], contents: ["young", "teens", "adult"], counts: { young: "1", teens: "3+" }, openTo: ["adult", "teens", "young"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/91.jpg",
      bio: "Still gets excited about farmers market tomatoes. My nest is loud, a little chaotic, and exactly how I like it. Not chasing perfect, just chasing real." },
    { name: "Nate", age: 37, city: "Richmond, VA", hue: 2, gender: "man", pronouns: "he/him", seeking: ["woman", "man"], contents: ["teens"], counts: { teens: "3+" }, openTo: ["young"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/18.jpg",
      bio: "Has a running joke about live music on a school night. My nest is loud, a little chaotic, and exactly how I like it. Looking for someone who shows up, on time and on purpose." },
    { name: "Anaya", age: 28, city: "Sacramento, CA", hue: 4, gender: "woman", pronouns: "she/her", seeking: ["nonbinary", "woman"], contents: ["teens", "adult"], counts: { teens: "2", adult: "1" }, openTo: ["teens", "adult"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/92.jpg",
      bio: "Spends most weekends chasing down a solid playlist. My weekends run on a schedule I didn't choose but wouldn't change. Family is whoever you choose to show up for — every time." },
    { name: "Delphine", age: 30, city: "Boulder, CO", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: ["young", "teens", "adult"], counts: { teens: "3+", adult: "2" }, openTo: ["adult", "young"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/93.jpg",
      bio: "Runs on strong coffee and stronger opinions about weekend trail runs. Bedtime negotiations are basically a part-time job at this point. Patience and a good sense of humor go a long way here." },
    { name: "Petra", age: 55, city: "Durham, NC", hue: 3, gender: "woman", pronouns: "she/they", seeking: ["man", "woman"], contents: ["adult"], counts: { adult: "2" }, openTo: ["young"], rhythm: "alternating", photo: "https://randomuser.me/api/portraits/women/94.jpg",
      bio: "Can't stop recommending bad karaoke. Homework help is a nightly event around here. Family is whoever you choose to show up for — every time." },
    { name: "Julian", age: 55, city: "Kansas City, MO", hue: 3, gender: "man", pronouns: "he/him", seeking: ["woman", "man"], contents: [], openTo: ["teens"], openToCounts: ["1", "2"], role: "handson", photo: "https://randomuser.me/api/portraits/men/19.jpg",
      bio: "Has a running joke about board game night. No kids of my own yet, but I've always pictured a full house. Not chasing perfect, just chasing real." },
    { name: "Grant", age: 50, city: "Durham, NC", hue: 1, gender: "man", pronouns: "he/him", seeking: ["woman"], contents: ["young", "adult"], counts: { young: "1" }, openTo: ["young", "adult"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/20.jpg",
      bio: "Runs on strong coffee and stronger opinions about neighborhood potlucks. Homework help is a nightly event around here. Family is whoever you choose to show up for — every time." },
    { name: "Micah", age: 57, city: "Austin, TX", hue: 2, gender: "man", pronouns: "he/him", seeking: ["man"], contents: [], openTo: ["teens", "young", "adult"], openToCounts: ["2", "3+"], role: "open", photo: "https://randomuser.me/api/portraits/men/21.jpg",
      bio: "Will absolutely talk your ear off about live music on a school night. Not in a rush, just genuinely open. Looking for someone who means what they say." },
    { name: "Nadia", age: 26, city: "St. Paul, MN", hue: 4, gender: "woman", pronouns: "she/they", seeking: ["nonbinary"], contents: ["adult", "young", "teens"], counts: { adult: "2", young: "2", teens: "3+" }, openTo: ["teens", "adult", "ready"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/95.jpg",
      bio: "Has a running joke about a good used bookstore. My weekends run on a schedule I didn't choose but wouldn't change. Family is whoever you choose to show up for — every time." },
    { name: "Nadia", age: 33, city: "Raleigh, NC", hue: 4, gender: "woman", pronouns: "she/her", seeking: ["nonbinary", "man"], contents: ["teens", "adult", "young"], counts: { teens: "1" }, openTo: ["adult", "young"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/96.jpg",
      bio: "Still gets excited about weekend trail runs. Co-parenting has taught me more patience than I ever thought I had. No games, just someone worth rearranging a Tuesday for." },
    { name: "Elena", age: 51, city: "Kansas City, MO", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["nonbinary"], contents: [], openTo: ["adult", "young", "teens"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/97.jpg",
      bio: "Spends most weekends chasing down weekend trail runs. No kids of my own yet, but I've always pictured a full house. Kindness is the only dealbreaker that matters." },
    { name: "Harper", age: 40, city: "Fort Collins, CO", hue: 3, gender: "woman", pronouns: "she/they", seeking: ["man"], contents: [], openTo: ["adult", "young", "teens"], openToCounts: ["3+"], role: "handson", photo: "https://randomuser.me/api/portraits/women/98.jpg",
      bio: "Considers themself an amateur expert in a great taco truck. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. Kindness is the only dealbreaker that matters." },
    { name: "Bianca", age: 53, city: "Durham, NC", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["woman", "man"], contents: [], openTo: ["adult", "young"], role: "handson", photo: "https://randomuser.me/api/portraits/women/99.jpg",
      bio: "Genuinely obsessed with gardening disasters. Open to whatever shape a family ends up taking. Patience and a good sense of humor go a long way here." },
    { name: "Kenji", age: 30, city: "Madison, WI", hue: 4, gender: "man", pronouns: "he/him", seeking: ["man", "nonbinary"], contents: ["adult", "teens", "young"], counts: { adult: "3+", teens: "3+", young: "2" }, openTo: ["teens", "adult"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/22.jpg",
      bio: "Can't stop recommending farmers market tomatoes. My nest is loud, a little chaotic, and exactly how I like it. Good conversation over a good meal, most days of the week." },
    { name: "Marcus", age: 43, city: "Round Rock, TX", hue: 4, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: [], openTo: ["adult", "young"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/23.jpg",
      bio: "Genuinely obsessed with a solid playlist. Open to whatever shape a family ends up taking. Looking for someone who shows up, on time and on purpose." },
    { name: "Quinn", age: 53, city: "Boulder, CO", hue: 1, gender: "nonbinary", pronouns: "they/them", seeking: ["woman", "nonbinary"], contents: ["teens", "adult"], counts: { adult: "2" }, openTo: ["adult"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/women/0.jpg",
      bio: "Finds any excuse to bring up live music on a school night. Co-parenting has taught me more patience than I ever thought I had. Slow and steady is the whole plan." },
    { name: "Avery", age: 40, city: "Cincinnati, OH", hue: 3, gender: "nonbinary", pronouns: "they/them", seeking: ["man", "woman"], contents: ["adult", "young"], counts: { adult: "2", young: "1" }, openTo: ["adult", "teens", "young", "ready"], openToCounts: ["2"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/women/1.jpg",
      bio: "Runs on strong coffee and stronger opinions about home-brewed iced tea. Caregiving rearranged my whole life, and I wouldn't undo it. Family is whoever you choose to show up for — every time." },
    { name: "Grant", age: 43, city: "Tucson, AZ", hue: 3, gender: "man", pronouns: "he/him", seeking: ["nonbinary"], contents: ["young"], counts: { young: "3+" }, openTo: ["young"], openToCounts: ["3+", "2"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/24.jpg",
      bio: "Will absolutely talk your ear off about neighborhood potlucks. Co-parenting has taught me more patience than I ever thought I had. Slow and steady is the whole plan." },
    { name: "Tanvi", age: 28, city: "Nashville, TN", hue: 3, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: [], openTo: ["young", "adult"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/2.jpg",
      bio: "Spends most weekends chasing down bad karaoke. Great with kids, better with snacks, best with patience. Not chasing perfect, just chasing real." },
    { name: "Tobias", age: 55, city: "Tucson, AZ", hue: 3, gender: "man", pronouns: "he/him", seeking: ["man", "woman"], contents: [], openTo: ["young"], role: "open", photo: "https://randomuser.me/api/portraits/men/25.jpg",
      bio: "Can't stop recommending farmers market tomatoes. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. Family is whoever you choose to show up for — every time." },
    { name: "Derek", age: 36, city: "Denver, CO", hue: 2, gender: "man", pronouns: "he/him", seeking: ["man"], contents: ["young", "teens", "adult"], counts: { young: "3+", teens: "2", adult: "3+" }, openTo: ["young", "teens"], rhythm: "fulltime", photo: "https://randomuser.me/api/portraits/men/26.jpg",
      bio: "Genuinely obsessed with thrift store finds. Bedtime negotiations are basically a part-time job at this point. No games, just someone worth rearranging a Tuesday for." },
    { name: "Marisol", age: 27, city: "Charlottesville, VA", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["nonbinary"], contents: [], openTo: ["adult", "teens", "young"], openToCounts: ["3+", "2"], role: "supportive", photo: "https://randomuser.me/api/portraits/women/3.jpg",
      bio: "Genuinely obsessed with board game night. Open to whatever shape a family ends up taking. Not chasing perfect, just chasing real." },
    { name: "Zoe", age: 43, city: "Sacramento, CA", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["woman"], contents: [], openTo: ["teens"], role: "open", photo: "https://randomuser.me/api/portraits/women/4.jpg",
      bio: "Considers themself an amateur expert in a well-organized junk drawer. Not in a rush, just genuinely open. Here for the long, unglamorous, worth-it version of things." },
    { name: "Dario", age: 30, city: "Eugene, OR", hue: 2, gender: "man", pronouns: "he/they", seeking: ["woman"], contents: ["adult", "teens", "young"], counts: { adult: "3+", teens: "2", young: "1" }, openTo: ["adult"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/27.jpg",
      bio: "Still gets excited about bad karaoke. My nest is loud, a little chaotic, and exactly how I like it. Slow and steady is the whole plan." },
    { name: "Aisha", age: 35, city: "Portland, OR", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["man", "nonbinary"], contents: [], openTo: ["teens", "adult"], openToCounts: ["2"], role: "handson", photo: "https://randomuser.me/api/portraits/women/5.jpg",
      bio: "Can't stop recommending local trivia nights. Not in a rush, just genuinely open. Not chasing perfect, just chasing real." },
    { name: "Jules", age: 43, city: "Columbus, OH", hue: 4, gender: "nonbinary", pronouns: "they/them", seeking: ["nonbinary", "woman"], contents: [], openTo: ["teens", "adult"], role: "handson", photo: "https://randomuser.me/api/portraits/women/6.jpg",
      bio: "Spends most weekends chasing down board game night. Ready to be the steady, dependable one in someone else's story. Not chasing perfect, just chasing real." },
    { name: "Theo", age: 47, city: "Tucson, AZ", hue: 2, gender: "man", pronouns: "he/him", seeking: ["woman", "man"], contents: ["young", "teens"], counts: { young: "1" }, openTo: ["young"], openToCounts: ["2"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/28.jpg",
      bio: "Finds any excuse to bring up farmers market tomatoes. Homework help is a nightly event around here. Here for the long, unglamorous, worth-it version of things." },
    { name: "Kwame", age: 36, city: "Kansas City, MO", hue: 3, gender: "man", pronouns: "he/him", seeking: ["nonbinary", "man"], contents: ["teens", "adult"], counts: { teens: "2" }, openTo: ["young", "teens"], openToCounts: ["1", "2"], rhythm: "varies", photo: "https://randomuser.me/api/portraits/men/29.jpg",
      bio: "Has a running joke about a great taco truck. Caregiving rearranged my whole life, and I wouldn't undo it. Not chasing perfect, just chasing real." },
    { name: "Skyler", age: 26, city: "Minneapolis, MN", hue: 4, gender: "nonbinary", pronouns: "he/they", seeking: ["nonbinary", "woman", "man"], contents: [], openTo: ["young", "adult"], role: "supportive", photo: "https://randomuser.me/api/portraits/men/30.jpg",
      bio: "Runs on strong coffee and stronger opinions about thrift store finds. Not in a rush, just genuinely open. Here for the long, unglamorous, worth-it version of things." },
    { name: "Diego", age: 26, city: "Columbus, OH", hue: 4, gender: "man", pronouns: "he/him", seeking: ["man", "nonbinary"], contents: ["teens", "young"], counts: { teens: "3+", young: "3+" }, openTo: ["teens", "ready"], rhythm: "weekends", photo: "https://randomuser.me/api/portraits/men/31.jpg",
      bio: "Considers themself an amateur expert in bad karaoke. My weekends run on a schedule I didn't choose but wouldn't change. Not chasing perfect, just chasing real." },
    { name: "Amir", age: 34, city: "Eugene, OR", hue: 4, gender: "man", pronouns: "he/him", seeking: ["man", "nonbinary"], contents: [], openTo: ["teens"], role: "open", photo: "https://randomuser.me/api/portraits/men/32.jpg",
      bio: "Still gets excited about a good used bookstore. Never pictured dating a parent until I actually thought about it — now I can't picture anything else. Kindness is the only dealbreaker that matters." },
  ];

  /* ============================================================
     🔒 PERMANENT SAFETY GATE — DO NOT WEAKEN OR REMOVE
     Fake/synthetic profiles (DEMO_SAMPLES) must NEVER be visible
     to a real production user. This check is deliberately direct
     (IS_PRODUCTION_HOST, not the derived ENV string) to minimize
     the surface area for a future bug to slip between the check
     and the hostname it's supposed to gate on.

     Defense in depth: a loud, unmissable startup canary below
     re-verifies this invariant every single time the app boots,
     on every environment — if it's ever violated, the app fails
     LOUD (visible error banner + console.error), not silently.
     ============================================================ */
  const SAMPLES = (typeof IS_PRODUCTION_HOST !== "undefined" && IS_PRODUCTION_HOST) ? [] : DEMO_SAMPLES;

  (function safetyCanary() {
    const isProd = typeof IS_PRODUCTION_HOST !== "undefined" && IS_PRODUCTION_HOST;
    if (isProd && SAMPLES.length > 0) {
      const msg = "🚨 SAFETY VIOLATION: " + SAMPLES.length + " fake demo profiles are visible on PRODUCTION. This must never happen — fix immediately.";
      console.error(msg);
      document.addEventListener("DOMContentLoaded", function () {
        const banner = document.createElement("div");
        banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#c00;color:#fff;padding:14px;text-align:center;font-family:sans-serif;font-weight:bold;";
        banner.textContent = msg;
        document.body.prepend(banner);
      });
    }
  })();

  /* Mutual pre-screening: each side must be open to everything in the
     other's nest. A partner with no kids/dependents (Nest-Ready) requires
     the explicit "ready" openness key — which only Full Nest members can
     select — so Nest-Ready ↔ Nest-Ready can never match. That pairing
     would defeat the purpose of the app. */
  function openToTheirNest(x, y) {
    if (!y.contents.length) return x.openTo.includes("ready");
    return y.contents.every(function (k) { return x.openTo.includes(k); });
  }

  function mutuallyOpen(a, b) {
    return openToTheirNest(a, b) && openToTheirNest(b, a);
  }

  /* Kid-count comfort: an optional private preference ("I'm open to 1 or 2
     kids") that hides profiles whose declared counts fall outside it.
     Undeclared counts always pass. Applied mutually. */
  function countsAcceptable(a, b) {
    const pref = a.openToCounts;
    if (!pref || !pref.length) return true;
    if (!b.counts) return true;
    return Object.keys(b.counts).every(function (k) {
      return pref.includes(b.counts[k]);
    });
  }

  /* ---------------- Rendering helpers ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function render(html) {
    $app.innerHTML = '<div class="view">' + html + "</div>";
    window.scrollTo(0, 0);
  }

  function brandRow() {
    return (
      '<div class="brand-row">' +
      '<span class="brand-mark">' + BRAND.logoMark + "</span>" +
      '<span class="brand-name">' + esc(BRAND.name) + "</span>" +
      "</div>"
    );
  }

  function dots(step, total) {
    let out = '<div class="progress-dots">';
    for (let i = 1; i <= total; i++) {
      const cls = i === step ? "active" : i < step ? "done" : "";
      out += '<span class="' + cls + '"></span>';
    }
    return out + "</div>";
  }

  function badgeChip(kind) {
    const b = BRAND.badges[kind];
    const cls = kind === "full" ? "badge badge-full" : "badge badge-ready";
    return '<span class="' + cls + '">' + b.icon + " " + esc(b.label) + "</span>";
  }

  function badgeKind(profile) {
    return profile.contents && profile.contents.length ? "full" : "ready";
  }

  /* Avatar: uploaded photo if present, else initials circle in a
     brand hue. Hues 2 & 4 are light — use dark text on those. */
  function avatarHTML(name, photo, hue, sizeClass) {
    if (photo) {
      return '<span class="avatar ' + sizeClass + '"><img src="' + photo + '" alt="" loading="lazy"></span>';
    }
    const h = hue || 1;
    const darkText = h === 2 || h === 4 ? " on-dark" : "";
    return (
      '<span class="avatar ' + sizeClass + darkText +
      '" style="background: var(--avatar-' + h + ')">' +
      esc(name.charAt(0).toUpperCase()) + "</span>"
    );
  }

  function userHue(name) {
    let sum = 0;
    for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
    return (sum % 4) + 1;
  }

  // Real member profiles (see dbRowToMatch below) don't collect age yet —
  // demo SAMPLES do. Omit the ", 34" suffix entirely rather than show a
  // blank or a fake number.
  function ageSuffix(s) {
    return s.age ? ", " + s.age : "";
  }

  // Stable identity across both demo SAMPLES (keyed by name — they have no
  // real id) and real member profiles (keyed by their Supabase auth id).
  // Used anywhere a card needs a click/data attribute so real likes can be
  // sent to the right person instead of just a display name.
  function matchKey(s) {
    return s._id ? "r:" + s._id : "d:" + s.name;
  }

  function findMatchByKey(key) {
    return SAMPLES.concat(realMatches).find(function (s) { return matchKey(s) === key; });
  }

  function toast(msg) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add("gone"); }, 1800);
    setTimeout(function () { el.remove(); }, 2200);
  }

  function checkPills(name, items, checkedKeys) {
    return items
      .map(function (it) {
        const checked = checkedKeys && checkedKeys.includes(it.key);
        return (
          '<label class="check-pill' + (checked ? " checked" : "") + '">' +
          '<input type="checkbox" name="' + name + '" value="' + it.key + '"' +
          (checked ? " checked" : "") + "> " +
          (it.icon ? it.icon + " " : "") + esc(it.label) +
          "</label>"
        );
      })
      .join("");
  }

  function wirePills(container) {
    container.querySelectorAll(".check-pill input").forEach(function (input) {
      input.addEventListener("change", function () {
        input.closest(".check-pill").classList.toggle("checked", input.checked);
      });
    });
  }

  function pillValues(container, name) {
    return Array.from(
      container.querySelectorAll('input[name="' + name + '"]:checked')
    ).map(function (i) { return i.value; });
  }

  /* ---------------- Likes, limits & premium ---------------- */

  /* Freemium BETA principles: the pre-screen and safety are NEVER
     paywalled. Nest filters, Rhythm Match, and see-who-liked-you are
     free. Strict daily caps (8 likes, 2 notes) keep the app feeling
     purposeful and exclusive — limits refresh, they aren't sold away
     until the upgrade path launches (FEATURES.upgradeEnabled). */
  const FREE_LIKES_PER_DAY = 8;
  const FREE_NOTES_PER_DAY = 2;   // the beta "2 messages per day" cap
  const PLUS_NOTES_PER_WEEK = 10; // future upgrade tier: capped on purpose

  function isPlus(user) { return !!(user && user.premium); }

  function countToday(list) {
    const today = new Date().toISOString().slice(0, 10);
    return (list || []).filter(function (d) { return d.slice(0, 10) === today; }).length;
  }

  function countThisWeek(list) {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    return (list || []).filter(function (d) { return new Date(d).getTime() > weekAgo; }).length;
  }

  function likesToday(user) {
    return countToday(user.usage && user.usage.likes);
  }

  function likesLeftToday(user) {
    return Math.max(0, FREE_LIKES_PER_DAY - likesToday(user));
  }

  function canLikeNow(user) {
    return isPlus(user) || likesToday(user) < FREE_LIKES_PER_DAY;
  }

  function noteLimit(user) {
    return isPlus(user) ? PLUS_NOTES_PER_WEEK : FREE_NOTES_PER_DAY;
  }

  function notesUsed(user) {
    const notes = user.usage && user.usage.notes;
    return isPlus(user) ? countThisWeek(notes) : countToday(notes);
  }

  function notesLeft(user) {
    return Math.max(0, noteLimit(user) - notesUsed(user));
  }

  function noteWindowWord(user) {
    return isPlus(user) ? "this week" : "today";
  }

  /* Daily/weekly cap tracking always stays local (not the real
     usage_events table — a future hardening item, not needed for caps
     to work correctly in BETA). Real matches ALSO get a real row in
     Supabase's `likes` table so the other member actually receives it
     (and, via the notify-like Edge Function + email, gets notified) —
     demo SAMPLES have no real id and can never write there. */
  function recordLike(match, note) {
    const user = currentUser();
    if (!user) return;
    const key = matchKey(match);
    const state = store.getDemoState(user.id);
    const likes = (state.likes || []).filter(function (l) { return l.key !== key; });
    likes.push({ key: key, note: note || "", at: new Date().toISOString() });
    const usage = state.usage || { likes: [], notes: [] };
    usage.likes = (usage.likes || []).concat(new Date().toISOString());
    if (note) usage.notes = (usage.notes || []).concat(new Date().toISOString());
    store.saveDemoState(user.id, { likes: likes, usage: usage });

    if (match._id && nestfulDB) {
      nestfulDB.sendLike(match._id, note).catch(function (err) {
        console.error("Real like didn't save to Supabase:", err);
      });
    }
  }

  /* ---------------- Onboarding draft state ---------------- */

  let draft = null;
  let editMode = false; // true when re-running the flow to edit an existing profile

  function freshDraft() {
    return { gender: "", genderDetail: "", pronouns: "", seeking: [], contents: [], counts: {}, rhythm: "", openTo: [], openToCounts: [], role: "", bio: "", city: "", photo: null, _origPhoto: null };
  }

  function draftFromProfile(p) {
    return {
      kind: p.contents && p.contents.length ? "full" : "ready",
      gender: p.gender || "",
      genderDetail: p.genderDetail || "",
      pronouns: p.pronouns || "",
      seeking: (p.seeking || []).slice(),
      contents: (p.contents || []).slice(),
      counts: Object.assign({}, p.counts || {}),
      rhythm: p.rhythm || "",
      openTo: (p.openTo || []).slice(),
      openToCounts: (p.openToCounts || []).slice(),
      role: p.role || "",
      city: p.city || "",
      bio: p.bio || "",
      photo: p.photo || null,
      _origPhoto: p.photo || null,
    };
  }

  /* ---------------- Views ---------------- */

  function viewConnectionError(err) {
    render(
      brandRow() +
      '<div class="card">' +
        '<h2 class="view-title">Couldn’t connect</h2>' +
        '<p class="view-sub" style="color:var(--danger)">' + esc(err.message || String(err)) + "</p>" +
        '<button class="btn btn-primary" id="ce-retry">Try again</button>' +
      "</div>"
    );
    document.getElementById("ce-retry").onclick = boot;
  }

  function viewLanding() {
    render(
      '<div class="hero">' +
        '<span class="brand-mark">' + BRAND.logoMark + "</span>" +
        "<h1>" + esc(BRAND.name) + "</h1>" +
        '<p class="tagline">' + esc(BRAND.tagline) + "</p>" +
        '<p class="subline">' + esc(BRAND.subline) + "</p>" +
        '<button class="btn btn-primary" id="go-signup">Create my account</button>' +
        '<button class="btn btn-secondary" id="go-signin">Sign in</button>' +
      "</div>"
    );
    document.getElementById("go-signup").onclick = viewSignup;
    document.getElementById("go-signin").onclick = viewSignin;
  }

  function viewSignup() {
    render(
      brandRow() +
      '<div class="card">' +
        '<h2 class="view-title">Create your account</h2>' +
        '<p class="view-sub">Two minutes now saves the awkward conversation later.</p>' +
        '<form id="signup-form" novalidate>' +
          '<label class="field">First name' +
            '<input type="text" id="su-name" autocomplete="given-name" required></label>' +
          '<label class="field">Email' +
            '<input type="email" id="su-email" autocomplete="email" required></label>' +
          '<label class="field">Password (6+ characters)' +
            '<input type="password" id="su-pass" autocomplete="new-password" required></label>' +
          '<label class="check-pill" id="su-terms-pill" style="margin-bottom:6px;font-size:13px">' +
            '<input type="checkbox" id="su-terms"> ' +
            "<span>I’m 18 or older and agree to the " +
            '<a href="terms.html" target="_blank" id="su-terms-link">Terms</a> and ' +
            '<a href="privacy.html" target="_blank" id="su-privacy-link">Privacy Policy</a></span>' +
          "</label>" +
          '<div class="error-msg" id="su-error"></div>' +
          '<button class="btn btn-primary" type="submit">Continue</button>' +
        "</form>" +
        '<div class="link-row">Already have an account? <a id="go-signin">Sign in</a></div>' +
      "</div>"
    );

    document.getElementById("go-signin").onclick = viewSignin;
    ["su-terms-link", "su-privacy-link"].forEach(function (id) {
      document.getElementById(id).addEventListener("click", function (e) {
        e.stopPropagation(); // open the doc without toggling the checkbox
      });
    });
    const $termsBox = document.getElementById("su-terms");
    $termsBox.addEventListener("change", function () {
      document.getElementById("su-terms-pill").classList.toggle("checked", $termsBox.checked);
    });
    document.getElementById("signup-form").onsubmit = async function (e) {
      e.preventDefault();
      const name = document.getElementById("su-name").value.trim();
      const email = document.getElementById("su-email").value.trim().toLowerCase();
      const pass = document.getElementById("su-pass").value;
      const $err = document.getElementById("su-error");

      if (!name) return ($err.textContent = "Please tell us your first name.");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        return ($err.textContent = "That email doesn't look right.");
      if (pass.length < 6)
        return ($err.textContent = "Password needs at least 6 characters.");
      if (!$termsBox.checked)
        return ($err.textContent = "Please confirm you’re 18+ and agree to the Terms and Privacy Policy.");
      if (!nestfulDB)
        return ($err.textContent = "Sign-up isn’t connected yet — check backend/supabase-config.js.");

      try {
        await nestfulDB.signUp(name, email, pass);
      } catch (err) {
        return ($err.textContent = err.message || "Something went wrong creating your account.");
      }
      try {
        await refreshAuthState();
      } catch (err) {
        return viewConnectionError(err);
      }
      if (!authUser) {
        return ($err.textContent =
          "Account created — check your email to confirm it, then sign in. " +
          "(Tip: disable “Confirm email” in Supabase Auth settings for one-step signup during BETA.)");
      }
      sendWelcomeEmail({ name: name, email: email });

      draft = freshDraft();
      viewOnbYou();
    };
  }

  function viewSignin() {
    render(
      brandRow() +
      '<div class="card">' +
        '<h2 class="view-title">Welcome back</h2>' +
        '<p class="view-sub">Your nest is where you left it.</p>' +
        '<form id="signin-form" novalidate>' +
          '<label class="field">Email' +
            '<input type="email" id="si-email" autocomplete="email" required></label>' +
          '<label class="field">Password' +
            '<input type="password" id="si-pass" autocomplete="current-password" required></label>' +
          '<div class="error-msg" id="si-error"></div>' +
          '<button class="btn btn-primary" type="submit">Sign in</button>' +
        "</form>" +
        '<div class="link-row"><a id="go-forgot">Forgot your password?</a></div>' +
        '<div class="link-row">New here? <a id="go-signup">Create an account</a></div>' +
      "</div>"
    );

    document.getElementById("go-signup").onclick = viewSignup;
    document.getElementById("go-forgot").onclick = viewForgotPassword;
    document.getElementById("signin-form").onsubmit = async function (e) {
      e.preventDefault();
      const email = document.getElementById("si-email").value.trim().toLowerCase();
      const pass = document.getElementById("si-pass").value;
      const $err = document.getElementById("si-error");

      if (!nestfulDB)
        return ($err.textContent = "Sign-in isn’t connected yet — check backend/supabase-config.js.");
      try {
        await nestfulDB.signIn(email, pass);
      } catch (err) {
        const msg = /confirm/i.test(err.message || "")
          ? "This email hasn’t been confirmed yet — check your inbox, or turn off " +
            "“Confirm email” in Supabase Auth settings for one-step BETA signup."
          : "Incorrect email or password.";
        return ($err.textContent = msg);
      }
      try {
        await refreshAuthState();
      } catch (err) {
        return viewConnectionError(err);
      }
      const user = currentUser();
      if (user && user.profile) viewHome();
      else {
        draft = freshDraft();
        viewOnbYou();
      }
    };
  }

  /* ----- Forgot / reset password ----- */

  function viewForgotPassword() {
    render(
      brandRow() +
      '<div class="card">' +
        '<h2 class="view-title">Reset your password</h2>' +
        '<p class="view-sub">We’ll email you a secure link that works for 1 hour.</p>' +
        '<form id="forgot-form" novalidate>' +
          '<label class="field">Email' +
            '<input type="email" id="fp-email" autocomplete="email" required></label>' +
          '<div class="error-msg" id="fp-error"></div>' +
          '<button class="btn btn-primary" type="submit">Send reset link</button>' +
        "</form>" +
        '<div class="link-row"><a id="fp-back">← Back to sign in</a></div>' +
      "</div>"
    );

    document.getElementById("fp-back").onclick = viewSignin;
    document.getElementById("forgot-form").onsubmit = async function (e) {
      e.preventDefault();
      const email = document.getElementById("fp-email").value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        document.getElementById("fp-error").textContent = "That email doesn't look right.";
        return;
      }
      /* Always show the same confirmation, whether or not the account
         exists — avoids leaking which emails are registered. Supabase
         itself only emails real accounts either way. */
      if (nestfulDB) {
        try { await nestfulDB.sendPasswordReset(email); } catch (err) { /* stay generic */ }
      }

      render(
        brandRow() +
        '<div class="card">' +
          '<h2 class="view-title">Check your email</h2>' +
          '<p class="view-sub">If an account exists for <strong>' + esc(email) +
            "</strong>, we've sent a link to reset the password. It works for 1 hour.</p>" +
          '<button class="btn btn-secondary" id="fp-done">← Back to sign in</button>' +
        "</div>"
      );
      document.getElementById("fp-done").onclick = viewSignin;
    };
  }

  /* Reached via the link in Supabase's reset email, which lands back here
     with a recovery session already active in the Supabase client (see
     isRecoveryLink / the auth listener near boot() at the bottom). */
  function viewResetPassword() {
    render(
      brandRow() +
      '<div class="card">' +
        '<h2 class="view-title">Choose a new password</h2>' +
        '<p class="view-sub">Enter a new password for your account.</p>' +
        '<form id="reset-form" novalidate>' +
          '<label class="field">New password (6+ characters)' +
            '<input type="password" id="rp-pass" autocomplete="new-password" required></label>' +
          '<label class="field">Confirm new password' +
            '<input type="password" id="rp-pass2" autocomplete="new-password" required></label>' +
          '<div class="error-msg" id="rp-error"></div>' +
          '<button class="btn btn-primary" type="submit">Update password</button>' +
        "</form>" +
      "</div>"
    );

    document.getElementById("reset-form").onsubmit = async function (e) {
      e.preventDefault();
      const p1 = document.getElementById("rp-pass").value;
      const p2 = document.getElementById("rp-pass2").value;
      const $err = document.getElementById("rp-error");
      if (p1.length < 6) return ($err.textContent = "Password needs at least 6 characters.");
      if (p1 !== p2) return ($err.textContent = "Passwords don't match.");

      try {
        await nestfulDB.updatePassword(p1);
      } catch (err) {
        return ($err.textContent = err.message || "Couldn't update your password — the link may have expired.");
      }
      history.replaceState(null, "", location.pathname + location.search);
      try {
        await refreshAuthState();
      } catch (err) {
        return viewConnectionError(err);
      }
      const user = currentUser();
      if (user) sendPasswordChangedEmail(user);

      render(
        brandRow() +
        '<div class="card">' +
          '<h2 class="view-title">Password updated ✓</h2>' +
          '<p class="view-sub">You’re signed in with your new password.</p>' +
          '<button class="btn btn-primary" id="rp-continue">Continue</button>' +
        "</div>"
      );
      document.getElementById("rp-continue").onclick = function () {
        if (user && user.profile) viewHome();
        else { draft = freshDraft(); viewOnbYou(); }
      };
    };
  }

  /* ----- Onboarding step 1: you, and who you're here for ----- */

  function viewOnbYou() {
    const user = currentUser();
    render(
      brandRow() +
      dots(1, 4) +
      '<h2 class="view-title">' + (editMode ? "About you" : "First — a little about you") + "</h2>" +
      '<p class="view-sub">' + esc(BRAND.name) + " is for everyone with room in their nest.</p>" +
      '<div class="card">' +
        '<div class="group-label">I am a…</div>' +
        '<div class="chip-row" id="gender-row">' +
          GENDERS.map(function (g) {
            return (
              '<button type="button" class="count-chip' +
              (draft.gender === g[0] ? " selected" : "") +
              '" data-g="' + g[0] + '">' + g[1] + "</button>"
            );
          }).join("") +
        "</div>" +
        '<label class="field">In my own words <em style="font-weight:400">(optional — shown on your profile)</em>' +
          '<input type="text" id="you-detail" maxlength="30" value="' + esc(draft.genderDetail) +
          '" placeholder="e.g. trans woman, genderfluid, agender"></label>' +
        '<div class="group-label">My pronouns <em>(optional)</em></div>' +
        '<div class="chip-row" id="pronoun-row">' +
          PRONOUN_SETS.map(function (pr) {
            return (
              '<button type="button" class="count-chip' +
              (draft.pronouns === pr ? " selected" : "") +
              '" data-pr="' + pr + '">' + pr + "</button>"
            );
          }).join("") +
        "</div>" +
        '<label class="field">Or in your own words' +
          '<input type="text" id="you-pronouns" maxlength="20" value="' +
          esc(PRONOUN_SETS.includes(draft.pronouns) ? "" : draft.pronouns) +
          '" placeholder="e.g. ze/zir"></label>' +
        '<div class="group-label">Show me…</div>' +
        '<div class="group-hint">Check every genuine yes — as many as apply.</div>' +
        '<div class="check-group" id="grp-seeking">' +
          checkPills("seeking", GENDERS.map(function (g) {
            return { key: g[0], label: SEEK_LABELS[g[0]] };
          }), draft.seeking) +
        "</div>" +
        '<button type="button" class="count-chip" id="seek-everyone" style="margin-bottom:14px">Everyone</button>' +
        '<div class="error-msg" id="you-error"></div>' +
        '<button class="btn btn-primary" id="you-next">Continue</button>' +
      "</div>" +
      (editMode
        ? '<div class="card" style="margin-top:14px">' +
            '<h2 class="view-title" style="font-size:19px">Change password</h2>' +
            '<form id="pw-form" novalidate>' +
              '<label class="field">Current password' +
                '<input type="password" id="pw-current" autocomplete="current-password"></label>' +
              '<label class="field">New password (6+ characters)' +
                '<input type="password" id="pw-new" autocomplete="new-password"></label>' +
              '<div class="error-msg" id="pw-error"></div>' +
              '<button class="btn btn-secondary" type="submit">Update password</button>' +
            "</form>" +
          "</div>" +
          '<button class="btn btn-ghost" id="edit-cancel">Cancel editing</button>' +
          (isPlus(user)
            ? '<button class="btn btn-ghost" id="plus-cancel">Cancel Nestful+ (demo)</button>'
            : "") +
          '<div class="danger-zone">' +
            '<button class="btn btn-danger" id="go-delete">Delete my account permanently</button>' +
          "</div>"
        : "")
    );

    wirePills($app);

    const $pwForm = document.getElementById("pw-form");
    if ($pwForm)
      $pwForm.onsubmit = async function (e) {
        e.preventDefault();
        const cur = document.getElementById("pw-current").value;
        const next = document.getElementById("pw-new").value;
        const $err = document.getElementById("pw-error");
        $err.textContent = "";
        const acct = currentUser();
        if (next.length < 6) return ($err.textContent = "New password needs at least 6 characters.");

        try {
          await nestfulDB.signIn(acct.email, cur); // re-auth doubles as "current password" check
        } catch (err) {
          return ($err.textContent = "Current password is incorrect.");
        }
        try {
          await nestfulDB.updatePassword(next);
        } catch (err) {
          return ($err.textContent = err.message || "Couldn't update your password.");
        }
        sendPasswordChangedEmail(acct);
        toast("Password updated ✓");
        $pwForm.reset();
      };

    $app.querySelectorAll("#gender-row .count-chip").forEach(function (chip) {
      chip.onclick = function () {
        draft.gender = chip.getAttribute("data-g");
        $app.querySelectorAll("#gender-row .count-chip").forEach(function (c) {
          c.classList.toggle("selected", c === chip);
        });
      };
    });

    const $customPr = document.getElementById("you-pronouns");
    $app.querySelectorAll("#pronoun-row .count-chip").forEach(function (chip) {
      chip.onclick = function () {
        const pr = chip.getAttribute("data-pr");
        const already = draft.pronouns === pr;
        draft.pronouns = already ? "" : pr;
        $customPr.value = "";
        $app.querySelectorAll("#pronoun-row .count-chip").forEach(function (c) {
          c.classList.toggle("selected", !already && c === chip);
        });
      };
    });
    $customPr.addEventListener("input", function () {
      if ($customPr.value.trim()) {
        draft.pronouns = "";
        $app.querySelectorAll("#pronoun-row .count-chip").forEach(function (c) {
          c.classList.remove("selected");
        });
      }
    });

    document.getElementById("seek-everyone").onclick = function () {
      $app.querySelectorAll('#grp-seeking input[name="seeking"]').forEach(function (input) {
        input.checked = true;
        input.closest(".check-pill").classList.add("checked");
      });
    };

    document.getElementById("you-next").onclick = function () {
      const $err = document.getElementById("you-error");
      draft.genderDetail = document.getElementById("you-detail").value.trim();
      const custom = $customPr.value.trim();
      if (custom) draft.pronouns = custom;
      draft.seeking = pillValues($app, "seeking");

      if (!draft.gender)
        return ($err.textContent = "Pick the option that fits you best.");
      if (!draft.seeking.length)
        return ($err.textContent = "Check at least one — who should we show you?");
      viewOnbNest();
    };

    const $cancel = document.getElementById("edit-cancel");
    if ($cancel)
      $cancel.onclick = function () {
        editMode = false;
        viewHome();
      };
    const $delete = document.getElementById("go-delete");
    if ($delete) $delete.onclick = viewDeleteAccount;
    const $plusCancel = document.getElementById("plus-cancel");
    if ($plusCancel)
      $plusCancel.onclick = async function () {
        await updateUser({ premium: false });
        toast("Nestful+ cancelled — you’re on the free plan");
        viewOnbYou();
      };
  }

  /* ----- Onboarding step 2: who's in your nest? ----- */

  function viewOnbNest() {
    const full = BRAND.badges.full;
    const ready = BRAND.badges.ready;
    render(
      brandRow() +
      dots(2, 4) +
      '<h2 class="view-title">' + (editMode ? "Update your nest" : "Who’s in your nest?") + "</h2>" +
      '<p class="view-sub">There’s no wrong answer here — everyone on ' +
        esc(BRAND.name) + " chose this openness on purpose.</p>" +
      '<div class="choice-stack">' +
        '<button class="choice-card' + (editMode && draft.kind === "full" ? " selected" : "") + '" id="pick-full" type="button">' +
          '<span class="choice-icon">' + full.icon + "</span>" +
          "<span><span class=\"choice-title\">" + esc(full.label) + "</span>" +
          '<div class="choice-sub">I have kids, or someone I care for — my nest has company.</div></span>' +
        "</button>" +
        '<button class="choice-card' + (editMode && draft.kind === "ready" ? " selected" : "") + '" id="pick-ready" type="button">' +
          '<span class="choice-icon">' + ready.icon + "</span>" +
          "<span><span class=\"choice-title\">" + esc(ready.label) + "</span>" +
          '<div class="choice-sub">It’s just me for now — and my nest has room.</div></span>' +
        "</button>" +
      "</div>" +
      '<button class="btn btn-ghost" id="nest-back">← Back</button>'
    );

    document.getElementById("pick-full").onclick = function () {
      draft.kind = "full";
      viewOnbDetails();
    };
    document.getElementById("pick-ready").onclick = function () {
      draft.kind = "ready";
      draft.contents = [];
      draft.counts = {};
      draft.rhythm = "";
      viewOnbDetails();
    };
    document.getElementById("nest-back").onclick = viewOnbYou;
  }

  /* ----- Permanent account deletion (type-to-confirm) ----- */

  function viewDeleteAccount() {
    const user = currentUser();
    if (!user) return viewLanding();

    render(
      brandRow() +
      '<div class="card">' +
        '<h2 class="view-title">Delete your account?</h2>' +
        '<p class="view-sub">This is permanent — there’s no undo and no recovery.</p>' +
        '<div class="delete-box">' +
          "<strong>Deleting your account removes, permanently:</strong>" +
          "<ul>" +
            "<li>Your profile, photo, and Nest Profile answers</li>" +
            "<li>Every like and note you’ve sent</li>" +
          "</ul>" +
        "</div>" +
        '<label class="field">Type <strong>DELETE</strong> to confirm' +
          '<input type="text" id="del-confirm" autocomplete="off" placeholder="DELETE"></label>' +
        '<button class="btn btn-danger" id="del-do" disabled>Permanently delete my account</button>' +
        '<button class="btn btn-secondary" id="del-keep">Keep my account</button>' +
      "</div>"
    );

    const $input = document.getElementById("del-confirm");
    const $do = document.getElementById("del-do");
    $input.addEventListener("input", function () {
      $do.disabled = $input.value.trim().toUpperCase() !== "DELETE";
    });

    document.getElementById("del-keep").onclick = function () {
      viewOnbYou();
    };
    $do.onclick = async function () {
      if ($input.value.trim().toUpperCase() !== "DELETE") return;
      const departingUser = currentUser(); // grab before the session is gone
      await nestfulDB.deleteMyAccount();
      authUser = null;
      authProfile = null;
      editMode = false;
      draft = null;
      stackIndex = 0;
      if (departingUser) sendAccountDeletedEmail(departingUser);
      toast("Your account has been deleted");
      viewLanding();
    };
  }

  /* ----- Onboarding step 2: details + openness ----- */

  function viewOnbDetails() {
    const isFull = draft.kind === "full";
    let inner = "";

    function countRow(key, word) {
      const chips = ["1", "2", "3+"].map(function (v) {
        return (
          '<button type="button" class="count-chip' +
          (draft.counts[key] === v ? " selected" : "") +
          '" data-key="' + key + '" data-val="' + v + '">' + v + "</button>"
        );
      }).join("");
      return (
        '<div class="count-row" id="count-' + key + '" style="display:' +
        (draft.contents.includes(key) ? "flex" : "none") + '">' +
        '<span class="count-label">How many ' + word + "? <em>(optional)</em></span>" +
        chips + "</div>"
      );
    }

    if (isFull) {
      inner +=
        '<div class="group-label">Who’s in your nest?</div>' +
        '<div class="group-hint">No names or details needed — just the shape of things.</div>' +
        '<div class="check-group" id="grp-contents">' +
          checkPills("contents", NEST_ITEMS, draft.contents) +
        "</div>" +
        countRow("young", "young kids") +
        countRow("teens", "teens") +
        '<label class="field">Your time rhythm' +
          '<select id="ob-rhythm">' +
            '<option value="">Choose one…</option>' +
            RHYTHMS.map(function (r) {
              return '<option value="' + r[0] + '"' +
                (draft.rhythm === r[0] ? " selected" : "") + ">" + r[1] + "</option>";
            }).join("") +
          "</select></label>";
    }

    /* Full Nest members get an exclusive extra openness option: Nest-Ready
       partners. Nest-Ready members never see it — a Nest-Ready ↔ Nest-Ready
       pairing would defeat the purpose of the app. */
    const openItems = isFull
      ? NEST_ITEMS.concat([{ key: "ready", label: "Nest-Ready — no kids or dependents yet", icon: "🌿" }])
      : NEST_ITEMS;

    inner +=
      '<div class="group-label">And in a partner — what are you open to?</div>' +
      '<div class="group-hint">Check everything that’s a genuine yes. This powers your matches.</div>' +
      '<div class="check-group" id="grp-open">' +
        checkPills("openTo", openItems, draft.openTo) +
      "</div>" +
      '<div class="count-row" style="display:flex">' +
        '<span class="count-label">How many kids are you open to? <em>(optional — any if blank)</em></span>' +
        '<span class="chip-group">' +
          ["1", "2", "3+"].map(function (v) {
            return (
              '<button type="button" class="count-chip' +
              (draft.openToCounts.includes(v) ? " selected" : "") +
              '" data-oc="' + v + '">' + v + "</button>"
            );
          }).join("") +
        "</span>" +
      "</div>";

    if (!isFull) {
      inner +=
        '<label class="field">What role do you picture for yourself?' +
          '<select id="ob-role">' +
            '<option value="">Choose one…</option>' +
            ROLES.map(function (r) {
              return '<option value="' + r[0] + '"' +
                (draft.role === r[0] ? " selected" : "") + ">" + r[1] + "</option>";
            }).join("") +
          "</select></label>";
    }

    render(
      brandRow() +
      dots(3, 4) +
      '<h2 class="view-title">' + (isFull ? "Tell us about your nest" : "How open is your nest?") + "</h2>" +
      '<p class="view-sub">This is the pre-screen that makes date three drama-free.</p>' +
      '<div class="card">' + inner +
        '<div class="error-msg" id="ob-error"></div>' +
        '<button class="btn btn-primary" id="ob-next">Continue</button>' +
        '<button class="btn btn-ghost" id="ob-back">← Back</button>' +
      "</div>"
    );

    wirePills($app);

    if (isFull) {
      /* Show a count row only while its category is checked */
      $app.querySelectorAll('#grp-contents input[name="contents"]').forEach(function (input) {
        input.addEventListener("change", function () {
          const row = document.getElementById("count-" + input.value);
          if (!row) return;
          row.style.display = input.checked ? "flex" : "none";
          if (!input.checked) {
            delete draft.counts[input.value];
            row.querySelectorAll(".count-chip").forEach(function (c) {
              c.classList.remove("selected");
            });
          }
        });
      });
      $app.querySelectorAll(".count-chip[data-key]").forEach(function (chip) {
        chip.addEventListener("click", function () {
          const key = chip.getAttribute("data-key");
          const val = chip.getAttribute("data-val");
          const already = draft.counts[key] === val;
          if (already) delete draft.counts[key];
          else draft.counts[key] = val;
          chip.parentElement.querySelectorAll(".count-chip").forEach(function (c) {
            c.classList.toggle("selected", !already && c === chip);
          });
        });
      });
    }

    /* Kid-count comfort preference — multi-select, both member types */
    $app.querySelectorAll(".count-chip[data-oc]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        const v = chip.getAttribute("data-oc");
        const i = draft.openToCounts.indexOf(v);
        if (i === -1) draft.openToCounts.push(v);
        else draft.openToCounts.splice(i, 1);
        chip.classList.toggle("selected", i === -1);
      });
    });

    document.getElementById("ob-back").onclick = viewOnbNest;
    document.getElementById("ob-next").onclick = function () {
      const $err = document.getElementById("ob-error");
      draft.openTo = pillValues($app, "openTo");

      if (isFull) {
        draft.contents = pillValues($app, "contents");
        draft.rhythm = document.getElementById("ob-rhythm").value;
        Object.keys(draft.counts).forEach(function (k) {
          if (!draft.contents.includes(k)) delete draft.counts[k];
        });
        if (!draft.contents.length)
          return ($err.textContent = "Pick at least one — who’s in your nest?");
        if (!draft.rhythm)
          return ($err.textContent = "Choose your time rhythm.");
        if (!draft.openTo.length)
          return ($err.textContent = "Check at least one openness — including Nest-Ready if that’s a yes.");
      } else {
        draft.role = document.getElementById("ob-role").value;
        if (!draft.openTo.length)
          return ($err.textContent = "Check at least one — openness is the whole idea!");
        if (!draft.role)
          return ($err.textContent = "Choose the role you picture.");
      }
      viewOnbAbout();
    };
  }

  /* ----- Onboarding step 3: about you + photo (with privacy policy) ----- */

  function photoBlockHTML(userName) {
    const hasPhoto = !!draft.photo;
    return (
      '<div class="photo-block">' +
        '<div class="photo-preview-wrap" id="photo-preview">' +
          avatarHTML(userName || "?", draft.photo, userHue(userName || "?"), "avatar-lg") +
        "</div>" +
        '<div class="photo-actions">' +
          '<button class="btn btn-secondary" id="photo-add" type="button">' +
            (hasPhoto ? "Change photo" : "📷 Add a photo") + "</button>" +
          (hasPhoto
            ? '<button class="btn btn-ghost" id="photo-remove" type="button">Remove</button>'
            : "") +
        "</div>" +
        '<input type="file" id="photo-input" accept="image/*" style="display:none">' +
      "</div>" +
      '<div class="privacy-box">' +
        "<strong>📸 Photo guidelines — our child-safety policy</strong>" +
        "<ul>" +
          "<li><strong>Just you.</strong> No children may appear in any photo — not yours, not anyone’s. This protects every family here.</li>" +
          "<li>No school logos, team uniforms, or anything that reveals where a child spends their day.</li>" +
          "<li>Tell your family story in words — never in pictures. That’s what your bio is for.</li>" +
          "<li>Photos that break this policy are removed, and repeat violations end the account.</li>" +
        "</ul>" +
      "</div>" +
      (hasPhoto && draft.photo !== draft._origPhoto
        ? '<label class="check-pill" id="photo-confirm-pill">' +
            '<input type="checkbox" id="photo-confirm"> ' +
            "I confirm this photo is just me — no children, no identifying details." +
          "</label>"
        : "")
    );
  }

  function wirePhotoBlock(userName, rerender) {
    const $input = document.getElementById("photo-input");
    document.getElementById("photo-add").onclick = function () { $input.click(); };
    const $remove = document.getElementById("photo-remove");
    if ($remove)
      $remove.onclick = function () {
        draft.photo = null;
        rerender();
      };
    const $confirm = document.getElementById("photo-confirm");
    if ($confirm)
      $confirm.addEventListener("change", function () {
        document.getElementById("photo-confirm-pill")
          .classList.toggle("checked", $confirm.checked);
      });

    $input.onchange = function () {
      const file = $input.files && $input.files[0];
      if (!file) return;
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = function () {
        /* Downscale so localStorage stays small (demo constraint) */
        const max = 320;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        draft.photo = canvas.toDataURL("image/jpeg", 0.82);
        URL.revokeObjectURL(url);
        rerender();
      };
      img.src = url;
    };
  }

  function viewOnbAbout() {
    const user = currentUser();
    render(
      brandRow() +
      dots(4, 4) +
      '<h2 class="view-title">Almost there</h2>' +
      '<p class="view-sub">The fun part — who they’ll actually be talking to.</p>' +
      '<div class="card">' +
        photoBlockHTML(user ? user.name : "?") +
        '<label class="field">City' +
          '<input type="text" id="ob-city" value="' + esc(draft.city) + '" placeholder="e.g. Austin, TX"></label>' +
        '<label class="field">Your bio' +
          '<textarea id="ob-bio" rows="4" placeholder="Weekend pancakes? Soccer sidelines? Caring for your mom? Say it proudly — that’s what this place is for.">' +
            esc(draft.bio) + "</textarea></label>" +
        '<div class="error-msg" id="ab-error"></div>' +
        '<button class="btn btn-primary" id="ab-finish">' +
          (editMode ? "Save changes" : "Finish my profile") + "</button>" +
        '<button class="btn btn-ghost" id="ab-back">← Back</button>' +
      "</div>"
    );

    wirePhotoBlock(user ? user.name : "?", function () {
      /* keep typed values across the photo re-render */
      draft.city = document.getElementById("ob-city").value;
      draft.bio = document.getElementById("ob-bio").value;
      viewOnbAbout();
    });

    document.getElementById("ab-back").onclick = viewOnbDetails;
    document.getElementById("ab-finish").onclick = async function () {
      draft.city = document.getElementById("ob-city").value.trim();
      draft.bio = document.getElementById("ob-bio").value.trim();
      const $err = document.getElementById("ab-error");
      if (!draft.city) return ($err.textContent = "Where are you nesting?");
      if (!draft.bio) return ($err.textContent = "Give them at least a sentence!");
      const $confirm = document.getElementById("photo-confirm");
      const photoChanged = draft.photo && draft.photo !== draft._origPhoto;
      if (photoChanged && (!$confirm || !$confirm.checked))
        return ($err.textContent = "Please confirm your photo follows the child-safety policy.");

      await updateUser({
        profile: {
          gender: draft.gender,
          genderDetail: draft.genderDetail,
          pronouns: draft.pronouns,
          seeking: draft.seeking,
          contents: draft.contents,
          counts: draft.counts,
          rhythm: draft.rhythm,
          openTo: draft.openTo,
          openToCounts: draft.openToCounts,
          role: draft.role,
          city: draft.city,
          bio: draft.bio,
          photo: draft.photo,
        },
      });
      if (editMode) {
        editMode = false;
        toast("Profile updated ✓");
        viewHome();
      } else {
        viewReveal();
      }
    };
  }

  /* ----- Badge reveal ----- */

  function viewReveal() {
    const user = currentUser();
    const kind = badgeKind(user.profile);
    const b = BRAND.badges[kind];
    render(
      '<div class="reveal">' +
        '<span class="badge-big">' + b.icon + "</span>" +
        "<h2>You’re " + (kind === "full" ? "a " : "") + esc(b.label) + "!</h2>" +
        '<p class="badge-blurb">“' + esc(b.blurb) + "”</p>" +
        '<p class="view-sub">Your matches are pre-screened for mutual openness.<br>' +
          "No reveals. No date-three surprises. Just people who already said yes.</p>" +
        '<button class="btn btn-primary" id="rv-go">Show me my matches</button>' +
      "</div>"
    );
    document.getElementById("rv-go").onclick = viewHome;
  }

  /* ----- Shared match helpers ----- */

  /* Mutual gender preference: I'm shown people I'm seeking who are also
     seeking people like me. Legacy profiles without the fields see everyone. */
  function genderCompatible(me, other) {
    if (!me.gender || !me.seeking || !me.seeking.length) return true;
    if (!other.gender || !other.seeking || !other.seeking.length) return true;
    return me.seeking.includes(other.gender) && other.seeking.includes(me.gender);
  }

  /* ----- Real matches (real member profiles, from Supabase) -----
     SAMPLES stays the curated/demo deck (never shown on production —
     see the safety canary above). Real signups are layered in on top
     so both staging (SAMPLES + real) and production (real only, since
     SAMPLES is forced empty there) share the exact same code path. */

  let realMatches = [];
  let realMatchesLoadedFor = null; // authUser.id this cache belongs to

  function isOnboardedRow(row) {
    return !!(row.city && row.bio);
  }

  // Real profiles don't collect age yet (see ageSuffix above) or a photo
  // upload's own hue — hue is derived from the name, same as a member's
  // own avatar (see userHue) so it stays stable without a stored column.
  function dbRowToMatch(row) {
    return {
      _id: row.id,
      name: row.name,
      age: null,
      city: row.city || "",
      hue: userHue(row.name || "?"),
      gender: row.gender || "",
      genderDetail: row.gender_detail || "",
      pronouns: row.pronouns || "",
      seeking: row.seeking || [],
      contents: row.contents || [],
      counts: row.counts || {},
      rhythm: row.rhythm || "",
      openTo: row.open_to || [],
      openToCounts: row.open_to_counts || [],
      role: row.role || "",
      photo: row.photo_url || null,
      bio: row.bio || "",
    };
  }

  // Fire-and-forget background load, cached per signed-in user so it only
  // runs once per session. viewHome() calls this every render, but the
  // realMatchesLoadedFor guard means only the first call after sign-in
  // actually hits the network — once the fetch resolves it re-renders.
  function ensureRealMatchesLoaded(userId) {
    if (!nestfulDB || realMatchesLoadedFor === userId) return;
    realMatchesLoadedFor = userId;
    nestfulDB.browseProfiles()
      .then(function (rows) {
        realMatches = rows.filter(isOnboardedRow).map(dbRowToMatch);
        viewHome();
      })
      .catch(function (err) {
        console.error("Couldn't load real matches:", err);
        realMatchesLoadedFor = null; // allow a retry on the next render
      });
  }

  function visibleMatches(user) {
    const p = user.profile;
    const pool = SAMPLES.concat(realMatches.filter(function (r) { return r._id !== user.id; }));
    return pool.filter(function (s) {
      return mutuallyOpen(p, s) && genderCompatible(p, s) &&
        countsAcceptable(p, s) && countsAcceptable(s, p);
    });
  }

  /* ----- Notifications: real likes/notes received (see supabase-client.js
     whoLikedMeSinceLastSeen/markNotificationsSeen) — a bell in the home
     header shakes and hatches from 🪺 into 💌 the moment there's something
     unread, so it's the first thing a member sees on login. ----- */

  let notifState = { likes: [], unread: [], lastSeen: null };
  let notifLoadedFor = null; // authUser.id this cache belongs to
  let notifAnimatedCount = null; // unread count already played the hatch animation for
  let notifPanelOpen = false;

  function ensureNotificationsLoaded(userId) {
    if (!nestfulDB || notifLoadedFor === userId) return;
    notifLoadedFor = userId;
    nestfulDB.whoLikedMeSinceLastSeen()
      .then(function (result) {
        notifState = result;
        // So a click from the notification panel can always open the
        // sender's profile, even if mutual pre-screening/filters would
        // otherwise have kept them out of realMatches.
        result.likes.forEach(function (l) {
          if (l.profiles && !realMatches.some(function (r) { return r._id === l.liker_id; })) {
            realMatches.push(dbRowToMatch(Object.assign({ id: l.liker_id }, l.profiles)));
          }
        });
        viewHome();
      })
      .catch(function (err) {
        console.error("Couldn't load notifications:", err && (err.message || err.code || err));
        notifLoadedFor = null; // allow a retry on the next render
      });
  }

  function toggleNotifPanel() {
    notifPanelOpen = !notifPanelOpen;
    if (notifPanelOpen && notifState.unread.length) {
      nestfulDB.markNotificationsSeen().catch(function (err) {
        console.error("Couldn't mark notifications seen:", err);
      });
      notifState = { likes: notifState.likes, unread: [], lastSeen: new Date().toISOString() };
    }
    viewHome();
  }

  function notifBellHTML() {
    const count = notifState.unread.length;
    const isNew = count > 0 && notifAnimatedCount !== count;
    const icon = count > 0 ? "💌" : "🪺";
    const html =
      '<button type="button" class="notif-bell' + (count > 0 ? " has-unread" : "") +
        '" id="notif-bell" title="Likes & notes">' +
        '<span class="notif-egg' + (isNew ? " hatching" : "") + '">' + icon + "</span>" +
        (count > 0 ? '<span class="notif-badge">' + (count > 9 ? "9+" : count) + "</span>" : "") +
      "</button>";
    notifAnimatedCount = count;
    return html;
  }

  function notifPanelHTML() {
    if (!notifPanelOpen) return "";
    if (!notifState.likes.length) {
      return (
        '<div class="notif-panel">' +
          '<p class="detail-bio">No likes or notes yet — once someone likes your nest, ' +
          "they’ll show up here.</p>" +
        "</div>"
      );
    }
    return (
      '<div class="notif-panel">' +
        notifState.likes.map(function (l) {
          const sender = dbRowToMatch(Object.assign({ id: l.liker_id }, l.profiles || {}));
          const hasNote = l.note && l.note.trim();
          return (
            '<div class="notif-row" data-key="' + esc(matchKey(sender)) + '">' +
              avatarHTML(sender.name || "?", sender.photo, sender.hue, "avatar-sm") +
              '<span class="notif-row-text"><strong>' + esc(sender.name || "Someone") + "</strong>" +
                (hasNote
                  ? '<span class="notif-row-note">“' + esc(l.note) + '”</span>'
                  : '<span class="notif-row-note">Liked your nest</span>') +
              "</span>" +
            "</div>"
          );
        }).join("") +
      "</div>"
    );
  }

  function contentLabel(s, k) {
    const n = s.counts && s.counts[k];
    return (n ? n + " × " : "") + labelFor(k);
  }

  function tagsHTML(s) {
    const tags = s.contents.length
      ? s.contents.map(function (k) { return '<span class="tag">' + esc(contentLabel(s, k)) + "</span>"; })
      : s.openTo.map(function (k) { return '<span class="tag">Open to: ' + esc(labelFor(k)) + "</span>"; });
    return '<div class="match-tags">' + tags.join("") + "</div>";
  }

  /* ----- "Liked you" teaser (free: blurred; plus: revealed) ----- */

  function likedYou(visible) {
    return visible.slice(0, 3); // demo stand-in for a real likers list
  }

  function likedYouHTML(user, visible) {
    const likers = likedYou(visible);
    if (!likers.length) return "";

    /* Blurred teaser only exists once the upgrade funnel is live;
       in the freemium beta, everyone sees their likers. */
    if (FEATURES.upgradeEnabled && !isPlus(user)) {
      return (
        '<div class="teaser-card" id="teaser">' +
          '<span class="teaser-avatars">' +
            likers.map(function (s) {
              return avatarHTML(s.name, s.photo, s.hue, "avatar-sm blurred");
            }).join("") +
          "</span>" +
          '<span class="teaser-text"><strong>' + likers.length +
            " people liked you this week</strong><br>See exactly who with Nestful+</span>" +
          '<button class="teaser-cta">✨ Upgrade</button>' +
        "</div>"
      );
    }
    return (
      '<div class="teaser-card" id="likedyou-open" style="cursor:default">' +
        '<span class="teaser-text"><strong>Liked you this week</strong>' +
        '<span class="likedyou-row">' +
          likers.map(function (s) {
            return (
              '<span class="likedyou-chip" data-key="' + esc(matchKey(s)) + '">' +
                avatarHTML(s.name, s.photo, s.hue, "avatar-sm") + esc(s.name) +
              "</span>"
            );
          }).join("") +
        "</span></span>" +
      "</div>"
    );
  }

  /* ----- Nest filters & Rhythm Match (free in beta) ----- */

  let filtersOpen = false;

  const FILTER_CHIPS = [
    { key: "young", label: "🧸 Young kids" },
    { key: "teens", label: "🎧 Teens" },
    { key: "adult", label: "🤝 Caregiving" },
    { key: "ready", label: "🌿 Nest-Ready" },
  ];

  function activeFilterCount(f) {
    return f.keys.length + (f.rhythm ? 1 : 0) + (f.rhythmMatch ? 1 : 0) +
      (f.kidCounts || []).length;
  }

  function passesFilters(userProfile, s, f) {
    if (f.keys.length) {
      const ageKeys = f.keys.filter(function (k) { return k !== "ready"; });
      const matchReady = f.keys.includes("ready") && !s.contents.length;
      const matchAges = ageKeys.length > 0 &&
        s.contents.some(function (k) { return ageKeys.includes(k); });
      if (!matchReady && !matchAges) return false;
    }
    if ((f.kidCounts || []).length) {
      const counts = s.counts ? Object.values(s.counts) : [];
      if (!counts.some(function (c) { return f.kidCounts.includes(c); })) return false;
    }
    if (f.rhythm && s.rhythm !== f.rhythm) return false;
    if (f.rhythmMatch && (!userProfile.rhythm || s.rhythm !== userProfile.rhythm)) return false;
    return true;
  }

  function rhythmMatchTag(userProfile, s) {
    return userProfile.rhythm && s.rhythm && s.rhythm === userProfile.rhythm
      ? '<span class="tag tag-rhythm">📅 Rhythm match</span>'
      : "";
  }

  function filterBarHTML(userProfile, f) {
    const n = activeFilterCount(f);
    let bar =
      '<div class="filter-bar">' +
      '<button type="button" class="count-chip' + (n ? " selected" : "") +
        '" id="filter-toggle">⚲ Nest filters' + (n ? " (" + n + ")" : "") + "</button>";

    if (filtersOpen) {
      bar +=
        '<div class="filter-panel">' +
          '<div class="group-label">Their nest includes</div>' +
          '<div class="chip-row">' +
            FILTER_CHIPS.map(function (c) {
              return (
                '<button type="button" class="count-chip' +
                (f.keys.includes(c.key) ? " selected" : "") +
                '" data-fkey="' + c.key + '">' + c.label + "</button>"
              );
            }).join("") +
          "</div>" +
          '<div class="group-label">Number of kids</div>' +
          '<div class="chip-row">' +
            ["1", "2", "3+"].map(function (v) {
              return (
                '<button type="button" class="count-chip' +
                ((f.kidCounts || []).includes(v) ? " selected" : "") +
                '" data-fcount="' + v + '">' + v + "</button>"
              );
            }).join("") +
          "</div>" +
          '<label class="field">Time rhythm' +
            '<select id="f-rhythm">' +
              '<option value="">Any rhythm</option>' +
              RHYTHMS.map(function (r) {
                return '<option value="' + r[0] + '"' +
                  (f.rhythm === r[0] ? " selected" : "") + ">" + r[1] + "</option>";
              }).join("") +
            "</select></label>" +
          (userProfile.rhythm
            ? '<label class="check-pill' + (f.rhythmMatch ? " checked" : "") + '">' +
                '<input type="checkbox" id="f-rmatch"' + (f.rhythmMatch ? " checked" : "") + "> " +
                "📅 Rhythm Match — their kid-free time lines up with yours" +
              "</label>"
            : "") +
          '<button type="button" class="btn btn-ghost" id="f-clear" style="margin-top:8px">Clear all filters</button>' +
        "</div>";
    }
    return bar + "</div>";
  }

  function wireFilterBar(f) {
    document.getElementById("filter-toggle").onclick = function () {
      filtersOpen = !filtersOpen;
      viewHome();
    };
    if (!filtersOpen) return;

    $app.querySelectorAll("[data-fkey]").forEach(function (chip) {
      chip.onclick = function () {
        const k = chip.getAttribute("data-fkey");
        const i = f.keys.indexOf(k);
        if (i === -1) f.keys.push(k);
        else f.keys.splice(i, 1);
        store.setFilters(f);
        stackIndex = 0;
        viewHome();
      };
    });
    $app.querySelectorAll("[data-fcount]").forEach(function (chip) {
      chip.onclick = function () {
        const v = chip.getAttribute("data-fcount");
        f.kidCounts = f.kidCounts || [];
        const i = f.kidCounts.indexOf(v);
        if (i === -1) f.kidCounts.push(v);
        else f.kidCounts.splice(i, 1);
        store.setFilters(f);
        stackIndex = 0;
        viewHome();
      };
    });
    document.getElementById("f-rhythm").onchange = function () {
      f.rhythm = this.value;
      store.setFilters(f);
      stackIndex = 0;
      viewHome();
    };
    const $rm = document.getElementById("f-rmatch");
    if ($rm)
      $rm.onchange = function () {
        f.rhythmMatch = $rm.checked;
        store.setFilters(f);
        stackIndex = 0;
        viewHome();
      };
    document.getElementById("f-clear").onclick = function () {
      store.setFilters({ keys: [], rhythm: "", rhythmMatch: false, kidCounts: [] });
      stackIndex = 0;
      viewHome();
    };
  }

  /* ----- Home: pre-screened deck, list & stack modes ----- */

  let stackIndex = 0;

  function viewHome() {
    const user = currentUser();
    if (!user || !user.profile) return viewLanding();
    ensureRealMatchesLoaded(user.id);
    ensureNotificationsLoaded(user.id);
    const p = user.profile;
    const kind = badgeKind(p);
    const mode = store.getViewMode();

    const visible = visibleMatches(user);
    const hidden = SAMPLES.length - visible.length;
    const filters = store.getFilters();
    const filtered = visible.filter(function (s) { return passesFilters(p, s, filters); });
    const filtering = activeFilterCount(filters) > 0;

    let deck;
    if (!visible.length) {
      deck = SAMPLES.length
        ? '<div class="empty-deck">Your pre-screened deck is empty right now — new compatible members appear here as they join.</div>'
        : '<div class="empty-deck">You’re one of our first nests here! 🪺<br>Your pre-screened matches will start appearing as more members join — check back soon.</div>';
    } else if (!filtered.length) {
      deck = '<div class="empty-deck">No matches fit these filters — try loosening them a little.</div>';
    } else if (mode === "stack") {
      if (stackIndex >= filtered.length) {
        deck =
          '<div class="empty-deck">You’ve seen everyone in today’s stack! 🪺<br><br>' +
            '<button class="btn btn-secondary" id="stack-restart" style="width:auto;display:inline-block">Start over</button>' +
          "</div>";
      } else {
        const s = filtered[stackIndex];
        const sKind = s.contents.length ? "full" : "ready";
        deck =
          '<div class="stack-counter">' + (stackIndex + 1) + " of " + filtered.length + "</div>" +
          '<div class="stack-card" id="stack-card" data-key="' + esc(matchKey(s)) + '">' +
            avatarHTML(s.name, s.photo, s.hue, "avatar-lg") +
            '<span class="match-name">' + esc(s.name) + ageSuffix(s) + "</span>" +
            '<span class="match-city">' + esc(s.city) +
              (s.pronouns ? " · " + esc(s.pronouns) : "") + " · " + badgeChip(sKind) + "</span>" +
            '<p class="match-bio">' + esc(s.bio) + "</p>" +
            tagsHTML(s).replace("</div>", rhythmMatchTag(p, s) + "</div>") +
            '<div class="stack-actions">' +
              '<button class="btn btn-secondary" id="stack-pass">✕ Pass</button>' +
              '<button class="btn btn-accent" id="stack-note">✎ Note</button>' +
              '<button class="btn btn-primary" id="stack-like">❤ Like</button>' +
            "</div>" +
          "</div>" +
          '<div class="deck-hint">Click the card for the full profile</div>';
      }
    } else {
      deck =
        filtered.map(function (s, i) {
          const sKind = s.contents.length ? "full" : "ready";
          return (
            '<div class="match-card" data-key="' + esc(matchKey(s)) + '" style="animation-delay:' + i * 0.05 + 's">' +
              '<div class="match-top">' +
                avatarHTML(s.name, s.photo, s.hue, "avatar-sm") +
                '<span class="match-id"><span class="match-name">' + esc(s.name) + ageSuffix(s) + "</span>" +
                '<span class="match-city">' + esc(s.city) +
                  (s.pronouns ? " · " + esc(s.pronouns) : "") + "</span></span>" +
                badgeChip(sKind) +
              "</div>" +
              '<p class="match-bio">' + esc(s.bio) + "</p>" +
              tagsHTML(s).replace("</div>", rhythmMatchTag(p, s) + "</div>") +
              '<div class="match-actions">' +
                '<button class="btn btn-secondary" data-pass>Pass</button>' +
                '<button class="btn btn-primary" data-like>❤ Like</button>' +
              "</div>" +
            "</div>"
          );
        }).join("") +
        '<div class="deck-hint">Click any card for the full profile</div>';
    }

    render(
      '<div class="home-header">' +
        '<div class="who" id="edit-profile" title="Edit your profile">' +
          avatarHTML(user.name, p.photo, userHue(user.name), "avatar-sm") +
          '<span class="who-text"><strong>' + esc(user.name) + " · " + esc(p.city) + "</strong>" +
            "<span>" + badgeChip(kind) +
            (isPlus(user) ? ' <span class="badge badge-plus">✨ Nestful+</span>' : "") +
            "</span>" +
          "</span>" +
        "</div>" +
        '<span style="display:flex;gap:2px;align-items:center">' +
          notifBellHTML() +
          '<button class="btn btn-ghost" id="edit-profile-btn">✎ Edit</button>' +
          '<button class="btn btn-ghost" id="sign-out">Sign out</button>' +
        "</span>" +
      "</div>" +
      notifPanelHTML() +
      '<div class="view-toggle">' +
        '<button id="mode-list" class="' + (mode === "list" ? "active" : "") + '">☰ List</button>' +
        '<button id="mode-stack" class="' + (mode === "stack" ? "active" : "") + '">🃏 Stack</button>' +
      "</div>" +
      filterBarHTML(p, filters) +
      '<div class="screen-note">' +
        (SAMPLES.length
          ? "🔒 <strong>" + hidden + " profiles are hidden</strong> from your deck by mutual pre-screening — " +
            "and you’re hidden from theirs. Nobody gets the awkward reveal."
          : "🔒 Every match here is <strong>pre-screened for mutual openness</strong> — no reveals, no awkward surprises.") +
        (isPlus(user)
          ? ""
          : " · ❤ <strong>" + likesLeftToday(user) + " likes</strong> and ✎ <strong>" +
            notesLeft(user) + " notes</strong> left today") +
      "</div>" +
      (filtering && filtered.length
        ? '<div class="deck-hint">Showing ' + filtered.length + " of " + visible.length + " pre-screened matches</div>"
        : "") +
      likedYouHTML(user, visible) +
      deck
    );

    document.getElementById("sign-out").onclick = async function () {
      await nestfulDB.signOut();
      authUser = null;
      authProfile = null;
      stackIndex = 0;
      editMode = false;
      realMatches = [];
      realMatchesLoadedFor = null;
      notifState = { likes: [], unread: [], lastSeen: null };
      notifLoadedFor = null;
      notifAnimatedCount = null;
      notifPanelOpen = false;
      viewLanding();
    };
    function startEdit() {
      editMode = true;
      draft = draftFromProfile(p);
      viewOnbYou();
    }
    document.getElementById("edit-profile").onclick = startEdit;
    document.getElementById("edit-profile-btn").onclick = startEdit;
    document.getElementById("edit-profile").style.cursor = "pointer";
    document.getElementById("mode-list").onclick = function () {
      store.setViewMode("list");
      viewHome();
    };
    document.getElementById("mode-stack").onclick = function () {
      store.setViewMode("stack");
      stackIndex = 0;
      viewHome();
    };

    const $restart = document.getElementById("stack-restart");
    if ($restart)
      $restart.onclick = function () { stackIndex = 0; viewHome(); };

    const $teaser = document.getElementById("teaser");
    if ($teaser) $teaser.onclick = function () { viewUpgrade("liked"); };
    $app.querySelectorAll(".likedyou-chip").forEach(function (chip) {
      chip.onclick = function () { viewDetail(chip.getAttribute("data-key")); };
    });

    const $bell = document.getElementById("notif-bell");
    if ($bell) $bell.onclick = toggleNotifPanel;
    $app.querySelectorAll(".notif-row").forEach(function (row) {
      row.onclick = function () {
        notifPanelOpen = false;
        viewDetail(row.getAttribute("data-key"));
      };
    });

    wireFilterBar(filters);

    if (mode === "stack") wireStackCard(filtered);
    else wireListCards();
  }

  function wireListCards() {
    $app.querySelectorAll(".match-card").forEach(function (card) {
      const key = card.getAttribute("data-key");
      const match = findMatchByKey(key);
      card.addEventListener("click", function () { viewDetail(key); });

      const like = card.querySelector("[data-like]");
      const pass = card.querySelector("[data-pass]");
      function dismiss(dir) {
        card.style.transition = "opacity .3s, transform .3s";
        card.style.opacity = "0";
        card.style.transform = "translateX(" + (dir === "like" ? "" : "-") + "40px)";
        setTimeout(function () { card.remove(); }, 300);
      }
      like.onclick = function (e) {
        e.stopPropagation();
        if (!canLikeNow(currentUser())) return viewUpgrade("likes");
        recordLike(match, "");
        toast("Liked " + match.name + " ❤");
        dismiss("like");
      };
      pass.onclick = function (e) {
        e.stopPropagation();
        dismiss("pass");
      };
    });
  }

  function wireStackCard(visible) {
    const card = document.getElementById("stack-card");
    if (!card) return;
    const key = card.getAttribute("data-key");
    const match = findMatchByKey(key);

    card.addEventListener("click", function () { viewDetail(key); });

    function advance(cls) {
      card.classList.add(cls);
      setTimeout(function () {
        stackIndex += 1;
        viewHome();
      }, 260);
    }
    document.getElementById("stack-pass").onclick = function (e) {
      e.stopPropagation();
      advance("exit-left");
    };
    document.getElementById("stack-like").onclick = function (e) {
      e.stopPropagation();
      if (!canLikeNow(currentUser())) return viewUpgrade("likes");
      recordLike(match, "");
      toast("Liked " + match.name + " ❤");
      advance("exit-right");
    };
    document.getElementById("stack-note").onclick = function (e) {
      e.stopPropagation();
      viewDetail(key, true);
    };
  }

  /* ----- Beta cap screen: purposeful limits + Nestful+ waitlist ----- */

  function viewComingSoon(trigger) {
    const user = currentUser();
    const triggerMsgs = {
      likes: "You’ve used today’s " + FREE_LIKES_PER_DAY + " likes — they refresh tomorrow.",
      notes: "You’ve sent today’s " + FREE_NOTES_PER_DAY + " notes — more tomorrow.",
    };
    const onList = !!(user && user.plusWaitlist);

    render(
      '<button class="btn btn-ghost" id="cs-back" style="width:auto;padding-left:0">← Back to my nest</button>' +
      '<div class="upgrade-hero">' +
        '<span class="up-mark">🪺</span>' +
        "<h2>Purposeful, on purpose</h2>" +
        (triggerMsgs[trigger]
          ? '<div class="up-trigger">' + triggerMsgs[trigger] + "</div>"
          : "") +
      "</div>" +
      '<div class="card">' +
        '<p class="detail-bio" style="margin-bottom:14px">' + esc(BRAND.name) +
          " keeps daily limits for everyone right now — " + FREE_LIKES_PER_DAY +
          " likes and " + FREE_NOTES_PER_DAY + " notes a day — so every like " +
          "and every note here actually means something. No endless swiping, " +
          "no spam. Your limits refresh every morning.</p>" +
        '<p class="detail-bio" style="margin-bottom:16px"><strong>' + esc(BRAND.name) +
          "+ is coming:</strong> unlimited likes, Private Nest mode, a weekly Boost, " +
          "and more notes. Want in early?</p>" +
        (onList
          ? '<div class="screen-note" style="text-align:center">✓ You’re on the ' +
            esc(BRAND.name) + "+ waitlist — we’ll nudge you at launch.</div>"
          : '<button class="btn btn-primary" id="cs-waitlist">✨ Join the ' +
            esc(BRAND.name) + "+ waitlist</button>") +
      "</div>"
    );

    document.getElementById("cs-back").onclick = viewHome;
    const $wl = document.getElementById("cs-waitlist");
    if ($wl)
      $wl.onclick = async function () {
        await updateUser({ plusWaitlist: true, plusWaitlistAt: new Date().toISOString() });
        sendWaitlistEmail(currentUser());
        toast("You’re on the list ✨");
        viewComingSoon(trigger);
      };
  }

  /* ----- Nestful+ upgrade screen (mock — behind FEATURES.upgradeEnabled) ----- */

  function viewUpgrade(trigger) {
    if (!FEATURES.upgradeEnabled) return viewComingSoon(trigger);
    const triggerMsgs = {
      likes: "You’ve used today’s " + FREE_LIKES_PER_DAY + " free likes.",
      notes: "You’ve sent this week’s free notes.",
      liked: "People are already lining up at your nest.",
    };
    const plans = [
      { id: "1mo", term: "1 month", price: "$24.99/mo", note: "billed monthly", save: "" },
      { id: "3mo", term: "3 months", price: "$19.99/mo", note: "billed $59.97", save: "SAVE 20%" },
      { id: "6mo", term: "6 months", price: "$16.99/mo", note: "billed $101.94", save: "SAVE 32%" },
    ];
    let selected = "3mo";

    render(
      '<button class="btn btn-ghost" id="up-back" style="width:auto;padding-left:0">← Not now</button>' +
      '<div class="upgrade-hero">' +
        '<span class="up-mark">🪺✨</span>' +
        "<h2>" + esc(BRAND.name) + "+</h2>" +
        (triggerMsgs[trigger]
          ? '<div class="up-trigger">' + triggerMsgs[trigger] + "</div>"
          : "") +
      "</div>" +
      '<div class="card">' +
        '<ul class="perk-list">' +
          '<li><span class="perk-icon">❤</span><span><strong>Unlimited likes</strong> — no daily cap</span></li>' +
          '<li><span class="perk-icon">👀</span><span><strong>See who liked you</strong> — no more blurred nests</span></li>' +
          '<li><span class="perk-icon">✎</span><span><strong>' + PLUS_NOTES_PER_WEEK + " notes a week</strong> — still rare on purpose, so every note means something</span></li>" +
          '<li><span class="perk-icon">🔍</span><span><strong>Nest filters</strong> — filter by ages, time rhythm, and caregiving</span></li>' +
          '<li><span class="perk-icon">📅</span><span><strong>Rhythm Match</strong> — find people whose kid-free time lines up with yours</span></li>' +
          '<li><span class="perk-icon">🕊️</span><span><strong>Private Nest mode</strong> — only people you’ve liked can see you</span></li>' +
          '<li><span class="perk-icon">🚀</span><span><strong>Weekly Boost</strong> — front of the deck, once a week</span></li>' +
          '<li><span class="perk-icon">🍿</span><span><strong>Date-night perks</strong> — sitter &amp; venue deals from partners</span></li>' +
        "</ul>" +
        '<div class="plan-row">' +
          plans.map(function (pl) {
            return (
              '<button type="button" class="plan-card' + (pl.id === selected ? " selected" : "") +
              '" data-plan="' + pl.id + '">' +
                '<div class="plan-term">' + pl.term + "</div>" +
                '<div class="plan-price">' + pl.price + "</div>" +
                '<div class="plan-note">' + pl.note + "</div>" +
                (pl.save ? '<div class="plan-save">' + pl.save + "</div>" : "") +
              "</button>"
            );
          }).join("") +
        "</div>" +
        '<button class="btn btn-primary" id="up-go">✨ Start ' + esc(BRAND.name) + "+</button>" +
        '<div class="demo-disclaimer">Demo build — no payment is collected and nothing is charged.</div>' +
      "</div>"
    );

    document.getElementById("up-back").onclick = viewHome;
    $app.querySelectorAll(".plan-card").forEach(function (card) {
      card.onclick = function () {
        selected = card.getAttribute("data-plan");
        $app.querySelectorAll(".plan-card").forEach(function (c) {
          c.classList.toggle("selected", c === card);
        });
      };
    });
    document.getElementById("up-go").onclick = async function () {
      await updateUser({ premium: true, premiumPlan: selected, premiumSince: new Date().toISOString() });
      toast("Welcome to " + BRAND.name + "+ ✨");
      viewHome();
    };
  }

  /* ----- Full profile detail view ----- */

  function viewDetail(key, openNote) {
    const s = findMatchByKey(key);
    if (!s) return viewHome();
    const sKind = s.contents.length ? "full" : "ready";

    const nestFacts = s.contents.length
      ? s.contents.map(function (k) { return contentLabel(s, k); }).join(" · ") +
        (s.rhythm ? " — " + rhythmLabel(s.rhythm).toLowerCase() : "")
      : "Nest has room — open to: " + s.openTo.map(labelFor).join(" · ");

    render(
      '<button class="btn btn-ghost" id="dt-back" style="width:auto;padding-left:0">← Back to matches</button>' +
      '<div class="detail-head">' +
        avatarHTML(s.name, s.photo, s.hue, "avatar-lg") +
        '<div class="detail-name">' + esc(s.name) + ageSuffix(s) + "</div>" +
        '<div class="detail-city">' +
          (s.gender ? esc(genderLabel(s.gender)) : "") +
          (s.genderDetail ? " (" + esc(s.genderDetail) + ")" : "") +
          (s.pronouns ? " · " + esc(s.pronouns) : "") +
          (s.gender || s.pronouns ? " · " : "") + esc(s.city) +
        "</div>" +
        badgeChip(sKind) +
      "</div>" +
      '<div class="card" style="margin-top:18px">' +
        '<div class="detail-section"><h3>About ' + esc(s.name) + "</h3>" +
          '<p class="detail-bio">' + esc(s.bio) + "</p></div>" +
        '<div class="detail-section"><h3>Their nest</h3>' +
          '<p class="detail-bio">' + esc(nestFacts) + "</p></div>" +
        '<div class="detail-section"><h3>Openness</h3>' + tagsHTML(s) + "</div>" +
        '<div class="detail-actions">' +
          '<div class="match-actions">' +
            '<button class="btn btn-secondary" id="dt-pass">✕ Pass</button>' +
            '<button class="btn btn-primary" id="dt-like">❤ Like</button>' +
          "</div>" +
          '<button class="btn btn-accent" id="dt-note-toggle">✎ Like with a note</button>' +
          '<div id="note-slot"></div>' +
        "</div>" +
      "</div>"
    );

    document.getElementById("dt-back").onclick = viewHome;
    document.getElementById("dt-pass").onclick = function () {
      toast("Passed on " + s.name);
      viewHome();
    };
    document.getElementById("dt-like").onclick = function () {
      if (!canLikeNow(currentUser())) return viewUpgrade("likes");
      recordLike(s, "");
      toast("Liked " + s.name + " ❤");
      viewHome();
    };

    function showNotePanel() {
      const user = currentUser();
      const left = notesLeft(user);

      if (left === 0) {
        const showUpgrade = FEATURES.upgradeEnabled && !isPlus(user);
        document.getElementById("note-slot").innerHTML =
          '<div class="note-panel">' +
            "<label>You’ve sent all " + noteLimit(user) + " of " + noteWindowWord(user) + "’s notes</label>" +
            '<p style="font-size:13px;margin-bottom:10px">Notes stay rare on ' + esc(BRAND.name) +
              " so each one means something. Yours refresh tomorrow.</p>" +
            (showUpgrade
              ? '<button class="btn btn-primary" id="note-upgrade">✨ Get Nestful+</button>'
              : '<button class="btn btn-secondary" id="note-close">Got it</button>') +
          "</div>";
        const $up = document.getElementById("note-upgrade");
        if ($up) $up.onclick = function () { viewUpgrade("notes"); };
        const $close = document.getElementById("note-close");
        if ($close) $close.onclick = function () {
          document.getElementById("note-slot").innerHTML = "";
        };
        return;
      }

      document.getElementById("note-slot").innerHTML =
        '<div class="note-panel">' +
          "<label>Your note to " + esc(s.name) +
            ' <span style="font-weight:500;opacity:.75">(' + left + " of " +
            noteLimit(user) + " left " + noteWindowWord(user) + ")</span></label>" +
          '<textarea id="note-text" rows="3" maxlength="240" placeholder="e.g. Sunday pancakes are sacred in my nest too — what’s your go-to topping?"></textarea>' +
          '<button class="btn btn-primary" id="note-send">Send like + note ❤</button>' +
        "</div>";
      const $text = document.getElementById("note-text");
      $text.focus();
      document.getElementById("note-send").onclick = function () {
        const note = $text.value.trim();
        if (!note) {
          $text.placeholder = "Write a little something first!";
          return $text.focus();
        }
        if (notesLeft(currentUser()) === 0) return showNotePanel();
        if (!canLikeNow(currentUser())) return viewUpgrade("likes");
        recordLike(s, note);
        toast("Note sent to " + s.name + " ❤");
        viewHome();
      };
    }

    document.getElementById("dt-note-toggle").onclick = showNotePanel;
    if (openNote) showNotePanel();
  }

  /* ----- Founder dashboard: email log + admin notes (#admin) -----
     Member accounts now live in Supabase's protected auth.users table,
     which even this signed-in app can't query directly (by design —
     that's what "protected" means). A real member list here needs a
     small Supabase Edge Function using the service-role key, kept
     server-side only. See backend/SETUP.md, Phase 3 follow-up. */

  let adminTab = "users";

  function viewAdmin() {
    if (adminTab === "outbox") return viewAdminOutbox();

    render(
      brandRow() +
      '<h2 class="view-title">Founder dashboard</h2>' +
      '<p class="view-sub">Environment: <strong>' + ENV + "</strong></p>" +
      adminTabsHTML() +
      '<div class="card">' +
        '<p class="detail-bio">Real member accounts now live in Supabase — emails and ' +
          "login records sit in the protected <code>auth.users</code> table, which even " +
          "this app can't query directly (by design, for security). A member list here " +
          "needs a small <strong>Supabase Edge Function</strong> using the service-role " +
          "key (kept server-side, never shipped to the browser) — see " +
          "<code>backend/SETUP.md</code> for the plan.</p>" +
        '<p class="detail-bio" style="margin-top:10px">For now, see real signups directly ' +
          "in your Supabase project: <strong>Authentication → Users</strong>.</p>" +
      "</div>" +
      '<button class="btn btn-ghost" id="adm-back">← Back to the app</button>'
    );

    wireAdminChrome();
  }

  function adminTabsHTML() {
    return (
      '<div class="view-toggle" style="margin-bottom:14px">' +
        '<button id="adm-tab-users" class="' + (adminTab === "users" ? "active" : "") + '">👤 Users</button>' +
        '<button id="adm-tab-outbox" class="' + (adminTab === "outbox" ? "active" : "") + '">✉ Outbox</button>' +
      "</div>"
    );
  }

  function wireAdminChrome() {
    document.getElementById("adm-back").onclick = function () {
      history.replaceState(null, "", location.pathname + location.search);
      boot();
    };
    document.getElementById("adm-tab-users").onclick = function () { adminTab = "users"; viewAdmin(); };
    document.getElementById("adm-tab-outbox").onclick = function () { adminTab = "outbox"; viewAdmin(); };
  }

  function viewAdminOutbox() {
    const emails = store.getEmails();
    render(
      brandRow() +
      '<h2 class="view-title">Founder dashboard</h2>' +
      '<p class="view-sub">Every email the app has "sent" during this beta — no real ESP is connected yet, ' +
        "so nothing leaves this browser. Review the copy here, then wire a provider " +
        "(Resend, Postmark, SendGrid) and swap it into <code>sendEmail()</code>.</p>" +
      adminTabsHTML() +
      (emails.length
        ? emails.map(function (m) {
            return (
              '<div class="card admin-email">' +
                '<div class="admin-email-head">' +
                  "<strong>" + esc(m.subject) + "</strong>" +
                  '<span class="deck-hint" style="margin:0">' + esc(m.sentAt.slice(0, 16).replace("T", " ")) + "</span>" +
                "</div>" +
                '<div class="deck-hint" style="margin:2px 0 8px;text-align:left">To: ' + esc(m.to) + "</div>" +
                '<pre class="admin-email-body">' + esc(m.body) + "</pre>" +
              "</div>"
            );
          }).join("")
        : '<div class="card"><div class="empty-deck">No emails yet — they’ll appear here as welcome emails and password resets go out.</div></div>') +
      '<button class="btn btn-ghost" id="adm-back">← Back to the app</button>'
    );
    wireAdminChrome();
  }

  /* ---------------- Boot ---------------- */

  if (ENV === "staging") {
    const ribbon = document.createElement("div");
    ribbon.className = "env-ribbon";
    ribbon.textContent = "🧪 STAGING — separate database, fully isolated from production";
    document.body.prepend(ribbon);
  }

  /* Supabase's password-reset email links back here with
     "#access_token=...&type=recovery" in the URL hash. Check this
     synchronously (before supabase-js's own async hash handling can
     clear it) so boot() routes to the reset-password screen reliably. */
  const isRecoveryLink = location.hash.includes("type=recovery");

  if (nestfulDB) {
    nestfulDB.client.auth.onAuthStateChange(function (event) {
      if (event === "PASSWORD_RECOVERY") viewResetPassword();
    });
  }

  async function boot() {
    if (isRecoveryLink) return viewResetPassword();
    if (location.hash === "#admin") return viewAdmin();
    try {
      await refreshAuthState();
    } catch (err) {
      return viewConnectionError(err);
    }
    const user = currentUser();
    if (user && user.profile) viewHome();
    else if (user) {
      draft = freshDraft();
      viewOnbYou();
    } else viewLanding();
  }

  window.addEventListener("hashchange", boot);
  boot();
})();
