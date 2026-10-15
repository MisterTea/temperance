import { describe, expect, it } from "vitest";
import { dailyTotals, domainShares, type UsageDay } from "../src/lib/usage-charts";

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

  it("leaves domains under 5% off the pie", () => {
    expect(domainShares(days)).toEqual({
      slices: [
        { name: "youtube.com", minutes: 80 },
        { name: "netflix.com", minutes: 13 },
      ],
      omitted: 2,
    });
  });
});
