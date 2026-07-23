/* ============================================================
   Nestful — transactional email sender (Netlify Function)
   ------------------------------------------------------------
   Runs server-side only. This is the one place the real Brevo API
   key is ever used — set as an environment variable in Netlify
   (Site configuration → Environment variables → BREVO_API_KEY on
   BOTH the production and staging sites), never shipped to the
   browser like the Supabase anon key safely can be.

   Deliberately template-locked: callers pick a `type` from the
   fixed, on-brand set below and supply only name/email — never
   arbitrary subject/body content. Add a new notification by adding
   a new case to templates() below, not by accepting raw HTML.
   ============================================================ */

const FROM_EMAIL = "support@nestfulapp.com";
const FROM_NAME = "Nestful";

const ALLOWED_ORIGINS = [
  "https://nestfulapp.com",
  "https://www.nestfulapp.com",
];

/* Also allow any Netlify-generated URL (staging, deploy previews) — these
   are unpredictable subdomains we can't list ahead of time. This is a
   casual-abuse deterrent, not a real security boundary either way (see
   note below), so the broader match is fine. */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.some((o) => origin.startsWith(o))) return true;
  try {
    return new URL(origin).hostname.endsWith(".netlify.app");
  } catch {
    return false;
  }
}

// Best-effort activity log for the hidden admin dashboard — type + timestamp
// only, never the recipient. Failures here must never fail the actual email
// send, so this is fire-and-forget with its own try/catch.
async function logEmailEvent(type) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return; // not configured on this site — silently skip
  try {
    await fetch(url + "/rest/v1/email_events", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: type }),
    });
  } catch {
    // Non-fatal — the email itself already sent successfully.
  }
}

// The button/CTA destination in the email HTML — must point at whichever
// site actually triggered the send (staging vs production), not always
// production, since these get embedded as a real clickable link in a
// real email. Reuses the same allowlist as the origin check above rather
// than trusting the caller's value outright — this becomes a link inside
// an outbound email, so an unvalidated value here would be an open
// redirect/phishing vector.
function safeAppUrl(candidate) {
  if (candidate && isAllowedOrigin(candidate)) return candidate;
  return "https://nestfulapp.com";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* Shared wrapper so every Nestful email looks like the same brand,
   not a patchwork of one-off HTML. */
function layout(bodyHtml) {
  return (
    '<div style="background:#F3FBFF;padding:32px 16px;font-family:Arial,Helvetica,sans-serif">' +
      '<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:22px;' +
        'padding:32px 28px;color:#1D3557">' +
        '<div style="text-align:center;font-size:40px;margin-bottom:6px">🪺</div>' +
        '<div style="text-align:center;font-family:Georgia,serif;font-size:22px;' +
          'color:#1D3557;font-weight:bold;margin-bottom:24px">Nestful</div>' +
        bodyHtml +
        '<div style="text-align:center;margin-top:28px;padding-top:18px;' +
          'border-top:1px solid #e2e0d9;font-size:12px;color:#5876a3">' +
          'Nestful — where openness comes first.<br>' +
          '<a href="https://nestfulapp.com" style="color:#0093A3">nestfulapp.com</a>' +
        "</div>" +
      "</div>" +
    "</div>"
  );
}

function button(label, href) {
  return (
    '<div style="text-align:center;margin:26px 0 8px">' +
      '<a href="' + href + '" style="background:#00C2CF;color:#1D3557;' +
        "text-decoration:none;font-weight:bold;padding:13px 30px;border-radius:999px;" +
        'font-size:15px;display:inline-block">' + esc(label) + "</a>" +
    "</div>"
  );
}

function templates(rawName, rawSenderName, rawNote, appUrl) {
  const name = esc(rawName || "there");
  const senderName = esc(rawSenderName || "Someone");
  const note = rawNote ? esc(rawNote) : "";
  return {
    welcome: {
      subject: "Welcome to Nestful 🪺",
      html: layout(
        '<p style="font-size:15px;line-height:1.65;margin:0 0 14px">Hi ' + name + ",</p>" +
        '<p style="font-size:15px;line-height:1.65;margin:0 0 14px">' +
          "You're in. Nestful exists for one reason: to settle the “kids or " +
          "no kids” question before it turns into an awkward date-three " +
          "conversation — not after." +
        "</p>" +
        '<p style="font-size:15px;line-height:1.65;margin:0 0 6px">' +
          "Finish your Nest Profile and you'll start seeing matches who already " +
          "share your openness. No reveals. No surprises. Just people who already " +
          "said yes." +
        "</p>" +
        button("Finish my profile", appUrl)
      ),
    },

    password_changed: {
      subject: "Your Nestful password was changed",
      html: layout(
        '<p style="font-size:15px;line-height:1.65;margin:0 0 14px">Hi ' + name + ",</p>" +
        '<p style="font-size:15px;line-height:1.65;margin:0 0 14px">' +
          "This confirms your Nestful password was just changed." +
        "</p>" +
        '<p style="font-size:15px;line-height:1.65;margin:0">' +
          "If that wasn't you, reset your password right away from the sign-in " +
          "screen — no other account access is possible without it." +
        "</p>" +
        button("Go to Nestful", appUrl)
      ),
    },

    waitlist: {
      subject: "You're on the Nestful+ list ✨",
      html: layout(
        '<p style="font-size:15px;line-height:1.65;margin:0 0 14px">Hi ' + name + ",</p>" +
        '<p style="font-size:15px;line-height:1.65;margin:0 0 14px">' +
          "Nestful+ is coming — unlimited likes, Private Nest mode, a weekly " +
          "Boost, and more room to say what's on your mind. You'll be first to " +
          "know the moment it opens." +
        "</p>" +
        '<p style="font-size:15px;line-height:1.65;margin:0">' +
          "In the meantime, your free nest is already fully open — Nest " +
          "filters, Rhythm Match, and seeing who liked you are all included, no " +
          "waiting required." +
        "</p>" +
        button("Back to my nest", appUrl)
      ),
    },

    new_like: {
      subject: senderName + " likes your nest 🪺",
      html: layout(
        '<p style="font-size:15px;line-height:1.65;margin:0 0 14px">Hi ' + name + ",</p>" +
        '<p style="font-size:15px;line-height:1.65;margin:0 0 14px">' +
          "<strong>" + senderName + "</strong> just liked your Nest Profile. They already " +
          "know where you stand on kids — no reveals, no surprises, just someone who said " +
          "yes before saying hi." +
        "</p>" +
        '<p style="font-size:15px;line-height:1.65;margin:0">' +
          "See who it is and like them back to open the conversation." +
        "</p>" +
        button("See who liked me", appUrl)
      ),
    },

    new_message: {
      subject: senderName + " sent you a note 🪺",
      html: layout(
        '<p style="font-size:15px;line-height:1.65;margin:0 0 14px">Hi ' + name + ",</p>" +
        '<p style="font-size:15px;line-height:1.65;margin:0 0 14px">' +
          "<strong>" + senderName + "</strong> liked your Nest Profile and left you a note:" +
        "</p>" +
        (note ?
          '<div style="background:#F3FBFF;border-radius:14px;padding:16px 18px;' +
            'font-size:15px;line-height:1.6;color:#1D3557;margin:0 0 18px;font-style:italic">' +
            "“" + note + "”" +
          "</div>"
        : "") +
        '<p style="font-size:15px;line-height:1.65;margin:0">' +
          "Like them back to start the conversation." +
        "</p>" +
        button("See my notes", appUrl)
      ),
    },

    account_deleted: {
      subject: "Your Nestful account has been deleted",
      html: layout(
        '<p style="font-size:15px;line-height:1.65;margin:0 0 14px">Hi ' + name + ",</p>" +
        '<p style="font-size:15px;line-height:1.65;margin:0 0 14px">' +
          "This confirms your Nestful profile, photo, and Nest Profile answers " +
          "have been permanently deleted, along with every like and note you sent." +
        "</p>" +
        '<p style="font-size:15px;line-height:1.65;margin:0">' +
          "We hope your nest finds what it's looking for — here or elsewhere. " +
          "You're always welcome back." +
        "</p>"
      ),
    },
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  // Casual-abuse guard, not a real auth boundary — Brevo's own account-level
  // send cap is the actual backstop. A determined attacker can spoof Origin,
  // but this stops drive-by scanning from other sites.
  const origin = event.headers.origin || event.headers.referer || "";
  if (!isAllowedOrigin(origin)) {
    return { statusCode: 403, body: "Forbidden origin" };
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: "BREVO_API_KEY not configured on this site" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const { type, name, email, senderName, note, appUrl } = payload;
  if (!email || typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { statusCode: 400, body: "Invalid email" };
  }
  if (name !== undefined && (typeof name !== "string" || name.length > 100)) {
    return { statusCode: 400, body: "Invalid name" };
  }
  if (senderName !== undefined && (typeof senderName !== "string" || senderName.length > 100)) {
    return { statusCode: 400, body: "Invalid senderName" };
  }
  if (note !== undefined && (typeof note !== "string" || note.length > 500)) {
    return { statusCode: 400, body: "Invalid note" };
  }

  // Falls back to the request's own (already-validated) origin if the
  // caller didn't pass an explicit appUrl, so this stays correct even
  // for any future caller that forgets to send one.
  const resolvedAppUrl = safeAppUrl(appUrl || origin);

  const template = templates(name, senderName, note, resolvedAppUrl)[type];
  if (!template) {
    return { statusCode: 400, body: "Unknown template type: " + type };
  }

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: FROM_NAME, email: FROM_EMAIL },
        to: [{ email: email, name: name || undefined }],
        subject: template.subject,
        htmlContent: template.html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, body: "Brevo error: " + errText };
    }

    await logEmailEvent(type);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: "Send failed: " + err.message };
  }
};
