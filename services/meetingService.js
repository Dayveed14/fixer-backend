/* ===========================
   VIDEO MEETING LINKS
   Every paid video-call booking gets its meeting link at booking time,
   so the customer sees it straight away and the technician just opens
   it at the appointment time.

   Provider:
   - Google Meet, when a Google Workspace service account is configured
     (see .env.example: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY,
     GOOGLE_CALENDAR_ID, GOOGLE_IMPERSONATE_USER). A calendar event with
     a Meet conference is created on the Fixer calendar and the customer
     is invited.
   - Otherwise (or if Google fails), a Jitsi Meet room — free, works in
     any browser, no account needed — so a video booking always has a
     working link.
=========================== */

const crypto = require("crypto");

const GOOGLE_TIMEOUT_MS = 10000;

function slugPart(text) {
  return String(text || "")
    .replace(/[^A-Za-z0-9]+/g, "")
    .slice(0, 20);
}

function jitsiMeeting(bookingReference) {
  const room = `Fixer-${slugPart(bookingReference) || "Session"}-${crypto.randomBytes(5).toString("hex")}`;
  return { url: `https://meet.jit.si/${room}`, provider: "jitsi" };
}

function googleConfigured(env = process.env) {
  return Boolean(
    env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      env.GOOGLE_PRIVATE_KEY &&
      env.GOOGLE_CALENDAR_ID,
  );
}

const base64url = (input) =>
  Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function googleAccessToken(env = process.env) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/calendar.events",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  // Creating Meet links from a service account needs domain-wide
  // delegation, acting as a real Workspace user.
  if (env.GOOGLE_IMPERSONATE_USER) claims.sub = env.GOOGLE_IMPERSONATE_USER;

  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
  const key = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(key);
  const assertion = `${unsigned}.${base64url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || body.error || "Google token request failed");
  }
  return body.access_token;
}

async function googleMeeting({ bookingReference, startsAt, durationMinutes, customerEmail, summary }, env = process.env) {
  const token = await googleAccessToken(env);
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + (durationMinutes || 30) * 60000);

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events?conferenceDataVersion=1&sendUpdates=all`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: summary || `Fixer video support ${bookingReference}`,
        start: { dateTime: start.toISOString(), timeZone: "Africa/Lagos" },
        end: { dateTime: end.toISOString(), timeZone: "Africa/Lagos" },
        attendees: customerEmail ? [{ email: customerEmail }] : [],
        conferenceData: {
          createRequest: {
            requestId: crypto.randomUUID(),
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      }),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    },
  );
  const body = await response.json();
  const url =
    body.hangoutLink ||
    body.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
  if (!response.ok || !url) {
    throw new Error(body.error?.message || "Google Calendar did not return a Meet link");
  }
  return { url, provider: "google_meet" };
}

/**
 * Returns { url, provider }. Never throws — falls back to Jitsi so a
 * paid video booking always has a link.
 */
async function createVideoMeeting(details, env = process.env) {
  if (googleConfigured(env)) {
    try {
      return await googleMeeting(details, env);
    } catch (err) {
      console.error(`Google Meet link failed for ${details.bookingReference}, using Jitsi:`, err.message);
    }
  }
  return jitsiMeeting(details.bookingReference);
}

module.exports = { createVideoMeeting, googleConfigured, jitsiMeeting };
