import { describe, expect, it } from "vitest";
import { backoffRemainingMs, dueTimedTrigger, RETRY_BACKOFF_MS } from "../src/schedule.js";

const at = (iso: string) => new Date(iso);

describe("dueTimedTrigger", () => {
  it("fires cron within the 2-minute grace window when last run predates the occurrence", () => {
    // hourly cron; now = 10:01, previous occurrence 10:00
    const now = at("2026-07-13T10:01:00");
    expect(dueTimedTrigger({ cronExpr: "0 * * * *" }, "2026-07-13T09:30:00", now)).toBe("cron");
    // already ran after the occurrence → no fire
    expect(dueTimedTrigger({ cronExpr: "0 * * * *" }, "2026-07-13T10:00:30", now)).toBe(null);
    // outside grace (10:05) → no fire
    expect(dueTimedTrigger({ cronExpr: "0 * * * *" }, "2026-07-13T09:30:00", at("2026-07-13T10:05:00"))).toBe(null);
  });

  it("failed runs don't advance the cycle (anchor is lastRunAt)", () => {
    // lastRunAt still yesterday even though attempts happened — still due
    const now = at("2026-07-13T10:01:00");
    expect(dueTimedTrigger({ cronExpr: "0 * * * *" }, "2026-07-12T10:00:00", now)).toBe("cron");
  });

  it("windows fire once per day inside the band", () => {
    const triggers = { windows: [{ startTime: "09:00", endTime: "10:00" }] };
    const inBand = at("2026-07-13T09:30:00");
    expect(dueTimedTrigger(triggers, "2026-07-12T09:15:00", inBand)).toBe("window"); // ran yesterday
    expect(dueTimedTrigger(triggers, "2026-07-13T09:10:00", inBand)).toBe(null); // already ran today
    expect(dueTimedTrigger(triggers, null, at("2026-07-13T11:00:00"))).toBe(null); // outside band
  });

  it("invalid cron is ignored rather than throwing", () => {
    expect(dueTimedTrigger({ cronExpr: "not a cron" }, null, new Date())).toBe(null);
  });
});

describe("backoffRemainingMs", () => {
  it("counts down from the last attempt", () => {
    const now = Date.now();
    expect(backoffRemainingMs(null, now)).toBe(0);
    expect(backoffRemainingMs(new Date(now - 60_000).toISOString(), now)).toBe(RETRY_BACKOFF_MS - 60_000);
    expect(backoffRemainingMs(new Date(now - RETRY_BACKOFF_MS - 1).toISOString(), now)).toBe(0);
  });
});
