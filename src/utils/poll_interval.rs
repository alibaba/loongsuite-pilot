//! Port of `src/utils/poll-interval.ts`.

/// Environment variable that overrides every collector poll interval.
pub const POLL_INTERVAL_ENV: &str = "LOONGSUITE_PILOT_POLL_INTERVAL_MS";

/// Built-in collector poll interval when no env var or listener override is set.
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 10_000;

const MIN_POLL_INTERVAL_MS: u64 = 1_000;
const MAX_POLL_INTERVAL_MS: u64 = 2_147_483_647;

/// Parsed unified poll interval, or `None` when the env var is unset or invalid.
///
/// Only decimal integers from 1000 through 2147483647 are accepted. Fractions,
/// scientific notation, hex, and out-of-range values are ignored.
pub fn global_poll_interval_ms() -> Option<u64> {
    let raw = std::env::var(POLL_INTERVAL_ENV).ok()?;
    let trimmed = raw.trim();
    if !is_decimal_integer(trimmed) {
        return None;
    }
    let value: u128 = trimmed.parse().ok()?;
    if value < MIN_POLL_INTERVAL_MS as u128 || value > MAX_POLL_INTERVAL_MS as u128 {
        return None;
    }
    Some(value as u64)
}

fn is_decimal_integer(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) if ('1'..='9').contains(&first) => chars.all(|ch| ch.is_ascii_digit()),
        _ => false,
    }
}

/// Env wins over a per-listener value. `configured` is kept as-is when the env
/// var is unset, including 0.
pub fn resolve_poll_interval_ms(configured: Option<u64>, fallback: u64) -> u64 {
    global_poll_interval_ms().or(configured).unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::{
        global_poll_interval_ms, resolve_poll_interval_ms, DEFAULT_POLL_INTERVAL_MS,
        POLL_INTERVAL_ENV,
    };
    use crate::utils::isolated_env_test;

    struct EnvGuard {
        previous: Option<String>,
    }

    impl EnvGuard {
        fn set(value: &str) -> Self {
            let previous = std::env::var(POLL_INTERVAL_ENV).ok();
            unsafe { std::env::set_var(POLL_INTERVAL_ENV, value) };
            Self { previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => unsafe { std::env::set_var(POLL_INTERVAL_ENV, value) },
                None => unsafe { std::env::remove_var(POLL_INTERVAL_ENV) },
            }
        }
    }

    #[test]
    fn accepts_decimal_integers_from_1000_through_the_set_interval_maximum() {
        if !isolated_env_test() {
            return;
        }
        let _g = EnvGuard::set("1000");
        assert_eq!(global_poll_interval_ms(), Some(1_000));
        drop(_g);
        let _g = EnvGuard::set("3000");
        assert_eq!(global_poll_interval_ms(), Some(3_000));
        drop(_g);
        let _g = EnvGuard::set("2147483647");
        assert_eq!(global_poll_interval_ms(), Some(2_147_483_647));
    }

    #[test]
    fn ignores_values_node_would_clamp_and_non_integers() {
        if !isolated_env_test() {
            return;
        }
        for raw in [
            "0",
            "0.4",
            "3",
            "1e5",
            "1e-5",
            "0x10",
            "2147483648",
            "nope",
            "",
        ] {
            let _g = EnvGuard::set(raw);
            assert_eq!(global_poll_interval_ms(), None, "{raw}");
        }
        let _g = EnvGuard::set("");
        assert_eq!(
            resolve_poll_interval_ms(Some(30_000), DEFAULT_POLL_INTERVAL_MS),
            30_000
        );
    }

    #[test]
    fn keeps_configured_zero_when_env_is_unset() {
        if !isolated_env_test() {
            return;
        }
        let previous = std::env::var(POLL_INTERVAL_ENV).ok();
        unsafe { std::env::remove_var(POLL_INTERVAL_ENV) };
        assert_eq!(
            resolve_poll_interval_ms(Some(0), DEFAULT_POLL_INTERVAL_MS),
            0
        );
        assert_eq!(
            resolve_poll_interval_ms(None, DEFAULT_POLL_INTERVAL_MS),
            DEFAULT_POLL_INTERVAL_MS
        );
        if let Some(value) = previous {
            unsafe { std::env::set_var(POLL_INTERVAL_ENV, value) }
        }
    }
}
