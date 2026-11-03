export type UsageDay = {
  day: string;
  profiles: Record<string, Record<string, number>>;
  /** Family total minutes in each local hour, index 0 through 23. */
  hours?: number[];
};

/** Show this many named domains, followed by an aggregate of the rest. */
export const DOMAIN_SLICE_LIMIT = 5;

export function eachDay(start: string, end: string) {
  const days: string[] = [];
  const cursor = new Date(start + "T12:00:00Z");
  while (cursor.toISOString().slice(0, 10) <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Calendar day (`YYYY-MM-DD`) and hour in an IANA timezone. */
export function zonedNow(zone: string, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(map.hour);
  return {
    day: `${map.year}-${map.month}-${map.day}`,
    hour: hour === 24 ? 0 : hour,
  };
}

/**
 * Family total for every local hour in the period, including hours with no
 * activity. The current local day stops at `now.hour` so later hours, which
 * have not happened yet, are left off the line.
 */
export function hourlyTotals(
  days: UsageDay[],
  start: string,
  end: string,
  now?: { day: string; hour: number },
) {
  const byDay = new Map(days.map((day) => [day.day, day.hours ?? []]));
  const points: { hour: string; minutes: number }[] = [];
  for (const day of eachDay(start, end)) {
    const counts = byDay.get(day) ?? [];
    const last =
      now && day === now.day ? Math.min(23, Math.max(0, now.hour)) : 23;
    for (let hour = 0; hour <= last; hour++)
      points.push({
        hour: `${day}T${String(hour).padStart(2, "0")}`,
        minutes: counts[hour] ?? 0,
      });
  }
  return points;
}

/** Site minutes in the period, keeping every minute in the pie. */
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
  const ranked = [...totals.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const chosen = ranked.slice(0, DOMAIN_SLICE_LIMIT);
  const rest = ranked.slice(DOMAIN_SLICE_LIMIT);
  const slices = chosen.map(([name, minutes]) => ({ name, minutes }));
  if (rest.length)
    slices.push({
      name: "Other",
      minutes: rest.reduce((sum, [, minutes]) => sum + minutes, 0),
    });
  return {
    slices,
    grouped: rest.length,
  };
}
