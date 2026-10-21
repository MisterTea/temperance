import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyState, type History } from "../src/lib/model";
import { localDaySpan, localDayStart, localTime } from "../src/lib/policy";
import { prune } from "../src/lib/service";

const zones = [
  "UTC",
  "America/Chicago",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
];

function row(id: string, at: number): History {
  return {
    id,
    at,
    device_id: "dev",
    profile_id: 1,
    domain: "example.com",
    blocked: false,
    reason: "",
    category: "other",
  };
}

describe("local day boundaries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TEMPERANCE_TIMEZONE;
  });

  for (const zone of zones)
    it(`matches localTime day-by-day in ${zone}, including DST`, () => {
      for (const day of ["2026-03-08", "2026-11-01", "2026-10-20"]) {
        const start = localDayStart(day, zone);
        expect(localTime(start, zone).day).toBe(day);
        expect(localTime(start - 1, zone).day < day).toBe(true);
        for (let at = start - 3600; at < start + 26 * 3600; at += 30) {
          expect(localTime(at, zone).day >= day).toBe(at >= start);
        }
      }
    });

  it("spans an inclusive local date range", () => {
    const [from, until] = localDaySpan(
      "2026-10-19",
      "2026-10-20",
      "America/Chicago",
    );
    expect(localTime(from, "America/Chicago").day).toBe("2026-10-19");
    expect(localTime(until - 1, "America/Chicago").day).toBe("2026-10-20");
    expect(localTime(until, "America/Chicago").day).toBe("2026-10-21");
  });
});

describe("prune", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TEMPERANCE_TIMEZONE;
  });

  it("drops history and usage before the retention day", () => {
    process.env.TEMPERANCE_TIMEZONE = "America/Chicago";
    const at = Date.parse("2026-11-02T18:00:00Z") / 1000;
    const state = emptyState();
    state.retention_days = 1;
    const cutoff = localTime(at - 86400, "America/Chicago").day;
    const earliest = localDayStart(cutoff, "America/Chicago");
    state.history = [row("old", earliest - 1), row("keep", earliest)];
    state.usage = { "2020-01-01": {}, [cutoff]: {} };
    state.rewards = [
      { id: "old", profile_id: 1, day: "2020-01-01", kind: "extra_time" },
      { id: "keep", profile_id: 1, day: cutoff, kind: "extra_time" },
    ];
    prune(state, at);
    expect(state.history.map((h) => h.id)).toEqual(["keep"]);
    expect(state.usage["2020-01-01"]).toBeUndefined();
    expect(state.usage[cutoff]).toEqual({});
    expect(state.rewards.map((r) => r.id)).toEqual(["keep"]);
  });

  it("caps a full history without building a formatter per row", () => {
    process.env.TEMPERANCE_TIMEZONE = "America/Chicago";
    const at = Date.parse("2026-10-20T18:00:00Z") / 1000;
    const state = emptyState();
    state.history = Array.from({ length: 20001 }, (_, i) => row(String(i), at - i));
    const Original = Intl.DateTimeFormat;
    let created = 0;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ) {
      created++;
      return new Original(locales, options);
    });
    prune(state, at);
    expect(state.history).toHaveLength(20000);
    expect(state.history[0].id).toBe("1");
    expect(created).toBeLessThan(40);
  });
});
