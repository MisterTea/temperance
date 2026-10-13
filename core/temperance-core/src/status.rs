//! Child-facing status shown identically on every platform.
use crate::{api::DeviceState, policy, CoreError};

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct ChildStatus {
    /// Short headline such as "You're online" or "Bedtime".
    pub headline: String,
    /// One-sentence explanation of the current rule.
    pub detail: String,
    pub allowed: bool,
    pub used_minutes: u32,
    pub remaining_minutes: Option<u32>,
    /// e.g. "Bedtime starts in 25 min".
    pub next_change: Option<String>,
    pub pending_request: bool,
    pub can_request_time: bool,
}

fn headline(reason: &str) -> &'static str {
    match reason {
        "allowed" | "unmanaged" => "You're online",
        "household pause" | "paused" | "device pause" => "Internet paused",
        "bedtime" => "Bedtime",
        "off time" => "Off Time",
        "daily limit" => "Time's up for today",
        _ => "Limited right now",
    }
}

fn explain(reason: &str) -> String {
    match reason {
        "allowed" => "Your family's filters are active.".into(),
        "unmanaged" => "This device isn't managed by family rules.".into(),
        "household pause" => "A parent paused the internet for the whole family.".into(),
        "paused" => "A parent paused your profile.".into(),
        "device pause" => "A parent paused this device.".into(),
        "bedtime" => "The internet is resting until bedtime ends.".into(),
        "off time" => "A scheduled Off Time is in progress.".into(),
        "daily limit" => "You've used today's time. Ask a parent for more.".into(),
        other => format!("Restricted: {other}."),
    }
}

fn describe(reason: &str) -> &'static str {
    match reason {
        "allowed" => "Back online",
        "bedtime" => "Bedtime starts",
        "off time" => "Off Time starts",
        _ => "Rules change",
    }
}

#[uniffi::export]
pub fn child_status(state: DeviceState, now: i64) -> Result<ChildStatus, CoreError> {
    let reason = state.status.reason.clone();
    let p = &state.policy;
    let tz = policy::zone(p.timezone.as_deref().unwrap_or("UTC"))?;
    let household = reason == "household pause";
    let paused = matches!(
        reason.as_str(),
        "household pause" | "paused" | "device pause"
    );
    let next_change = if paused || reason == "unmanaged" {
        None
    } else {
        policy::next_change(p, now, tz, household).map(|(minutes, next)| {
            let when = if minutes >= 60 {
                format!("{}h {}m", minutes / 60, minutes % 60)
            } else {
                format!("{minutes} min")
            };
            format!("{} in {when}", describe(&next))
        })
    };
    let pending = state.requests.iter().any(|r| r.status == "pending");
    Ok(ChildStatus {
        headline: headline(&reason).into(),
        detail: explain(&reason),
        allowed: matches!(reason.as_str(), "allowed" | "unmanaged"),
        used_minutes: p.used,
        remaining_minutes: state.status.remaining_minutes,
        next_change,
        pending_request: pending,
        // Extra time doesn't lift a pause.
        can_request_time: !pending && !paused && reason != "unmanaged" && p.managed,
    })
}

fn minutes_until_restriction(state: &DeviceState, at: i64) -> Option<(i64, String)> {
    if state.status.reason != "allowed" || at <= 0 {
        return None;
    }
    let tz = policy::zone(state.policy.timezone.as_deref().unwrap_or("UTC")).ok()?;
    policy::next_change(&state.policy, at, tz, false).filter(|(_, next)| next != "allowed")
}

fn reward_message(r: &policy::Reward) -> String {
    match r.kind.as_str() {
        "extra_time" => format!(
            "A parent gave you {} extra minutes today",
            r.minutes.unwrap_or(0)
        ),
        "late_bedtime" => format!(
            "A parent moved bedtime to {} tonight",
            r.bedtime.as_deref().unwrap_or("later")
        ),
        "skip_window" => "A parent skipped a schedule for you today".into(),
        _ => "A parent sent you a reward".into(),
    }
}

/// Notifications to show the child when state changes between two refreshes:
/// 15 minutes left, limit reached, bedtime/Off Time starting soon, rewards,
/// and answered time requests. Each alert fires once on the transition.
#[uniffi::export]
pub fn child_alerts(previous: Option<DeviceState>, current: DeviceState, now: i64) -> Vec<String> {
    let Some(prev) = previous else { return vec![] };
    let mut alerts = vec![];
    let reason = current.status.reason.as_str();
    if reason == "daily limit" && prev.status.reason != "daily limit" {
        alerts.push("Time's up for today".to_string());
    }
    if let (Some(before), Some(left)) = (
        prev.status.remaining_minutes,
        current.status.remaining_minutes,
    ) {
        if before > 15 && (1..=15).contains(&left) && reason == "allowed" {
            alerts.push(format!("{left} minutes left today"));
        }
    }
    if let Some((minutes, next)) = minutes_until_restriction(&current, now) {
        let earlier =
            minutes_until_restriction(&prev, prev.status.observed_at).map_or(i64::MAX, |(m, _)| m);
        if minutes <= 15 && earlier > 15 {
            alerts.push(format!("{} in {minutes} min", describe(&next)));
        }
    }
    let answered: Vec<_> = current
        .requests
        .iter()
        .filter(|r| {
            r.status != "pending"
                && prev
                    .requests
                    .iter()
                    .any(|p| p.id == r.id && p.status == "pending")
        })
        .collect();
    for r in &current.policy.rewards {
        // An approved request arrives as extra time too; its own alert says so.
        let approval = r.kind == "extra_time"
            && answered
                .iter()
                .any(|a| a.status == "approved" && Some(a.minutes) == r.minutes);
        if !approval && !prev.policy.rewards.iter().any(|p| p.id == r.id) {
            alerts.push(reward_message(r));
        }
    }
    for r in answered {
        let verdict = if r.status == "approved" {
            "approved"
        } else {
            "declined"
        };
        alerts.push(format!(
            "Your request for {} minutes was {verdict}",
            r.minutes
        ));
    }
    alerts
}
