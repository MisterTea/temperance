import { describe, expect, it } from "vitest";
import {
  dailyTotals,
  domainShares,
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
  it("fills the period with a daily family total", () => {
    expect(dailyTotals(days, "2026-10-09", "2026-10-11")).toEqual([
      { day: "2026-10-09", minutes: 0 },
      { day: "2026-10-10", minutes: 0 },
      { day: "2026-10-11", minutes: 100 },
    ]);
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
