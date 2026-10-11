//! Policy semantics shared with the Next.js service and the Python gateway.
//! `specs/policy-cases.json` is the contract all three implementations run.
use std::collections::HashMap;

use chrono::{DateTime, Datelike, TimeZone, Timelike};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

use crate::CoreError;

pub const CATALOG: &[(&str, &[&str])] = &[
    (
        "social",
        &[
            "facebook.com",
            "instagram.com",
            "tiktok.com",
            "reddit.com",
            "x.com",
            "snapchat.com",
        ],
    ),
    (
        "video",
        &[
            "youtube.com",
            "youtu.be",
            "netflix.com",
            "twitch.tv",
            "disneyplus.com",
            "hulu.com",
        ],
    ),
    (
        "gaming",
        &[
            "roblox.com",
            "epicgames.com",
            "steampowered.com",
            "minecraft.net",
        ],
    ),
    ("adult", &["pornhub.com", "xvideos.com", "xhamster.com"]),
    ("gambling", &["bet365.com", "draftkings.com", "fanduel.com"]),
    (
        "education",
        &[
            "khanacademy.org",
            "wikipedia.org",
            "duolingo.com",
            "classroom.google.com",
            "scratch.mit.edu",
        ],
    ),
    ("shopping", &["amazon.com", "ebay.com", "temu.com"]),
    ("news", &["bbc.com", "cnn.com", "nytimes.com"]),
    (
        "ads",
        &[
            "doubleclick.net",
            "googlesyndication.com",
            "googleadservices.com",
        ],
    ),
    (
        "proxy",
        &["protonvpn.com", "nordvpn.com", "expressvpn.com", "hide.me"],
    ),
    ("malware", &[]),
];

fn preset(level: &str) -> &'static [&'static str] {
    match level {
        "kid" => &["adult", "gambling", "proxy", "malware"],
        "teen" => &["adult", "gambling", "malware"],
        "adult" => &["malware"],
        _ => &[],
    }
}

fn all_days() -> Vec<u8> {
    (0..7).collect()
}
fn adult() -> String {
    "adult".into()
}
fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct Bedtime {
    #[serde(default)]
    pub start: String,
    #[serde(default)]
    pub end: String,
    #[serde(default = "all_days")]
    pub days: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct Window {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub mode: String,
    pub start: String,
    pub end: String,
    #[serde(default = "all_days")]
    pub days: Vec<u8>,
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub allowed_categories: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct Reward {
    #[serde(default)]
    pub id: String,
    pub kind: String,
    pub day: String,
    #[serde(default)]
    pub minutes: Option<u32>,
    #[serde(default)]
    pub bedtime: Option<String>,
    #[serde(default)]
    pub window_id: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

/// A named group of apps/sites that share one daily budget (usage bucket `group:<id>`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct AppLimit {
    pub id: String,
    pub name: String,
    pub domains: Vec<String>,
    pub minutes: u32,
}

/// The effective profile a device receives in `/v1/device/state`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, uniffi::Record)]
pub struct Profile {
    #[serde(default)]
    pub id: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default = "adult")]
    pub filter_level: String,
    #[serde(default = "yes")]
    pub managed: bool,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub limit: u32,
    #[serde(default)]
    pub weekday_limits: HashMap<String, u32>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
    #[serde(default)]
    pub unmanaged: Vec<String>,
    #[serde(default)]
    pub allow_only: bool,
    #[serde(default)]
    pub safe_search: bool,
    #[serde(default)]
    pub youtube_restricted: bool,
    #[serde(default)]
    pub bedtime: Bedtime,
    #[serde(default)]
    pub schedules: Vec<Window>,
    #[serde(default)]
    pub category_limits: HashMap<String, u32>,
    #[serde(default)]
    pub site_limits: HashMap<String, u32>,
    #[serde(default)]
    pub app_limits: Vec<AppLimit>,
    #[serde(default)]
    pub used: u32,
    #[serde(default)]
    pub bucket_usage: HashMap<String, u32>,
    #[serde(default)]
    pub rewards: Vec<Reward>,
    #[serde(default)]
    pub effective_limit: u32,
    #[serde(default)]
    pub timezone: Option<String>,
}

impl Default for Profile {
    fn default() -> Self {
        serde_json::from_str("{}").expect("defaults")
    }
}

pub struct Local {
    pub day: String,
    pub clock: String,
    pub weekday: u8,
}

pub fn zone(name: &str) -> Result<Tz, CoreError> {
    name.parse::<Tz>().map_err(|_| CoreError::Invalid {
        detail: format!("Unknown timezone {name}"),
    })
}

pub fn local(at: i64, tz: Tz) -> Local {
    let value: DateTime<Tz> = tz.timestamp_opt(at, 0).single().unwrap_or_else(|| {
        tz.from_utc_datetime(
            &DateTime::from_timestamp(at, 0)
                .unwrap_or_default()
                .naive_utc(),
        )
    });
    Local {
        day: value.format("%Y-%m-%d").to_string(),
        clock: format!("{:02}:{:02}", value.hour(), value.minute()),
        weekday: value.weekday().num_days_from_sunday() as u8,
    }
}

/// Exact-domain or subdomain match; `evilschool.test` never matches `school.test`.
#[uniffi::export]
pub fn domain_matches(host: String, rule: String) -> bool {
    matches(&host, &rule)
}
pub fn matches(host: &str, rule: &str) -> bool {
    host == rule
        || (host.len() > rule.len()
            && host.ends_with(rule)
            && host.as_bytes()[host.len() - rule.len() - 1] == b'.')
}

fn in_window(start: &str, end: &str, days: &[u8], at: i64, tz: Tz) -> bool {
    if start.is_empty() || end.is_empty() {
        return false;
    }
    let l = local(at, tz);
    if start < end {
        return days.contains(&l.weekday) && start <= l.clock.as_str() && l.clock.as_str() < end;
    }
    (days.contains(&l.weekday) && l.clock.as_str() >= start)
        || (days.contains(&((l.weekday + 6) % 7)) && l.clock.as_str() < end)
}

pub fn classify(host: &str, extra: &HashMap<String, Vec<String>>) -> String {
    let mut best = ("other".to_string(), 0usize);
    let mut consider = |name: &str, domain: &str| {
        if domain.len() > best.1 && matches(host, domain) {
            best = (name.to_string(), domain.len());
        }
    };
    for (name, domains) in CATALOG {
        if extra.contains_key(*name) {
            continue;
        }
        for d in *domains {
            consider(name, d);
        }
    }
    for (name, domains) in extra {
        for d in domains {
            consider(name, d);
        }
    }
    best.0
}

fn todays_rewards(p: &Profile, at: i64, tz: Tz) -> impl Iterator<Item = &Reward> {
    let day = local(at, tz).day;
    p.rewards.iter().filter(move |r| r.day == day)
}

pub fn daily_limit(p: &Profile, at: i64, tz: Tz, scope: &str) -> u32 {
    let weekday = local(at, tz).weekday;
    let base = if scope == "total" {
        *p.weekday_limits
            .get(&weekday.to_string())
            .unwrap_or(&p.limit)
    } else if let Some(category) = scope.strip_prefix("category:") {
        *p.category_limits.get(category).unwrap_or(&0)
    } else if let Some(group) = scope.strip_prefix("group:") {
        p.app_limits
            .iter()
            .find(|g| g.id == group)
            .map_or(0, |g| g.minutes)
    } else {
        *p.site_limits
            .get(scope.trim_start_matches("site:"))
            .unwrap_or(&0)
    };
    if base == 0 {
        return 0;
    }
    let bonus: u32 = todays_rewards(p, at, tz)
        .filter(|r| r.kind == "extra_time" && r.scope.as_deref().unwrap_or("total") == scope)
        .map(|r| r.minutes.unwrap_or(0))
        .sum();
    (base + bonus).min(1440)
}

pub fn active_windows(p: &Profile, at: i64, tz: Tz) -> Vec<Window> {
    let skipped: Vec<String> = todays_rewards(p, at, tz)
        .filter(|r| r.kind == "skip_window")
        .filter_map(|r| r.window_id.clone())
        .collect();
    p.schedules
        .iter()
        .filter(|w| !skipped.contains(&w.id) && in_window(&w.start, &w.end, &w.days, at, tz))
        .cloned()
        .collect()
}

fn bedtime_start(p: &Profile, at: i64, tz: Tz) -> String {
    todays_rewards(p, at, tz)
        .filter(|r| r.kind == "late_bedtime")
        .filter_map(|r| r.bedtime.clone())
        .last()
        .unwrap_or_else(|| p.bedtime.start.clone())
}

pub fn access_reason_at(p: &Profile, at: i64, tz: Tz, household_paused: bool) -> String {
    if !p.managed {
        return "allowed".into();
    }
    if household_paused {
        return "household pause".into();
    }
    if p.paused {
        return "paused".into();
    }
    if in_window(
        &bedtime_start(p, at, tz),
        &p.bedtime.end,
        &p.bedtime.days,
        at,
        tz,
    ) {
        return "bedtime".into();
    }
    if active_windows(p, at, tz).iter().any(|w| w.mode == "off") {
        return "off time".into();
    }
    let limit = daily_limit(p, at, tz, "total");
    if p.filter_level != "none" && limit > 0 && p.used >= limit {
        return "daily limit".into();
    }
    "allowed".into()
}

pub fn domain_reason_at(
    p: &Profile,
    host: &str,
    at: i64,
    tz: Tz,
    household_paused: bool,
    extra: &HashMap<String, Vec<String>>,
) -> String {
    if !p.managed || p.unmanaged.iter().any(|d| matches(host, d)) {
        return "unmanaged".into();
    }
    let reason = access_reason_at(p, at, tz, household_paused);
    if reason != "allowed" {
        return reason;
    }
    let category = classify(host, extra);
    let focused = active_windows(p, at, tz)
        .into_iter()
        .filter(|w| w.mode == "focus")
        .any(|w| {
            !w.allow.iter().any(|d| matches(host, d)) && !w.allowed_categories.contains(&category)
        });
    if focused {
        return "focus time".into();
    }
    if p.filter_level == "none" {
        return "allowed".into();
    }
    let mut scopes = vec![format!("category:{category}")];
    let mut sites: Vec<&String> = p.site_limits.keys().filter(|d| matches(host, d)).collect();
    sites.sort();
    scopes.extend(sites.into_iter().map(|d| format!("site:{d}")));
    scopes.extend(
        p.app_limits
            .iter()
            .filter(|g| g.domains.iter().any(|d| matches(host, d)))
            .map(|g| format!("group:{}", g.id)),
    );
    for scope in scopes {
        let limit = daily_limit(p, at, tz, &scope);
        if limit > 0 && *p.bucket_usage.get(&scope).unwrap_or(&0) >= limit {
            return format!("limit {scope}");
        }
    }
    if p.allow.iter().any(|d| matches(host, d)) {
        return "allowed".into();
    }
    if p.deny.iter().any(|d| matches(host, d)) {
        return "custom rule".into();
    }
    if p.allow_only {
        return "allow-list only".into();
    }
    if preset(&p.filter_level).contains(&category.as_str()) || p.categories.contains(&category) {
        return category;
    }
    "allowed".into()
}

/// Why the whole profile is (or is not) allowed online at `at` (Unix seconds).
#[uniffi::export]
pub fn access_reason(
    profile: Profile,
    timezone: String,
    at: i64,
    household_paused: bool,
) -> Result<String, CoreError> {
    Ok(access_reason_at(
        &profile,
        at,
        zone(&timezone)?,
        household_paused,
    ))
}

/// Decision for a specific domain, including unmanaged exceptions and focus windows.
#[uniffi::export]
pub fn domain_reason(
    profile: Profile,
    host: String,
    timezone: String,
    at: i64,
    household_paused: bool,
) -> Result<String, CoreError> {
    Ok(domain_reason_at(
        &profile,
        &host,
        at,
        zone(&timezone)?,
        household_paused,
        &HashMap::new(),
    ))
}

/// Minutes until the next bedtime or schedule boundary, scanning one day ahead.
pub fn next_change(p: &Profile, at: i64, tz: Tz, household_paused: bool) -> Option<(i64, String)> {
    let now = access_reason_at(p, at, tz, household_paused);
    let start = at - at.rem_euclid(60);
    (1..=1440).map(|m| start + m * 60).find_map(|t| {
        let next = access_reason_at(p, t, tz, household_paused);
        (next != now && next != "daily limit").then_some(((t - at + 59) / 60, next))
    })
}
