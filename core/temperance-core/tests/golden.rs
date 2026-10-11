use serde::Deserialize;
use temperance_core::{access_reason, domain_reason, Profile};

#[derive(Deserialize)]
struct Case {
    name: String,
    kind: String,
    at: String,
    zone: String,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    household_paused: bool,
    profile: serde_json::Value,
    expected: String,
}

#[test]
fn shared_policy_contract_matches_typescript_and_python() {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../specs/policy-cases.json"
    ))
    .unwrap();
    let cases: Vec<Case> = serde_json::from_str(&text).unwrap();
    assert!(cases.len() >= 12);
    for case in cases {
        let mut value = case.profile.clone();
        value["id"] = 1.into();
        let profile: Profile = serde_json::from_value(value).unwrap();
        let at = chrono::DateTime::parse_from_rfc3339(&case.at)
            .unwrap()
            .timestamp();
        let result = if case.kind == "domain" {
            domain_reason(
                profile,
                case.host.clone().unwrap(),
                case.zone.clone(),
                at,
                case.household_paused,
            )
        } else {
            access_reason(profile, case.zone.clone(), at, case.household_paused)
        }
        .unwrap();
        assert_eq!(result, case.expected, "{}", case.name);
    }
}
