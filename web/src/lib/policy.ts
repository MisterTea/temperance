import { z } from "zod";

export const DAYS = [0, 1, 2, 3, 4, 5, 6];
export const CATALOG = {
  social: {
    name: "Social media",
    domains: [
      "facebook.com",
      "instagram.com",
      "tiktok.com",
      "reddit.com",
      "x.com",
      "snapchat.com",
    ],
  },
  video: {
    name: "Video & streaming",
    domains: [
      "youtube.com",
      "youtu.be",
      "netflix.com",
      "twitch.tv",
      "disneyplus.com",
      "hulu.com",
    ],
  },
  gaming: {
    name: "Gaming",
    domains: [
      "roblox.com",
      "epicgames.com",
      "steampowered.com",
      "minecraft.net",
    ],
  },
  adult: {
    name: "Adult content",
    domains: ["pornhub.com", "xvideos.com", "xhamster.com"],
  },
  gambling: {
    name: "Gambling",
    domains: ["bet365.com", "draftkings.com", "fanduel.com"],
  },
  education: {
    name: "Education",
    domains: [
      "khanacademy.org",
      "wikipedia.org",
      "duolingo.com",
      "classroom.google.com",
      "scratch.mit.edu",
    ],
  },
  shopping: {
    name: "Shopping",
    domains: ["amazon.com", "ebay.com", "temu.com"],
  },
  news: { name: "News", domains: ["bbc.com", "cnn.com", "nytimes.com"] },
  ads: {
    name: "Ads & trackers",
    domains: [
      "doubleclick.net",
      "googlesyndication.com",
      "googleadservices.com",
    ],
  },
  proxy: {
    name: "VPN & proxy services",
    domains: ["protonvpn.com", "nordvpn.com", "expressvpn.com", "hide.me"],
  },
  malware: { name: "Malware feed", domains: [] as string[] },
};
export type Category = keyof typeof CATALOG;
export const PRESETS: Record<string, Category[]> = {
  kid: ["adult", "gambling", "proxy", "malware"],
  teen: ["adult", "gambling", "malware"],
  adult: ["malware"],
  none: [],
};
export function normalizeDomain(input: string): string {
  const raw = input.trim().toLowerCase().replace(/\.$/, "");
  if (!raw || /[\s/:@?#*]/.test(raw))
    throw new Error("Use a domain without a URL or wildcard");
  const result = new URL("https://" + raw).hostname;
  if (
    result.length > 253 ||
    result
      .split(".")
      .some(
        (p) =>
          !p || p.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p),
      )
  )
    throw new Error("Invalid domain");
  return result;
}
const domain = z.string().transform(normalizeDomain);
const domains = z.array(domain).max(500).default([]);
const days = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .max(7)
  .default(DAYS);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const minutes = z.number().int().min(0).max(1440);
const weekday = z.record(z.string().regex(/^[0-6]$/), minutes).default({});
export const windowSchema = z
  .object({
    id: z.string().min(1).max(60),
    name: z.string().trim().min(1).max(60),
    mode: z.enum(["off", "focus"]),
    start: time,
    end: time,
    days,
    allow: domains,
    allowed_categories: z
      .array(z.enum(Object.keys(CATALOG) as [Category, ...Category[]]))
      .default([]),
  })
  .refine((v) => v.start !== v.end, "Window start/end must differ");
/** A named group of apps/sites that draw down one shared daily budget. */
export const appLimitSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(60),
  domains: z.array(domain).min(1).max(100),
  minutes: minutes.refine((n) => n > 0, "Set a group limit above 0 minutes"),
});
export type AppLimit = z.output<typeof appLimitSchema>;
export const profileSchema = z
  .object({
    id: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(60),
    avatar: z.string().max(12).default("◒"),
    filter_level: z.enum(["kid", "teen", "adult", "none"]).default("adult"),
    managed: z.boolean().default(true),
    paused: z.boolean().default(false),
    limit: minutes.default(0),
    weekday_limits: weekday,
    categories: z
      .array(z.enum(Object.keys(CATALOG) as [Category, ...Category[]]))
      .default([]),
    allow: domains,
    deny: domains,
    unmanaged: domains,
    allow_only: z.boolean().default(false),
    safe_search: z.boolean().default(false),
    youtube_restricted: z.boolean().default(false),
    bedtime: z
      .object({
        enabled: z.boolean().default(true),
        start: z.union([time, z.literal("")]).default(""),
        end: z.union([time, z.literal("")]).default(""),
        days,
      })
      .default({ enabled: true, start: "", end: "", days: DAYS }),
    schedules: z.array(windowSchema).max(20).default([]),
    category_limits: z
      .partialRecord(
        z.enum(Object.keys(CATALOG) as [Category, ...Category[]]),
        minutes,
      )
      .default({}),
    site_limits: z
      .record(z.string(), minutes)
      .default({})
      .transform((v) =>
        Object.fromEntries(
          Object.entries(v).map(([d, n]) => [normalizeDomain(d), n]),
        ),
      ),
    app_limits: z.array(appLimitSchema).max(20).default([]),
  })
  .superRefine((p, ctx) => {
    if (
      Boolean(p.bedtime.start) !== Boolean(p.bedtime.end) ||
      (p.bedtime.start && p.bedtime.start === p.bedtime.end)
    )
      ctx.addIssue({
        code: "custom",
        path: ["bedtime"],
        message: "Set two different bedtime times, or leave both empty",
      });
    if (new Set(p.schedules.map((s) => s.id)).size !== p.schedules.length)
      ctx.addIssue({
        code: "custom",
        path: ["schedules"],
        message: "Schedule IDs must be unique",
      });
    if (new Set(p.app_limits.map((g) => g.id)).size !== p.app_limits.length)
      ctx.addIssue({
        code: "custom",
        path: ["app_limits"],
        message: "App group IDs must be unique",
      });
  });
/** Usage buckets whose limits apply to `host`, in evaluation order. */
export function limitScopes(p: Profile, host: string, category: string) {
  return [
    "category:" + category,
    ...Object.keys(p.site_limits)
      .filter((d) => matches(host, d))
      .map((d) => "site:" + d),
    ...(p.app_limits ?? [])
      .filter((g) => g.domains.some((d) => matches(host, d)))
      .map((g) => "group:" + g.id),
  ];
}
export type Profile = z.output<typeof profileSchema> & { id: number };
export interface Reward {
  id: string;
  profile_id: number;
  day: string;
  kind: "extra_time" | "late_bedtime" | "skip_window";
  minutes?: number;
  bedtime?: string;
  window_id?: string;
  scope?: string;
}
export interface Usage {
  [day: string]: { [profile: string]: { [bucket: string]: number[] } };
}
export function localTime(at: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at * 1000));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const day = `${map.year}-${map.month}-${map.day}`,
    clock = `${map.hour}:${map.minute}`;
  return { day, clock, weekday: new Date(day + "T12:00:00Z").getUTCDay() };
}
export function used(usage: Usage, day: string, id: number, bucket = "total") {
  return usage[day]?.[id]?.[bucket]?.length ?? 0;
}
export function inWindow(
  window: { start: string; end: string; days: number[] },
  at: number,
  zone: string,
) {
  if (!window.start || !window.end) return false;
  const local = localTime(at, zone);
  if (window.start < window.end)
    return (
      window.days.includes(local.weekday) &&
      window.start <= local.clock &&
      local.clock < window.end
    );
  if (local.clock >= window.start) return window.days.includes(local.weekday);
  return (
    local.clock < window.end && window.days.includes((local.weekday + 6) % 7)
  );
}
export function matches(host: string, rule: string) {
  return host === rule || host.endsWith("." + rule);
}
export function classify(host: string, extra: Record<string, string[]> = {}) {
  const candidates = Object.entries({
    ...Object.fromEntries(
      Object.entries(CATALOG).map(([k, v]) => [k, v.domains]),
    ),
    ...extra,
  });
  let category = "other",
    longest = 0;
  for (const [key, list] of candidates)
    for (const d of list)
      if (d.length > longest && matches(host, d)) {
        category = key;
        longest = d.length;
      }
  return category;
}
export function dailyLimit(
  p: Profile,
  at: number,
  zone: string,
  rewards: Reward[],
  scope = "total",
) {
  const day = localTime(at, zone);
  const base =
    scope === "total"
      ? (p.weekday_limits[String(day.weekday)] ?? p.limit)
      : scope.startsWith("category:")
        ? (p.category_limits[scope.slice(9) as Category] ?? 0)
        : scope.startsWith("group:")
          ? ((p.app_limits ?? []).find((g) => g.id === scope.slice(6))
              ?.minutes ?? 0)
          : (p.site_limits[scope.slice(5)] ?? 0);
  if (base === 0) return 0;
  return Math.min(
    1440,
    base +
      rewards
        .filter(
          (r) =>
            r.profile_id === p.id &&
            r.day === day.day &&
            r.kind === "extra_time" &&
            (r.scope ?? "total") === scope,
        )
        .reduce((sum, r) => sum + (r.minutes ?? 0), 0),
  );
}
export function activeWindows(
  p: Profile,
  at: number,
  zone: string,
  rewards: Reward[],
) {
  const day = localTime(at, zone).day;
  return p.schedules.filter(
    (s) =>
      inWindow(s, at, zone) &&
      !rewards.some(
        (r) =>
          r.profile_id === p.id &&
          r.day === day &&
          r.kind === "skip_window" &&
          r.window_id === s.id,
      ),
  );
}
/** The day a bedtime that runs past midnight started on, so that a late
 * bedtime given in the evening still counts after midnight. */
export function bedtimeNight(
  p: Pick<Profile, "bedtime">,
  at: number,
  zone: string,
) {
  const { start, end } = p.bedtime;
  const local = localTime(at, zone);
  return start > end && local.clock < end
    ? localTime(at - 86400, zone).day
    : local.day;
}
export function accessReason(
  p: Profile,
  at: number,
  zone: string,
  usage: Usage,
  rewards: Reward[],
  householdPaused = false,
) {
  if (!p.managed) return "allowed";
  if (householdPaused) return "household pause";
  if (p.paused) return "paused";
  const day = localTime(at, zone).day;
  const night = bedtimeNight(p, at, zone);
  const bedtimeReward = rewards
    .filter(
      (r) =>
        r.profile_id === p.id && r.day === night && r.kind === "late_bedtime",
    )
    .at(-1);
  if (
    p.bedtime.enabled !== false &&
    inWindow(
      { ...p.bedtime, start: bedtimeReward?.bedtime ?? p.bedtime.start },
      at,
      zone,
    )
  )
    return "bedtime";
  if (activeWindows(p, at, zone, rewards).some((s) => s.mode === "off"))
    return "off time";
  const limit = dailyLimit(p, at, zone, rewards);
  if (p.filter_level !== "none" && limit > 0 && used(usage, day, p.id) >= limit)
    return "daily limit";
  return "allowed";
}
export function domainReason(
  p: Profile,
  host: string,
  at: number,
  zone: string,
  usage: Usage,
  rewards: Reward[],
  householdPaused = false,
  extra: Record<string, string[]> = {},
) {
  if (!p.managed || p.unmanaged.some((d) => matches(host, d)))
    return "unmanaged";
  const reason = accessReason(p, at, zone, usage, rewards, householdPaused);
  if (reason !== "allowed") return reason;
  const focuses = activeWindows(p, at, zone, rewards).filter(
    (s) => s.mode === "focus",
  );
  const category = classify(host, extra);
  if (
    focuses.some(
      (s) =>
        !s.allow.some((d) => matches(host, d)) &&
        !s.allowed_categories.includes(category as Category),
    )
  )
    return "focus time";
  if (p.filter_level === "none") return "allowed";
  for (const scope of limitScopes(p, host, category)) {
    const limit = dailyLimit(p, at, zone, rewards, scope);
    if (limit > 0 && used(usage, localTime(at, zone).day, p.id, scope) >= limit)
      return "limit " + scope;
  }
  if (p.allow.some((d) => matches(host, d))) return "allowed";
  if (p.deny.some((d) => matches(host, d))) return "custom rule";
  if (p.allow_only) return "allow-list only";
  if (
    [...PRESETS[p.filter_level], ...p.categories].includes(category as Category)
  )
    return category;
  return "allowed";
}
