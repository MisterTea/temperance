export type UsageDay = {
  day: string;
  profiles: Record<string, Record<string, number>>;
};

/** A domain is left off the pie when it is under this share of domain minutes. */
export const DOMAIN_MIN_SHARE = 0.05;

export function eachDay(start: string, end: string) {
  const days: string[] = [];
  const cursor = new Date(start + "T12:00:00Z");
  while (cursor.toISOString().slice(0, 10) <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Family total for every day in the period, including days with no activity. */
export function dailyTotals(days: UsageDay[], start: string, end: string) {
  const byDay = new Map(days.map((day) => [day.day, day]));
  return eachDay(start, end).map((day) => ({
    day,
    minutes: Object.values(byDay.get(day)?.profiles ?? {}).reduce(
      (sum, buckets) => sum + (buckets.total ?? 0),
      0,
    ),
  }));
}

/** Site minutes in the period, without domains that are only a sliver of the pie. */
export function domainShares(days: UsageDay[]) {
  const totals = new Map<string, number>();
  for (const day of days)
    for (const buckets of Object.values(day.profiles))
      for (const [bucket, minutes] of Object.entries(buckets))
        if (bucket.startsWith("site:") && minutes > 0)
          totals.set(
            bucket.slice(5),
            (totals.get(bucket.slice(5)) ?? 0) + minutes,
          );
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sum = ranked.reduce((total, [, minutes]) => total + minutes, 0);
  if (!sum) return { slices: [], omitted: 0 };
  const kept = ranked.filter(([, minutes]) => minutes / sum >= DOMAIN_MIN_SHARE);
  const chosen = kept.length ? kept : ranked.slice(0, 1);
  return {
    slices: chosen.map(([name, minutes]) => ({ name, minutes })),
    omitted: ranked.length - chosen.length,
  };
}
