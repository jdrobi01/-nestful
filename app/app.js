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
      isAdmin: !!authProfile.is_admin,
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

  /* ---------------- Email ----------------
     Fire-and-forget call to the real sender (netlify/functions/send-email.js),
     which calls Brevo for real and logs a type+timestamp-only event (no
     recipient) to email_events for the admin dashboard's activity chart.
     Never blocks the UI and never surfaces a failure to the end user — if
     this silently fails (e.g. BREVO_API_KEY not yet configured on this
     Netlify site), the email just doesn't send; nothing else depends on it. */
  function sendRealEmail(type, name, email) {
    if (!email) return;
    fetch("/.netlify/functions/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // appUrl: so the email's CTA button links back to whichever site
      // actually sent it (staging vs production), not always production.
      body: JSON.stringify({ type: type, name: name, email: email, appUrl: location.origin }),
    }).catch(function () { /* best-effort — see comment above */ });
  }

  function sendWelcomeEmail(account) {
    sendRealEmail("welcome", account.name, account.email);
  }

  function sendPasswordChangedEmail(account) {
    sendRealEmail("password_changed", account.name, account.email);
  }

  function sendWaitlistEmail(account) {
    sendRealEmail("waitlist", account.name, account.email);
  }

  function sendAccountDeletedEmail(account) {
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
    { name: "Maya", age: 34, city: "Austin, TX", hue: 1, gender: "woman", pronouns: "she/her", seeking: ["man"], contents: ["young"], counts: { young: "1" }, openTo: ["young", "teens", "ready"], rhythm: "alternating",
      bio: "Mom of a 6-year-old adventurer. Sunday pancakes are sacred, museum memberships are maxed out, and I will absolutely beat you at mini golf." },
    { name: "Derek", age: 41, city: "Round Rock, TX", hue: 3, gender: "man", pronouns: "he/him", seeking: ["woman"], contents: ["teens"], counts: { teens: "2" }, openTo: ["young", "teens", "adult", "ready"], rhythm: "fulltime",
      bio: "Dad to two teenagers who think my jokes are terrible. They're wrong. High school baseball coach, amateur smoker of briskets, professional carpool driver." },
    { name: "Priya", age: 29, city: "Austin, TX", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["man", "nonbinary"], contents: [], openTo: ["young"],
      bio: "No kids yet — but I've always pictured a full, loud house. Pediatric nurse, so tiny humans don't faze me. Looking for someone whose weekend plans include juice boxes." },
    { name: "Sam", age: 36, city: "Cedar Park, TX", hue: 4, gender: "nonbinary", pronouns: "they/them", seeking: ["woman", "man", "nonbinary"], contents: [], openTo: ["young", "teens", "adult"],
      bio: "Open book, open nest. Family is whoever you show up for — I learned that helping raise my nieces. Give me farmers markets, live music, and someone worth showing up for." },
    { name: "Alex", age: 38, city: "Austin, TX", hue: 3, gender: "man", pronouns: "he/him", seeking: ["woman", "nonbinary"], contents: ["adult"], openTo: ["young", "adult", "ready"], rhythm: "fulltime",
      bio: "My mom lives with me and she's honestly the fun one. Software dev by day, her sous-chef by night. Seeking someone who gets that caregiving is love in action." },
    { name: "Jordan", age: 31, city: "Pflugerville, TX", hue: 1, gender: "man", pronouns: "he/him", seeking: ["woman", "man"], contents: [], openTo: ["teens"],
      bio: "Middle-school coach. Teenagers don't scare me — they're hilarious. Weekends are for trail runs and taco crawls." },
    { name: "Elena", age: 44, city: "Georgetown, TX", hue: 2, gender: "woman", pronouns: "she/her", seeking: ["man", "woman"], contents: ["teens", "adult"], counts: { teens: "1" }, openTo: ["teens", "adult"], rhythm: "varies",
      bio: "Raising a teen and helping my dad. Busy nest, big heart. If your idea of romance includes patience and a good calendar app, we'll get along." },
    { name: "Chris", age: 33, city: "Austin, TX", hue: 4, gender: "man", pronouns: "he/him", seeking: ["woman"], contents: ["young"], counts: { young: "2" }, openTo: ["young"], rhythm: "weekends",
      bio: "Single dad of twins. Yes, I can do pigtails. No, not well. Firefighter, so I'm calm in chaos — which twin toddlers provide daily." },
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

  // Persistent reassurance banner whenever the founder/admin ghost-viewer
  // account is signed in — lives outside #app (like the staging ribbon)
  // so it survives every render() call without being re-created each time.
  function syncAdminRibbon() {
    const user = currentUser();
    const show = !!(user && user.isAdmin);
    let ribbon = document.getElementById("admin-ribbon");
    if (show && !ribbon) {
      ribbon = document.createElement("div");
      ribbon.id = "admin-ribbon";
      ribbon.className = "env-ribbon admin-ribbon";
      ribbon.textContent = "👁 Admin mode — invisible to members, actions are simulated only · tap for dashboard 📊";
      ribbon.title = "Open the founder dashboard";
      // The ribbon itself IS the admin entry point — always on screen on
      // every view (it lives outside #app, see render()), one tap away,
      // and only ever created in the first place when isAdmin is true.
      ribbon.onclick = function () { location.hash = "#admin"; };
      document.body.prepend(ribbon);
    } else if (!show && ribbon) {
      ribbon.remove();
    }
  }

  function render(html) {
    syncAdminRibbon();
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
      return '<span class="avatar ' + sizeClass + '"><img src="' + photo + '" alt=""></span>';
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

  // Admin mode never writes a real like/note (see recordLike) — these make
  // that unmistakable in the UI itself, not just true under the hood, so
  // it's never ambiguous whether an action reached a real member.
  function likeToastText(name) {
    return currentUser().isAdmin
      ? "👁 Simulated — " + name + " was not actually notified"
      : "Liked " + name + " ❤";
  }
  function noteToastText(name) {
    return currentUser().isAdmin
      ? "👁 Simulated — no note actually sent to " + name
      : "Note sent to " + name + " ❤";
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

    // Admin ghost-viewer mode: the UI responds exactly like a real like,
    // but nothing ever reaches Supabase — a real member must never get a
    // notification/email from an account that isn't really theirs to get.
    if (match._id && nestfulDB && !user.isAdmin) {
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
              return avatarHTML(s.name, null, s.hue, "avatar-sm blurred");
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
      adminStats = null;
      adminStatsLoadedFor = null;
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
        toast(likeToastText(match.name));
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
      toast(likeToastText(match.name));
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
      toast(likeToastText(s.name));
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
        toast(noteToastText(s.name));
        viewHome();
      };
    }

    document.getElementById("dt-note-toggle").onclick = showNotePanel;
    if (openNote) showNotePanel();
  }

  /* ----- Founder dashboard: hidden admin stats (#admin) -----
     Gated by currentUser().isAdmin (see boot() — this is only reachable
     after refreshAuthState() resolves). Anyone else hitting #admin,
     signed in or not, gets silently redirected — no hint that a founder
     view even exists. Everything shown here is an aggregate count or a
     type+timestamp-only tally — no member's real data (name, email,
     message content) is ever displayed, by design. */

  let adminStats = null;
  let adminStatsLoadedFor = null; // authUser.id this cache belongs to

  function ensureAdminStatsLoaded(userId) {
    if (!nestfulDB || adminStatsLoadedFor === userId) return;
    adminStatsLoadedFor = userId;
    nestfulDB.getAdminStats()
      .then(function (stats) {
        adminStats = stats;
        viewAdmin();
      })
      .catch(function (err) {
        console.error("Couldn't load admin stats:", err && (err.message || err));
        adminStatsLoadedFor = null; // allow a retry on the next render
      });
  }

  function viewAdmin() {
    const user = currentUser();
    if (!user || !user.isAdmin) {
      history.replaceState(null, "", location.pathname + location.search);
      return user ? viewHome() : viewLanding();
    }

    ensureAdminStatsLoaded(user.id);

    render(
      brandRow() +
      '<h2 class="view-title">Founder dashboard</h2>' +
      '<p class="view-sub">Environment: <strong>' + ENV + "</strong> · signed in as " + esc(user.name) + "</p>" +
      adminStatsHTML() +
      '<button class="btn btn-ghost" id="adm-back">← Back to the app</button>'
    );

    wireAdminChrome();
  }

  function adminStatCard(icon, value, label) {
    return (
      '<div class="admin-stat">' +
        '<span class="admin-stat-icon">' + icon + "</span>" +
        '<span class="admin-stat-num">' + value + "</span>" +
        '<span class="admin-stat-label">' + esc(label) + "</span>" +
      "</div>"
    );
  }

  const EMAIL_TYPE_LABELS = {
    welcome: "Welcome",
    password_changed: "Password changed",
    waitlist: "Waitlist join",
    account_deleted: "Account deleted",
    new_like: "New like",
    new_message: "New message",
  };
  function emailTypeLabel(type) {
    return EMAIL_TYPE_LABELS[type] || type;
  }

  // Deliberately a plain CSS bar chart, no charting library — type + count
  // only, matching email_events itself (never a recipient or subject).
  function emailBarChartHTML(totalsByType) {
    const entries = Object.keys(totalsByType || {}).map(function (t) {
      return { type: t, count: totalsByType[t] };
    }).sort(function (a, b) { return b.count - a.count; });
    if (!entries.length) {
      return '<div class="empty-deck">No emails sent in the last 14 days.</div>';
    }
    const max = Math.max.apply(null, entries.map(function (e) { return e.count; }));
    return (
      '<div class="admin-bar-chart">' +
        entries.map(function (e) {
          const pct = max ? Math.round((e.count / max) * 100) : 0;
          return (
            '<div class="admin-bar-row">' +
              '<span class="admin-bar-label">' + esc(emailTypeLabel(e.type)) + "</span>" +
              '<div class="admin-bar-track"><div class="admin-bar-fill" style="width:' + pct + '%"></div></div>' +
              '<span class="admin-bar-value">' + e.count + "</span>" +
            "</div>"
          );
        }).join("") +
      "</div>"
    );
  }

  // Small inline SVG line chart, no library — 14 days, zero-filled so the
  // line never silently skips a quiet day.
  function emailTrendChartHTML(dailySeries) {
    if (!dailySeries || !dailySeries.length) return "";
    const w = 300, h = 64, pad = 6;
    const max = Math.max(1, Math.max.apply(null, dailySeries.map(function (d) { return d.count; })));
    const n = dailySeries.length;
    const stepX = n > 1 ? (w - pad * 2) / (n - 1) : 0;
    const points = dailySeries.map(function (d, i) {
      const x = pad + i * stepX;
      const y = h - pad - (d.count / max) * (h - pad * 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    const firstLabel = dailySeries[0].date.slice(5);
    const lastLabel = dailySeries[n - 1].date.slice(5);
    return (
      '<div class="admin-trend">' +
        '<svg viewBox="0 0 ' + w + " " + h + '" class="admin-trend-svg" preserveAspectRatio="none">' +
          '<polyline points="' + points + '" fill="none" stroke="#0093A3" stroke-width="2" ' +
            'stroke-linejoin="round" stroke-linecap="round" />' +
        "</svg>" +
        '<div class="admin-trend-labels"><span>' + esc(firstLabel) + "</span><span>" + esc(lastLabel) + "</span></div>" +
      "</div>"
    );
  }

  function adminStatsHTML() {
    if (!adminStats) {
      return '<div class="card"><div class="empty-deck">Loading stats…</div></div>';
    }
    return (
      '<div class="card">' +
        '<div class="admin-stat-grid">' +
          adminStatCard("🪺", adminStats.totalMembers, "Real members") +
          adminStatCard(BRAND.badges.full.icon, adminStats.fullNest, "Full Nest") +
          adminStatCard(BRAND.badges.ready.icon, adminStats.nestReady, "Nest-Ready") +
          adminStatCard("❤", adminStats.totalLikes, "Likes sent") +
          adminStatCard("✎", adminStats.totalNotes, "Notes with a message") +
        "</div>" +
        '<p class="deck-hint" style="margin-top:16px;text-align:left">' +
          "Page-visit and click-level analytics (e.g. login page views) aren’t tracked yet — " +
          "that needs a small event-logging system as a follow-up build, separate from these " +
          "counts (which come straight from the real profiles/likes tables)." +
        "</p>" +
      "</div>" +
      '<div class="card" style="margin-top:14px">' +
        '<h3 style="margin-bottom:12px">Email activity, last 14 days</h3>' +
        '<div class="deck-hint" style="text-align:left;margin-bottom:2px">Daily volume</div>' +
        emailTrendChartHTML(adminStats.emailDailySeries) +
        '<div class="deck-hint" style="text-align:left;margin:16px 0 2px">By type</div>' +
        emailBarChartHTML(adminStats.emailTotalsByType) +
      "</div>"
    );
  }

  function wireAdminChrome() {
    document.getElementById("adm-back").onclick = function () {
      history.replaceState(null, "", location.pathname + location.search);
      boot();
    };
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
    try {
      await refreshAuthState();
    } catch (err) {
      return viewConnectionError(err);
    }
    // Checked AFTER refreshAuthState() (not before, like every other
    // route) specifically so viewAdmin() can rely on currentUser().isAdmin
    // being populated — it silently redirects anyone who isn't a real,
    // signed-in admin rather than showing even a hint of a founder screen.
    if (location.hash === "#admin") return viewAdmin();
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
