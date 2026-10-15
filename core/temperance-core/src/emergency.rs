//! Offline emergency access. Never receives a server token or stores a password.
use crate::Identity;
use ring::pbkdf2;
use std::num::NonZeroU32;

#[derive(Clone, Debug, uniffi::Record)]
pub struct EmergencyUnlockResult {
    pub identity: Identity,
    pub unlocked: bool,
    pub message: String,
}

fn decode_hex(text: &str, length: usize) -> Option<Vec<u8>> {
    if text.len() != length * 2 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..length)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

fn matches(password: &str, verifier: &str) -> bool {
    let parts: Vec<_> = verifier.split('$').collect();
    if parts.len() != 4
        || parts[0] != "pbkdf2-sha256"
        || parts[1] != "600000"
        || password.len() > 4096
    {
        return false;
    }
    let (Some(salt), Some(expected)) = (decode_hex(parts[2], 16), decode_hex(parts[3], 32)) else {
        return false;
    };
    let input = format!("Temperance emergency VPN unlock v1\0{password}");
    pbkdf2::verify(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(600_000).unwrap(),
        &salt,
        input.as_bytes(),
        &expected,
    )
    .is_ok()
}

/// Save the returned identity before disabling the OS VPN. Wrong attempts are
/// also saved, enforcing a 30-second cooldown across app/process restarts.
#[uniffi::export]
pub fn emergency_unlock(
    mut identity: Identity,
    password: String,
    now: i64,
) -> EmergencyUnlockResult {
    let verifier = identity
        .state
        .as_ref()
        .and_then(|s| s.emergency_unlock.as_deref());
    let (unlocked, message) = if now < identity.unlock_retry_at {
        (false, "Wait 30 seconds between password attempts.")
    } else if let Some(verifier) = verifier {
        if matches(&password, verifier) {
            identity.emergency_disabled = true;
            identity.unlock_retry_at = 0;
            (
                true,
                "VPN turned off by an admin. Protection is off until you turn the VPN back on.",
            )
        } else {
            identity.unlock_retry_at = now.saturating_add(30);
            (
                false,
                "Incorrect household admin password. Wait 30 seconds and try again.",
            )
        }
    } else {
        (false, "Emergency unlock is not ready. Update this app and sync with the server once while it is available.")
    };
    EmergencyUnlockResult {
        identity,
        unlocked,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../tests/fixtures/emergency.json")).unwrap()
    }
    #[test]
    fn node_generated_verifier_requires_the_exact_password_and_fixed_parameters() {
        let fixture = fixture();
        let verifier = fixture["verifier"].as_str().unwrap();
        assert!(matches(fixture["password"].as_str().unwrap(), verifier));
        assert!(!matches("wrong", verifier));
        assert!(!matches("", verifier));
        assert!(!matches(
            "household-admin-test",
            &verifier.replace("600000", "1")
        ));
        assert!(!matches(
            "household-admin-test",
            &verifier.replace("000102", "gggggg")
        ));
        assert!(!matches(
            "household-admin-test",
            &(verifier.to_owned() + "$extra")
        ));
        assert!(!matches(&"a".repeat(4097), verifier));
        assert!(!matches(
            "household-admin-test",
            "pbkdf2-sha256$600000$00$00"
        ));
    }
    #[test]
    fn old_identity_has_no_offline_access_and_no_plaintext_password_is_saved() {
        let identity = Identity {
            emergency_disabled: false,
            unlock_retry_at: 0,
            service: String::new(),
            private_key: String::new(),
            state: None,
        };
        let result = emergency_unlock(
            identity,
            fixture()["password"].as_str().unwrap().into(),
            100,
        );
        assert!(!result.unlocked);
        assert!(result.message.contains("sync"));
        assert!(!serde_json::to_string(&result.identity)
            .unwrap()
            .contains("household-admin-test"));
    }
}
