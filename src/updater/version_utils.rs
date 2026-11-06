//! Port of `src/updater/version-utils.ts`.

use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

/// Compare two semver strings numerically (`major.minor.patch`).
///
/// Returns `1` if `a > b`, `-1` if `a < b`, and `0` if equal. A non-numeric
/// segment falls back to JavaScript string comparison of the original values.
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let pa: Vec<Option<f64>> = a.split('.').map(js_number).collect();
    let pb: Vec<Option<f64>> = b.split('.').map(js_number).collect();
    if pa.iter().any(Option::is_none) || pb.iter().any(Option::is_none) {
        return if a < b {
            -1
        } else if a > b {
            1
        } else {
            0
        };
    }
    let len = pa.len().max(pb.len());
    for index in 0..len {
        let na = pa.get(index).copied().flatten().unwrap_or(0.0);
        let nb = pb.get(index).copied().flatten().unwrap_or(0.0);
        if na != nb {
            return if na > nb { 1 } else { -1 };
        }
    }
    0
}

/// `sha256(installId + version)` first 4 bytes, big-endian, modulo 100.
pub fn deterministic_bucket(install_id: &str, version: &str) -> u32 {
    let mut hasher = Sha256::new();
    hasher.update(install_id.as_bytes());
    hasher.update(version.as_bytes());
    let digest = hasher.finalize();
    let num = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    num % 100
}

pub fn compute_sha256(file_path: &str) -> std::io::Result<String> {
    let mut file = std::fs::File::open(Path::new(file_path))?;
    let mut hasher = Sha256::new();
    let mut buf = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// JavaScript `Number(segment)`. `None` means `NaN`.
fn js_number(segment: &str) -> Option<f64> {
    let trimmed = segment.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if let Some(hex_body) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return i64::from_str_radix(hex_body, 16)
            .ok()
            .map(|value| value as f64);
    }
    let value = trimmed.parse::<f64>().ok()?;
    if value.is_nan() {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::{compare_versions, deterministic_bucket};

    #[test]
    fn compares_standard_semver() {
        assert_eq!(compare_versions("1.0.2", "1.0.1"), 1);
        assert_eq!(compare_versions("1.0.1", "1.0.2"), -1);
        assert_eq!(compare_versions("1.0.2", "1.0.2"), 0);
        assert_eq!(compare_versions("1.1.0", "1.0.9"), 1);
        assert_eq!(compare_versions("1.0.9", "1.1.0"), -1);
        assert_eq!(compare_versions("2.0.0", "1.9.9"), 1);
        assert_eq!(compare_versions("1.9.9", "2.0.0"), -1);
    }

    #[test]
    fn pads_missing_segments_with_zero() {
        assert_eq!(compare_versions("1.0", "1.0.0"), 0);
        assert_eq!(compare_versions("1.0.1", "1.0"), 1);
        assert_eq!(compare_versions("2", "1"), 1);
        assert_eq!(compare_versions("1.0.0.1", "1.0.0.0"), 1);
    }

    #[test]
    fn falls_back_to_string_comparison() {
        assert_eq!(compare_versions("abc", "def"), -1);
        assert_eq!(compare_versions("def", "abc"), 1);
        assert_eq!(compare_versions("beta", "beta"), 0);
        assert_eq!(compare_versions("1.0.0-beta", "1.0.0"), 1);
    }

    #[test]
    fn handles_empty_zero_and_large_versions() {
        assert_eq!(compare_versions("", ""), 0);
        assert_eq!(compare_versions("0.0.0", "0.0.0"), 0);
        assert_eq!(compare_versions("100.200.300", "100.200.299"), 1);
    }

    #[test]
    fn bucket_stays_in_range_and_is_stable() {
        let result = deterministic_bucket("a3f8c1d2-7b4e-4f9a-b2c1-e5d6f7a8b9c0", "1.0.36");
        assert!(result < 100);
        assert_eq!(
            deterministic_bucket("test-install-id-123", "1.0.36"),
            deterministic_bucket("test-install-id-123", "1.0.36")
        );
        assert!(deterministic_bucket("", "1.0.0") < 100);
    }

    #[test]
    fn bucket_changes_with_version_and_install_id() {
        let mut versions = std::collections::HashSet::new();
        for version in 0..50 {
            versions.insert(deterministic_bucket(
                "test-install-id-123",
                &format!("1.0.{version}"),
            ));
        }
        assert!(versions.len() > 1);

        let mut installs = std::collections::HashSet::new();
        for index in 0..50 {
            installs.insert(deterministic_bucket(&format!("install-{index}"), "1.0.36"));
        }
        assert!(installs.len() > 1);
    }

    #[test]
    fn bucket_spreads_across_most_slots() {
        let mut buckets = [0_u32; 100];
        for index in 0..10_000 {
            let bucket = deterministic_bucket(&format!("uuid-{index}-salt"), "1.0.36") as usize;
            buckets[bucket] += 1;
        }
        let non_empty = buckets.iter().filter(|count| **count > 0).count();
        assert!(non_empty > 80);
    }
}
