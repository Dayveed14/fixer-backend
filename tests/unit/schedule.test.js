const {
  allSlots,
  availableSlots,
  validateSlot,
  nowInBusinessTz,
  normalizeTime,
} = require("../../utils/schedule");

// Abuja is UTC+1 all year (no DST), so 20:00Z is 21:00 in Abuja.
const at = (iso) => new Date(iso);

describe("working hours (8:00 AM – 10:00 PM)", () => {
  it("offers 30-minute call slots from 08:00 to 21:30", () => {
    const slots = allSlots("booking");
    expect(slots[0]).toBe("08:00");
    expect(slots[slots.length - 1]).toBe("21:30");
    expect(slots).not.toContain("22:00");
    expect(slots).not.toContain("07:30");
  });

  it("offers pickup slots that finish by 22:00 (last start 21:00)", () => {
    const slots = allSlots("pickup");
    expect(slots[0]).toBe("08:00");
    expect(slots[slots.length - 1]).toBe("21:00");
  });
});

describe("Abuja time, not server time", () => {
  it("reads the date/time in Africa/Lagos even though the server runs in UTC", () => {
    // 23:30 UTC on the 1st is already 00:30 on the 2nd in Abuja.
    expect(nowInBusinessTz(at("2026-11-01T23:30:00Z"))).toEqual({
      date: "2026-11-02",
      minutes: 30,
    });
  });
});

describe("availableSlots — accounts for the current time", () => {
  it("at 9:00 PM nothing is left today; tomorrow is fully open", () => {
    const now = at("2026-11-02T20:00:00Z"); // 21:00 Abuja
    expect(availableSlots("2026-11-02", "booking", now)).toEqual([]);
    expect(availableSlots("2026-11-02", "pickup", now)).toEqual([]);
    expect(availableSlots("2026-11-03", "booking", now)).toEqual(allSlots("booking"));
  });

  it("at 2:10 PM a call can be booked from 3:30 PM (60-min notice)", () => {
    const now = at("2026-11-02T13:10:00Z"); // 14:10 Abuja
    const slots = availableSlots("2026-11-02", "booking", now);
    expect(slots[0]).toBe("15:30");
    expect(slots).not.toContain("15:00");
  });

  it("pickups need 2 hours' notice", () => {
    const now = at("2026-11-02T13:10:00Z"); // 14:10 Abuja
    expect(availableSlots("2026-11-02", "pickup", now)[0]).toBe("16:30");
  });

  it("before opening, the whole day is available", () => {
    const now = at("2026-11-02T04:00:00Z"); // 05:00 Abuja
    expect(availableSlots("2026-11-02", "booking", now)).toEqual(allSlots("booking"));
  });

  it("returns nothing for past dates or more than 30 days ahead", () => {
    const now = at("2026-11-02T08:00:00Z");
    expect(availableSlots("2026-11-01", "booking", now)).toEqual([]);
    expect(availableSlots("2026-12-03", "booking", now)).toEqual([]);
    expect(availableSlots("2026-12-02", "booking", now).length).toBeGreaterThan(0);
  });
});

describe("validateSlot", () => {
  const now = at("2026-11-02T13:10:00Z"); // 14:10 Abuja

  it("accepts a valid future slot and normalises the time", () => {
    expect(validateSlot("2026-11-03", "9:00", "booking", now)).toEqual({
      ok: true,
      date: "2026-11-03",
      time: "09:00:00",
    });
  });

  it.each([
    ["2026-11-03", "07:30", /8:00 AM and 10:00 PM/],
    ["2026-11-03", "22:00", /8:00 AM and 10:00 PM/],
    ["2026-11-03", "10:15", /hour or half hour/],
    ["2026-11-02", "14:30", /no longer available/],
    ["2026-11-01", "10:00", /already passed/],
    ["2026-12-25", "10:00", /30 days/],
    ["2026-02-30", "10:00", /valid date/],
    ["03/11/2026", "10:00", /valid date/],
    ["2026-11-03", "9am", /valid time/],
    ["2026-11-03", undefined, /valid time/],
  ])("rejects %s %s", (date, time, message) => {
    const result = validateSlot(date, time, "booking", now);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(message);
  });
});

describe("normalizeTime", () => {
  it.each([
    ["9:00", "09:00:00"],
    ["09:30", "09:30:00"],
    ["21:30:00", "21:30:00"],
    ["25:00", null],
    ["abc", null],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeTime(input)).toBe(expected);
  });
});
