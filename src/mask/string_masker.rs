//! Apply compiled mask ranges to strings, including preview-token protection.

use super::detect::{collect_sensitive_ranges, is_masked_token};
use super::pii_detectors::collect_pii_ranges;
use super::types::{
    MaskPlan, MaskRange, MaskType, PlanOrRules, StringMaskOptions, MASKED_PREVIEW_TOKEN_PATTERN,
};

pub use super::detect::is_large_string;
use fancy_regex::Regex;
use std::borrow::Cow;
use std::sync::LazyLock;

static PREVIEW_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(MASKED_PREVIEW_TOKEN_PATTERN).expect("masked preview token pattern")
});

pub fn mask_string<'a>(
    value: &'a str,
    plan_or_rules: PlanOrRules<'_>,
    options: &StringMaskOptions,
) -> Cow<'a, str> {
    let held: MaskPlan;
    let plan: &MaskPlan = match plan_or_rules {
        PlanOrRules::Plan(plan) => plan,
        PlanOrRules::Rules(rules) => {
            held = MaskPlan::from_rules(rules);
            &held
        }
    };
    if value.is_empty()
        || (plan.rules.is_empty() && plan.pii_types.is_empty())
        || is_masked_token(value)
    {
        return Cow::Borrowed(value);
    }

    let protected = collect_masked_preview_ranges(value);
    let scan_owned;
    let scan: &str = if protected.is_empty() {
        value
    } else {
        scan_owned = blank_protected_preview_ranges(value, &protected);
        &scan_owned
    };

    let mut ranges = Vec::new();
    if !plan.rules.is_empty() {
        ranges.extend(collect_sensitive_ranges(
            scan,
            &plan.rules,
            options,
            plan.replacement_mode,
        ));
    }
    if !plan.pii_types.is_empty() {
        ranges.extend(collect_pii_ranges(
            scan,
            &plan.pii_types,
            plan.replacement_mode,
        ));
    }
    if ranges.is_empty() {
        return Cow::Borrowed(value);
    }
    let masked = apply_mask_ranges(value, &ranges);
    if masked == value {
        Cow::Borrowed(value)
    } else {
        Cow::Owned(masked)
    }
}

fn collect_masked_preview_ranges(value: &str) -> Vec<(usize, usize)> {
    if !value.contains("_MASKED]{") {
        return Vec::new();
    }
    PREVIEW_TOKEN
        .find_iter(value)
        .flatten()
        .map(|found| (found.start(), found.end()))
        .collect()
}

fn blank_protected_preview_ranges(value: &str, protected: &[(usize, usize)]) -> String {
    let mut out = String::with_capacity(value.len());
    let mut cursor = 0usize;
    for (start, end) in protected {
        out.push_str(&value[cursor..*start]);
        out.extend(std::iter::repeat_n(' ', end - start));
        cursor = *end;
    }
    out.push_str(&value[cursor..]);
    out
}

pub fn apply_mask_ranges(value: &str, ranges: &[MaskRange]) -> String {
    let normalized = normalize_mask_ranges(value, ranges);
    if normalized.is_empty() {
        return value.to_string();
    }
    let mut out = String::with_capacity(value.len());
    let mut cursor = 0usize;
    for range in normalized {
        out.push_str(&value[cursor..range.start]);
        out.push_str(&range.replacement);
        cursor = range.end;
    }
    out.push_str(&value[cursor..]);
    out
}

fn normalize_mask_ranges(value: &str, ranges: &[MaskRange]) -> Vec<MaskRange> {
    let value_len = value.len();
    let mut sorted: Vec<MaskRange> = ranges
        .iter()
        .filter(|range| {
            range.end > range.start
                && range.end <= value_len
                && value.is_char_boundary(range.start)
                && value.is_char_boundary(range.end)
        })
        .cloned()
        .collect();
    sorted.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            .then_with(|| mask_range_priority(b.mask_type).cmp(&mask_range_priority(a.mask_type)))
            .then_with(|| (b.end - b.start).cmp(&(a.end - a.start)))
            .then_with(|| a.rule_id.cmp(&b.rule_id))
    });

    let mut result: Vec<MaskRange> = Vec::new();
    for candidate in sorted {
        let Some((prev_start, prev_end, prev_priority)) = result.last().map(|previous| {
            (
                previous.start,
                previous.end,
                mask_range_priority(previous.mask_type),
            )
        }) else {
            result.push(candidate);
            continue;
        };
        if candidate.start >= prev_end {
            result.push(candidate);
            continue;
        }
        let merged_end = prev_end.max(candidate.end);
        if mask_range_priority(candidate.mask_type) > prev_priority {
            let mut replacement = candidate;
            replacement.start = prev_start;
            replacement.end = merged_end;
            *result.last_mut().expect("range") = replacement;
        } else if merged_end != prev_end {
            result.last_mut().expect("range").end = merged_end;
        }
    }
    result
}

fn mask_range_priority(mask_type: MaskType) -> i32 {
    match mask_type {
        MaskType::IdCard => 30,
        MaskType::BankCard => 20,
        MaskType::Phone => 10,
        MaskType::Email | MaskType::IpAddress => 5,
        MaskType::CloudAccessKey
        | MaskType::ApiKey
        | MaskType::PrivateKey
        | MaskType::DatabaseUrl => 100,
    }
}

#[cfg(test)]
mod tests {
    use super::{apply_mask_ranges, is_large_string, mask_string};
    use crate::mask::rule_loader::{load_enabled_rules, load_mask_plan};
    use crate::mask::types::{
        CompiledMaskRule, MaskConfig, MaskMode, MaskRange, MaskReplacementMode, MaskType,
        PlanOrRules, StringMaskOptions,
    };
    use fancy_regex::Regex;

    fn all_config() -> MaskConfig {
        MaskConfig {
            mode: MaskMode::All,
            types: Vec::new(),
            replacement_mode: None,
        }
    }

    fn all_rules() -> Vec<CompiledMaskRule> {
        load_enabled_rules(&all_config())
    }

    fn mask(input: &str) -> String {
        let rules = all_rules();
        mask_string(
            input,
            PlanOrRules::Rules(&rules),
            &StringMaskOptions::default(),
        )
        .into_owned()
    }

    fn candidate(length: usize) -> String {
        "Aa1".repeat(length.div_ceil(3))[..length].to_string()
    }

    #[test]
    fn masks_supported_cloud_access_keys_and_api_keys() {
        let input = [
            "aliyun=LTAI1234567890ABCD",
            "aws=AKIAIOSFODNN7EXAMPLE",
            "sts=ASIAIOSFODNN7EXAMPLE",
            "aws_abia=ABIAIOSFODNN7EXAMPLE",
            "aws_acca=ACCAIOSFODNN7EXAMPLE",
            "tencent=AKIDabcdefghijklmnopqrstuvwxyz",
            "openai=sk-EXAMPLE0123456789abcdef",
            "github=ghp_1234567890abcdefghijklmnop",
        ]
        .join("\n");
        let masked = mask(&input);
        assert!(masked.contains("[ACCESSKEY_MASKED]"));
        assert!(masked.contains("[APIKEY_MASKED]"));
        for secret in [
            "LTAI1234567890ABCD",
            "AKIAIOSFODNN7EXAMPLE",
            "ASIAIOSFODNN7EXAMPLE",
            "ABIAIOSFODNN7EXAMPLE",
            "ACCAIOSFODNN7EXAMPLE",
            "AKIDabcdefghijklmnopqrstuvwxyz",
            "sk-EXAMPLE0123456789abcdef",
            "ghp_1234567890abcdefghijklmnop",
        ] {
            assert!(!masked.contains(secret), "{secret}");
        }
    }

    #[test]
    fn masks_a_secret_like_candidate_only_after_a_valid_cloud_access_key_id() {
        let secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/+_-==";
        let without = format!("ordinary output {secret}");
        let malformed = format!("AKIA1234:{secret}");
        let with_id = format!("AKIA1234567890ABCDEF:{secret}");
        assert_eq!(mask(&without), without);
        assert_eq!(mask(&malformed), malformed);
        assert_eq!(
            mask(&with_id),
            "[ACCESSKEY_MASKED]:[ACCESSKEY_SECRET_MASKED]"
        );
    }

    #[test]
    fn accepts_20_through_60_character_secret_candidates() {
        let values: Vec<String> = [19, 20, 60, 61].into_iter().map(candidate).collect();
        let input = values
            .iter()
            .map(|value| format!("AKID1234567890123:{value}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            mask(&input),
            [
                format!("[ACCESSKEY_MASKED]:{}", values[0]),
                "[ACCESSKEY_MASKED]:[ACCESSKEY_SECRET_MASKED]".to_string(),
                "[ACCESSKEY_MASKED]:[ACCESSKEY_SECRET_MASKED]".to_string(),
                format!("[ACCESSKEY_MASKED]:{}", values[3]),
            ]
            .join("\n")
        );
    }

    #[test]
    fn requires_uppercase_lowercase_and_a_digit_in_each_secret_candidate() {
        let candidates = ["abc123".repeat(4), "ABC123".repeat(4), "AbCdEf".repeat(4)];
        let input = candidates
            .iter()
            .map(|candidate| format!("AKID1234567890123:{candidate}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            mask(&input),
            candidates
                .iter()
                .map(|candidate| format!("[ACCESSKEY_MASKED]:{candidate}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    #[test]
    fn recognizes_common_separators_and_base64_like_characters() {
        let secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/+_-==";
        let input = [
            format!("LTAI1234567890ABCD:{secret};"),
            format!("AKIA1234567890ABCDEF {secret}"),
            format!("AKID1234567890123\n{secret}"),
        ]
        .join("\n");
        let masked = mask(&input);
        assert_eq!(masked.matches("[ACCESSKEY_SECRET_MASKED]").count(), 3);
        assert!(!masked.contains(secret));
        assert!(masked.contains("[ACCESSKEY_MASKED]:[ACCESSKEY_SECRET_MASKED];"));
    }

    #[test]
    fn recognizes_a_secret_that_starts_with_slash_plus_or_hyphen() {
        let secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
        let inputs: Vec<String> = ["/", "+", "-"]
            .into_iter()
            .map(|separator| format!("AKIA1234567890ABCDEF{separator}{secret}"))
            .collect();
        let masked: Vec<String> = inputs.iter().map(|input| mask(input)).collect();
        assert_eq!(
            masked,
            vec!["[ACCESSKEY_MASKED][ACCESSKEY_SECRET_MASKED]"; inputs.len()]
        );
    }

    #[test]
    fn finishes_a_secret_candidate_at_the_next_recognized_access_key_id() {
        let secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
        let first_id = "AKIA1234567890ABCDEF";
        let inputs = [
            format!("{first_id} {secret}=LTAI1234567890ABCD"),
            format!("{first_id} {secret}+AKIA0987654321FEDCBA"),
        ];
        let masked: Vec<String> = inputs.iter().map(|input| mask(input)).collect();
        assert_eq!(
            masked,
            vec![
                "[ACCESSKEY_MASKED] [ACCESSKEY_SECRET_MASKED][ACCESSKEY_MASKED]".to_string(),
                "[ACCESSKEY_MASKED] [ACCESSKEY_SECRET_MASKED][ACCESSKEY_MASKED]".to_string(),
            ]
        );
    }

    #[test]
    fn scans_no_more_than_1024_characters_after_an_access_key_id() {
        let secret = format!("{}A", "Aa1".repeat(13));
        let in_range = format!("AKID1234567890123{}{secret}", " ".repeat(984));
        let out_of_range = format!("AKID1234567890123{}{secret}", " ".repeat(985));
        assert!(mask(&in_range).contains("[ACCESSKEY_SECRET_MASKED]"));
        assert_eq!(
            mask(&out_of_range),
            format!("[ACCESSKEY_MASKED]{}{secret}", " ".repeat(985))
        );
    }

    #[test]
    fn finds_a_secret_in_large_text_outside_the_generic_keyword_window() {
        let secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
        let input = format!(
            "{} LTAI1234567890ABCD{}{secret} {}",
            "x".repeat(200),
            " ".repeat(200),
            "y".repeat(200)
        );
        let rules = all_rules();
        let masked = mask_string(
            &input,
            PlanOrRules::Rules(&rules),
            &StringMaskOptions {
                large_string_threshold_bytes: Some(64),
                keyword_context_window: Some(8),
                private_key_block_limit: None,
            },
        );
        assert!(masked.contains("[ACCESSKEY_MASKED]"));
        assert!(masked.contains("[ACCESSKEY_SECRET_MASKED]"));
        assert!(!masked.contains(secret));
    }

    #[test]
    fn uses_the_configured_masked_preview_format_for_a_nearby_secret() {
        let plan = load_mask_plan(&MaskConfig {
            mode: MaskMode::All,
            types: Vec::new(),
            replacement_mode: Some(MaskReplacementMode::Preview),
        });
        let secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/+_-==";
        let input = format!("AKIA1234567890ABCDEF:{secret}");
        let masked = mask_string(
            &input,
            PlanOrRules::Plan(&plan),
            &StringMaskOptions::default(),
        );
        assert!(masked.contains("[ACCESSKEY_MASKED]{AKIA************CDEF}"));
        assert!(Regex::new(r"\[ACCESSKEY_SECRET_MASKED\]\{AbCd\*+_-==\}")
            .unwrap()
            .is_match(masked.as_ref())
            .unwrap_or(false));
        assert!(!masked.contains(secret));
    }

    #[test]
    fn keeps_secret_placeholder_and_preview_markers_stable() {
        let placeholder = "[ACCESSKEY_SECRET_MASKED]";
        let preview = "[ACCESSKEY_SECRET_MASKED]{AbCd********7890}";
        assert_eq!(mask(placeholder), placeholder);
        assert_eq!(mask(preview), preview);
    }

    #[test]
    fn masks_all_supported_github_token_prefixes() {
        let tokens = [
            "ghp_1234567890abcdefghijklmnop",
            "gho_1234567890abcdefghijklmnop",
            "ghu_1234567890abcdefghijklmnop",
            "ghs_1234567890abcdefghijklmnop",
            "ghr_1234567890abcdefghijklmnop",
            "github_pat_1234567890abcdefghijklmnop",
        ];
        let masked = mask(&tokens.join("\n"));
        assert_eq!(masked.matches("[APIKEY_MASKED]").count(), tokens.len());
        for token in tokens {
            assert!(!masked.contains(token));
        }
    }

    #[test]
    fn does_not_mask_secret_like_substrings_that_fail_boundaries_or_lengths() {
        let input = [
            "embedded_aws=xxAKIAIOSFODNN7EXAMPLEyy",
            "embedded_api=xxsk-EXAMPLE0123456789abcdefxx",
            "short_aliyun=LTAI123",
            "short_aws=AKIA123",
            "short_tencent=AKIDshort",
            "short_api=sk-short",
            "short_github=github_pat_short",
        ]
        .join("\n");
        assert_eq!(mask(&input), input);
    }

    #[test]
    fn does_not_mask_unsupported_api_key_prefixes_or_generic_pairs() {
        let input = [
            "google=AIzaSyA0FakeGoogleKeyShouldRemainVisible",
            "unsupported_github=ghx_1234567890abcdefghijklmnop",
            "generic_token=token=abc123",
            "generic_api_key=api_key=not-a-real-key-value",
            "bearer=Bearer abcdefghijklmnopqrstuvwxyz123456",
        ]
        .join("\n");
        assert_eq!(mask(&input), input);
    }

    #[test]
    fn masks_private_key_blocks() {
        // 仅构造可匹配的无效私钥块，不保存真实密钥材料。
        let kind = "OPENSSH PRIVATE KEY";
        let input = format!(
            "before\n-----BEGIN {kind}-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END {kind}-----\nafter"
        );
        assert_eq!(mask(&input), "before\n[PRIVATEKEY_MASKED]\nafter");
    }

    #[test]
    fn masks_database_urls_that_include_passwords() {
        let input = [
            "mysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot",
            "postgres://agent:PostgresPass123@127.0.0.1:5432/pilot",
            "mongodb://agent:MongoPass123@127.0.0.1:27017/pilot",
            "redis://:RedisPass123@127.0.0.1:6379/0",
            "jdbc:mysql://localhost:3306/db?useSSL=false&user=root&password=MySynthMysql12",
            "jdbc:postgresql://localhost:5432/mydb?user=u&pwd=secret123",
        ]
        .join("\n");
        let masked = mask(&input);
        assert_eq!(masked.matches("[DATABASEURL_MASKED]").count(), 6);
        for secret in [
            "eMCyjl4XWcVzpXFb",
            "PostgresPass123",
            "MongoPass123",
            "RedisPass123",
            "MySynthMysql12",
            "secret123",
        ] {
            assert!(!masked.contains(secret), "{secret}");
        }
    }

    #[test]
    fn preserves_natural_language_suffix_after_a_masked_jdbc_url() {
        let input =
            "MASK_TEST_009 jdbc:mysql://localhost:3306/db?user=root&password=MySynthMysql12你能识别到多少";
        assert_eq!(
            mask(input),
            "MASK_TEST_009 [DATABASEURL_MASKED]你能识别到多少"
        );
    }

    #[test]
    fn does_not_mask_database_urls_without_passwords() {
        let input = [
            "mysql://localhost:3306/pilot",
            "mysql://agent@localhost:3306/pilot",
            "mysql://agent:@localhost:3306/pilot",
            "http://agent:HttpPass123@example.com/path",
            "jdbc:mysql://localhost:3306/db?useSSL=false&user=root",
            "jdbc:mysql://localhost:3306/db?user=root&password=",
            "jdbc:mysql://localhost:3306/db?user=root&passwordless=true",
        ]
        .join("\n");
        assert_eq!(mask(&input), input);
    }

    #[test]
    fn does_not_mask_public_keys_certificates_incomplete_or_oversized_private_keys() {
        let kind = "PRIVATE KEY";
        let oversized = format!(
            "-----BEGIN {kind}-----\n{}\n-----END {kind}-----",
            "A".repeat(70 * 1024)
        );
        let input = [
            "-----BEGIN PUBLIC KEY-----".to_string(),
            "PublicKeyMaterialOnly".to_string(),
            "-----END PUBLIC KEY-----".to_string(),
            "-----BEGIN CERTIFICATE-----".to_string(),
            "CertificateMaterialOnly".to_string(),
            "-----END CERTIFICATE-----".to_string(),
            "-----BEGIN PRIVATE KEY-----".to_string(),
            "IncompletePrivateKeyMaterialOnly".to_string(),
            oversized,
        ]
        .join("\n");
        assert_eq!(mask(&input), input);
    }

    #[test]
    fn uses_utf8_byte_length_for_large_string_detection() {
        assert!(is_large_string("你好abc", 8));
        assert!(!is_large_string("hello", 8));
    }

    #[test]
    fn does_not_mask_already_masked_tokens_again() {
        let input = "[APIKEY_MASKED] sk-EXAMPLE0123456789abcdef";
        assert_eq!(mask(input), "[APIKEY_MASKED] [APIKEY_MASKED]");
    }

    #[test]
    fn applies_multiple_unsorted_ranges_without_changing_untouched_text() {
        let masked = apply_mask_ranges(
            "0123456789",
            &[
                MaskRange {
                    start: 7,
                    end: 9,
                    replacement: "[SECOND]".into(),
                    rule_id: "test.second".into(),
                    mask_type: MaskType::ApiKey,
                },
                MaskRange {
                    start: 1,
                    end: 3,
                    replacement: "[FIRST]".into(),
                    rule_id: "test.first".into(),
                    mask_type: MaskType::ApiKey,
                },
            ],
        );
        assert_eq!(masked, "0[FIRST]3456[SECOND]9");
    }

    #[test]
    fn keeps_the_full_union_covered_across_chained_overlapping_ranges() {
        let masked = apply_mask_ranges(
            "0123456789",
            &[
                MaskRange {
                    start: 0,
                    end: 5,
                    replacement: "[EMAIL_MASKED]".into(),
                    rule_id: "pii.email".into(),
                    mask_type: MaskType::Email,
                },
                MaskRange {
                    start: 3,
                    end: 8,
                    replacement: "[PHONE_MASKED]".into(),
                    rule_id: "pii.phone".into(),
                    mask_type: MaskType::Phone,
                },
                MaskRange {
                    start: 7,
                    end: 10,
                    replacement: "[IDCARD_MASKED]".into(),
                    rule_id: "pii.idCard".into(),
                    mask_type: MaskType::IdCard,
                },
            ],
        );
        assert_eq!(masked, "[IDCARD_MASKED]");
    }

    #[test]
    fn masks_secrets_in_large_strings_through_keyword_windows() {
        let input = format!(
            "{} LTAI1234567890ABCD {} sk-EXAMPLE0123456789abcdef {}",
            "x".repeat(120),
            "y".repeat(20),
            "z".repeat(120)
        );
        let rules = all_rules();
        let masked = mask_string(
            &input,
            PlanOrRules::Rules(&rules),
            &StringMaskOptions {
                large_string_threshold_bytes: Some(64),
                keyword_context_window: Some(32),
                private_key_block_limit: None,
            },
        );
        assert!(masked.contains("[ACCESSKEY_MASKED]"));
        assert!(masked.contains("[APIKEY_MASKED]"));
        assert!(!masked.contains("LTAI1234567890ABCD"));
        assert!(!masked.contains("sk-EXAMPLE0123456789abcdef"));
    }

    #[cfg(unix)]
    fn thread_cpu_ms() -> f64 {
        let mut time = std::mem::MaybeUninit::<libc::timespec>::uninit();
        // SAFETY: clock_gettime initializes this writable timespec on success.
        assert_eq!(
            unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, time.as_mut_ptr()) },
            0
        );
        // SAFETY: the successful call above initialized both fields.
        let time = unsafe { time.assume_init() };
        time.tv_sec as f64 * 1000.0 + time.tv_nsec as f64 / 1_000_000.0
    }
    #[cfg(windows)]
    fn thread_cpu_ms() -> f64 {
        use windows_sys::Win32::{
            Foundation::FILETIME,
            System::Threading::{GetCurrentThread, GetThreadTimes},
        };
        let mut created = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exited = created;
        let mut kernel = created;
        let mut user = created;
        // SAFETY: the current-thread pseudo handle stays valid; all output
        // pointers are distinct writable FILETIMEs and no handle is owned.
        assert_ne!(
            unsafe {
                GetThreadTimes(
                    GetCurrentThread(),
                    &mut created,
                    &mut exited,
                    &mut kernel,
                    &mut user,
                )
            },
            0
        );
        let ticks =
            |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
        (ticks(kernel) + ticks(user)) as f64 / 10_000.0
    }

    #[test]
    fn masks_a_middle_position_secret_across_threshold_and_window_combinations() {
        // Main #565 preserves the original budget using this synchronous thread's CPU.
        let plan = load_mask_plan(&all_config());
        let secret = "sk-EXAMPLE0123456789abcdef";
        let input = format!(
            "{} {secret} {}",
            "x".repeat(300 * 1024),
            "y".repeat(300 * 1024)
        );
        let started = thread_cpu_ms();
        for threshold in [64 * 1024, 128 * 1024, 256 * 1024] {
            for window in [4 * 1024, 8 * 1024, 16 * 1024] {
                let masked = mask_string(
                    &input,
                    PlanOrRules::Plan(&plan),
                    &StringMaskOptions {
                        large_string_threshold_bytes: Some(threshold),
                        keyword_context_window: Some(window),
                        private_key_block_limit: None,
                    },
                );
                assert!(masked.contains("[APIKEY_MASKED]"));
                assert!(!masked.contains(secret));
            }
        }
        assert!(thread_cpu_ms() - started < 2000.0);
    }

    #[test]
    fn keeps_five_type_pii_scanning_correct_for_large_plain_and_mixed_text() {
        let plan = load_mask_plan(&all_config());
        let plain = "ordinary collector output without sensitive values\n".repeat(3_000);
        let mixed = [
            plain.clone(),
            "id=11010519491231002X".to_string(),
            "phone=13800138000".to_string(),
            "email=user@example.com".to_string(),
            "ip=192.168.1.10".to_string(),
            "card=4111111111111111".to_string(),
            plain.clone(),
        ]
        .join("\n");
        let started = thread_cpu_ms();
        for _ in 0..20 {
            assert_eq!(
                mask_string(
                    &plain,
                    PlanOrRules::Plan(&plan),
                    &StringMaskOptions::default()
                )
                .as_ref(),
                plain.as_str()
            );
            let masked = mask_string(
                &mixed,
                PlanOrRules::Plan(&plan),
                &StringMaskOptions::default(),
            );
            assert!(masked.contains("[IDCARD_MASKED]"));
            assert!(masked.contains("[PHONE_MASKED]"));
            assert!(masked.contains("[EMAIL_MASKED]"));
            assert!(masked.contains("[IP_ADDRESS_MASKED]"));
            assert!(masked.contains("[CREDIT_CARD_MASKED]"));
        }
        assert!(thread_cpu_ms() - started < 2000.0);
    }

    #[test]
    fn keeps_fragmented_numeric_input_without_dropping_valid_phones() {
        let plan = load_mask_plan(&all_config());
        let chunk = format!("{}|", (0..64).map(|_| "1").collect::<Vec<_>>().join(" "));
        let fragmented = chunk.repeat(512);
        let input = format!("{fragmented}13800138000");
        let started = thread_cpu_ms();
        let masked = mask_string(
            &input,
            PlanOrRules::Plan(&plan),
            &StringMaskOptions::default(),
        );
        let elapsed_ms = thread_cpu_ms() - started;
        assert_eq!(&masked.as_ref()[..fragmented.len()], fragmented.as_str());
        assert_eq!(&masked.as_ref()[fragmented.len()..], "[PHONE_MASKED]");
        assert!(elapsed_ms < 100.0);
    }
}
