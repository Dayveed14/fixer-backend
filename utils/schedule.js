/* ===========================
   SCHEDULE RULES
   Bookings (expert calls) and device pickups must fall inside working
   hours (8:00 AM – 10:00 PM, Abuja time) and can't be in the past.

   Everything is evaluated in Africa/Lagos time on purpose: the server
   (Render) runs in UTC and a customer's browser could be set to any
   timezone, but the business operates on Abuja time.

   The frontend has a copy of these rules (src/utils/schedule.js) so it
   can hide unavailable slots, but this file is what's enforced.
=========================== */

const BUSINESS_TIMEZONE = "Africa/Lagos";
const OPEN_MINUTES = 8 * 60; // 08:00
const CLOSE_MINUTES = 22 * 60; // 22:00 — nothing may *end* after this
const SLOT_INTERVAL_MINUTES = 30;
const MAX_DAYS_AHEAD = 30;

// How much notice we need before a slot.
//  - booking: a technician has to be assigned before the call
//  - pickup: a rider has to get to the customer
const LEAD_MINUTES = {
  booking: 60,
  pickup: 120,
};

// How long each kind of appointment occupies — the last bookable start
// time is CLOSE - duration, so a 30-minute call can start at 21:30 at
// the latest and still finish by 22:00.
const DURATION_MINUTES = {
  booking: 30,
  pickup: 60,
};

const pad = (n) => String(n).padStart(2, "0");

function minutesToTime(totalMinutes) {
  return `${pad(Math.floor(totalMinutes / 60))}:${pad(totalMinutes % 60)}`;
}

/** "HH:MM" or "HH:MM:SS" -> minutes since midnight, or null if malformed. */
function parseTime(value) {
  if (typeof value !== "string") return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** "YYYY-MM-DD" -> { y, m, d } if it's a real calendar date, else null. */
function parseDate(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [y, m, d] = match.slice(1).map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m, d };
}

/** Current date ("YYYY-MM-DD") and minutes-since-midnight in Abuja. */
function nowInBusinessTz(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: BUSINESS_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function daysBetween(fromDate, toDate) {
  const a = parseDate(fromDate);
  const b = parseDate(toDate);
  return Math.round(
    (Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000,
  );
}

/** Every start time offered for a kind of appointment, as "HH:MM". */
function allSlots(kind = "booking") {
  const duration = DURATION_MINUTES[kind] ?? DURATION_MINUTES.booking;
  const slots = [];
  for (
    let m = OPEN_MINUTES;
    m + duration <= CLOSE_MINUTES;
    m += SLOT_INTERVAL_MINUTES
  ) {
    slots.push(minutesToTime(m));
  }
  return slots;
}

/** Start times still bookable on `date`, given the current time. */
function availableSlots(date, kind = "booking", now = new Date()) {
  if (!parseDate(date)) return [];
  const lead = LEAD_MINUTES[kind] ?? LEAD_MINUTES.booking;
  const today = nowInBusinessTz(now);
  const diff = daysBetween(today.date, date);

  if (diff < 0 || diff > MAX_DAYS_AHEAD) return [];

  return allSlots(kind).filter((slot) => {
    if (diff > 0) return true;
    return parseTime(slot) >= today.minutes + lead;
  });
}

/**
 * Validates a requested date + time. Returns { ok: true, date, time }
 * with the time normalised to "HH:MM:00" (the DB TIME format), or
 * { ok: false, message } explaining why it was rejected.
 */
function validateSlot(date, time, kind = "booking", now = new Date()) {
  if (!parseDate(date)) {
    return { ok: false, message: "Please choose a valid date (YYYY-MM-DD)." };
  }

  const minutes = parseTime(time);
  if (minutes === null) {
    return { ok: false, message: "Please choose a valid time (HH:MM)." };
  }

  const slot = minutesToTime(minutes);
  if (!allSlots(kind).includes(slot)) {
    return {
      ok: false,
      message:
        "Please choose a time between 8:00 AM and 10:00 PM, on the hour or half hour.",
    };
  }

  const today = nowInBusinessTz(now);
  const diff = daysBetween(today.date, date);

  if (diff < 0) {
    return { ok: false, message: "That date has already passed." };
  }

  if (diff > MAX_DAYS_AHEAD) {
    return {
      ok: false,
      message: `Bookings can only be made up to ${MAX_DAYS_AHEAD} days ahead.`,
    };
  }

  if (!availableSlots(date, kind, now).includes(slot)) {
    return {
      ok: false,
      message:
        "That time is no longer available today. Please pick a later time or another day.",
    };
  }

  return { ok: true, date, time: `${slot}:00` };
}

/** "9:00" / "09:00" / "09:00:00" -> "09:00:00", or null if malformed. */
function normalizeTime(value) {
  const minutes = parseTime(value);
  return minutes === null ? null : `${minutesToTime(minutes)}:00`;
}

module.exports = {
  normalizeTime,
  BUSINESS_TIMEZONE,
  LEAD_MINUTES,
  DURATION_MINUTES,
  MAX_DAYS_AHEAD,
  allSlots,
  availableSlots,
  validateSlot,
  nowInBusinessTz,
  parseTime,
  parseDate,
};
