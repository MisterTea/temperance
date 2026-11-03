import { describe, expect, it } from "vitest";
import {
  hourlyTotals,
  domainShares,
  zonedNow,
  type UsageDay,
} from "../src/lib/usage-charts";

const days: UsageDay[] = [
  {
    day: "2026-10-11",
    profiles: {
      "1": {
        total: 100,
        "site:youtube.com": 80,
        "site:netflix.com": 13,
        "site:tiny.example": 4,
        "site:also.example": 3,
        "category:video": 93,
      },
    },
  },
];

describe("usage charts", () => {
  it("reads the current hour in the household timezone", () => {
    const at = new Date("2026-10-11T18:00:00Z");
    expect(zonedNow("America/Chicago", at)).toEqual({
      day: "2026-10-11",
      hour: 13,
    });
    expect(zonedNow("UTC", at)).toEqual({ day: "2026-10-11", hour: 18 });
    expect(zonedNow("America/Chicago", new Date("2026-10-11T05:00:00Z"))).toEqual({
      day: "2026-10-11",
      hour: 0,
    });
  });

  it("fills the period with an hourly family total through the current hour", () => {
    const hours = Array.from({ length: 24 }, (_, hour) =>
      hour === 13 ? 100 : 0,
    );
    const series = hourlyTotals(
      [{ ...days[0], hours }],
      "2026-10-10",
      "2026-10-11",
      { day: "2026-10-11", hour: 14 },
    );
    expect(series).toHaveLength(24 + 15);
    expect(series[0]).toEqual({ hour: "2026-10-10T00", minutes: 0 });
    expect(series[13 + 24]).toEqual({ hour: "2026-10-11T13", minutes: 100 });
    expect(series.at(-1)).toEqual({ hour: "2026-10-11T14", minutes: 0 });
    expect(hourlyTotals(days, "2026-10-11", "2026-10-11")).toHaveLength(24);
  });

  it("keeps small domains when they fit within the top five", () => {
    expect(domainShares(days)).toEqual({
      slices: [
        { name: "youtube.com", minutes: 80 },
        { name: "netflix.com", minutes: 13 },
        { name: "tiny.example", minutes: 4 },
        { name: "also.example", minutes: 3 },
      ],
      grouped: 0,
    });
  });

  it("groups the long tail into Other without losing domain minutes", () => {
    const buckets = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `site:domain-${String(i).padStart(2, "0")}.example`,
        1,
      ]),
    );
    const { slices, grouped } = domainShares([
      { day: "2026-10-11", profiles: { "1": buckets } },
    ]);
    expect(slices).toEqual([
      ...Array.from({ length: 5 }, (_, i) => ({
        name: `domain-0${i}.example`,
        minutes: 1,
      })),
      { name: "Other", minutes: 25 },
    ]);
    expect(grouped).toBe(25);
    expect(slices.reduce((sum, slice) => sum + slice.minutes, 0)).toBe(30);
  });

  it("ranks aggregated minutes across profiles and days", () => {
    expect(
      domainShares([
        ...days,
        {
          day: "2026-10-12",
          profiles: {
            "2": { "site:tiny.example": 100, "site:youtube.com": 5 },
          },
        },
      ]).slices[0],
    ).toEqual({ name: "tiny.example", minutes: 104 });
  });

  it("has no Other slice for exactly five domains or empty usage", () => {
    const five = {
      ...days[0],
      profiles: { "1": { ...days[0].profiles["1"], "site:fifth.example": 1 } },
    };
    expect(domainShares([five]).slices).toHaveLength(5);
    expect(domainShares([five]).grouped).toBe(0);
    expect(domainShares([])).toEqual({ slices: [], grouped: 0 });
  });
});
