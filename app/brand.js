/* ============================================================
   BRAND CONFIGURATION — REPLACEABLE SECTION
   ------------------------------------------------------------
   Everything brand-specific lives here and in brand.css.
   To rebrand the app, edit ONLY these two files.

   logoMark accepts either an emoji string ("🪺") or an HTML
   snippet pointing at your real logo asset later, e.g.:
     logoMark: '<img src="assets/logo.svg" alt="" class="logo-img">'
   ============================================================ */

const BRAND = {
  name: "Nestful",
  tagline: "Where openness comes first.",
  subline:
    "Kids, dependents, caregiving — settled before the first message, not on date three.",
  logoMark: "🪺",

  // Community language for the two member groups
  badges: {
    full: {
      key: "full",
      label: "Full Nest",
      icon: "🪺",
      blurb: "My nest has company.",
    },
    ready: {
      key: "ready",
      label: "Nest-Ready",
      icon: "🌿",
      blurb: "My nest has room.",
    },
  },

  // Storage namespace — change if you rename the product so
  // old demo data doesn't collide with the new brand.
  storagePrefix: "nestful",

  // Real inbox for support/legal contact and as the "from" address once
  // a real ESP (Brevo) is wired up. See backend/SETUP.md.
  supportEmail: "support@nestfulapp.com",
};

/* ============================================================
   FEATURE FLAGS — release configuration
   ------------------------------------------------------------
   upgradeEnabled: false  → freemium BETA. Nest filters, Rhythm
     Match, and see-who-liked-you are free; daily caps stay
     (8 likes, 2 notes) to keep the app purposeful; hitting a
     cap shows a "Nestful+ coming soon" waitlist instead of a
     paywall.
   upgradeEnabled: true   → turns the full Nestful+ purchase
     funnel back on (requires payment processing in place).
   ============================================================ */
const FEATURES = {
  upgradeEnabled: false,
};

/* ============================================================
   END BRAND CONFIGURATION
   ============================================================ */
