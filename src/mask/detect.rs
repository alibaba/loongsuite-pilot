//! Keyword-gated manifest detectors: access keys, API keys, private keys, and database URLs.

use super::masked_preview::{build_mask_replacement, parse_standard_url};
use super::types::{
    ceil_char_boundary, code_at, floor_char_boundary, CompiledMaskRule, MaskRange,
    MaskReplacementMode, MaskRuleKind, MaskType, ResolvedStringMaskOptions, StringMaskOptions,
    DEFAULT_STRING_MASK_OPTIONS, MASKED_TOKEN_PATTERN,
};
use regex::Regex;
use std::sync::LazyLock;

const ACCESS_KEY_SECRET_LOOKAHEAD_CHARS: usize = 1024;
const ACCESS_KEY_SECRET_MIN_LENGTH: usize = 20;
const ACCESS_KEY_SECRET_MAX_LENGTH: usize = 60;
const ACCESS_KEY_SECRET_REPLACEMENT: &str = "[ACCESSKEY_SECRET_MASKED]";
const ACCESS_KEY_SECRET_RULE_ID: &str = "cloudAccessKey.secret.nearId";

static MASKED_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(MASKED_TOKEN_PATTERN).expect("masked token pattern"));

static URL_CANDIDATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?-u:\b)[a-z][a-z0-9+.-]*://[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+")
        .expect("url candidate pattern")
});

pub fn is_large_string(value: &str, threshold_bytes: usize) -> bool {
    value.len() > threshold_bytes
}

pub(crate) fn is_masked_token(value: &str) -> bool {
    MASKED_TOKEN.is_match(value)
}

pub fn resolve_string_mask_options(options: &StringMaskOptions) -> ResolvedStringMaskOptions {
    ResolvedStringMaskOptions {
        large_string_threshold_bytes: options
            .large_string_threshold_bytes
            .unwrap_or(DEFAULT_STRING_MASK_OPTIONS.large_string_threshold_bytes),
        keyword_context_window: options
            .keyword_context_window
            .unwrap_or(DEFAULT_STRING_MASK_OPTIONS.keyword_context_window),
        private_key_block_limit: options
            .private_key_block_limit
            .unwrap_or(DEFAULT_STRING_MASK_OPTIONS.private_key_block_limit),
    }
}

pub fn collect_sensitive_ranges(
    value: &str,
    rules: &[CompiledMaskRule],
    options: &StringMaskOptions,
    replacement_mode: MaskReplacementMode,
) -> Vec<MaskRange> {
    if value.is_empty() || rules.is_empty() || is_masked_token(value) {
        return Vec::new();
    }
    let resolved = resolve_string_mask_options(options);
    let normalized = lowercase_ascii(value);
    if !rules.iter().any(|rule| rule.has_prefilter(&normalized)) {
        return Vec::new();
    }
    let access_key_rules: Vec<&CompiledMaskRule> = rules
        .iter()
        .filter(|rule| rule.mask_type == MaskType::CloudAccessKey)
        .collect();
    let other_rules: Vec<&CompiledMaskRule> = rules
        .iter()
        .filter(|rule| rule.mask_type != MaskType::CloudAccessKey)
        .collect();
    let mut ranges = if is_large_string(value, resolved.large_string_threshold_bytes) {
        collect_large_string_ranges(
            value,
            &normalized,
            &other_rules,
            replacement_mode,
            &resolved,
        )
    } else {
        collect_ranges_for_segment(
            value,
            &normalized,
            0,
            &other_rules,
            replacement_mode,
            &resolved,
        )
    };
    if !access_key_rules.is_empty()
        && access_key_rules
            .iter()
            .any(|rule| rule.has_prefilter(&normalized))
    {
        ranges.extend(collect_cloud_access_key_ranges(
            value,
            &normalized,
            &access_key_rules,
            replacement_mode,
        ));
    }
    ranges
}

struct AccessKeyAnchor<'a> {
    start: usize,
    end: usize,
    rule: &'a CompiledMaskRule,
}

fn collect_cloud_access_key_ranges(
    value: &str,
    normalized: &str,
    rules: &[&CompiledMaskRule],
    replacement_mode: MaskReplacementMode,
) -> Vec<MaskRange> {
    let mut anchors = Vec::new();
    let mut ranges = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for rule in rules {
        let Some(regex) = rule.regex.as_ref() else {
            continue;
        };
        if rule.kind != MaskRuleKind::Regex || !rule.has_prefilter(normalized) {
            continue;
        }
        for keyword in &rule.prefilter {
            if keyword.is_empty() {
                continue;
            }
            let mut from = 0usize;
            while from < value.len() {
                let Some(rel) = value[from..].find(keyword) else {
                    break;
                };
                let keyword_index = from + rel;
                if let Ok(Some(found)) = regex.find_from_pos(value, keyword_index) {
                    if found.start() == keyword_index && !found.as_str().is_empty() {
                        let start = found.start();
                        let end = found.end();
                        let anchor_key = format!("{start}:{end}");
                        if seen.insert(anchor_key) {
                            anchors.push(AccessKeyAnchor { start, end, rule });
                            ranges.push(MaskRange {
                                start,
                                end,
                                replacement: build_mask_replacement(
                                    &rule.replacement,
                                    rule.mask_type,
                                    found.as_str(),
                                    replacement_mode,
                                ),
                                rule_id: rule.id.clone(),
                                mask_type: rule.mask_type,
                            });
                        }
                        from = end;
                        continue;
                    }
                }
                from = keyword_index + keyword.len().max(1);
            }
        }
    }

    anchors.sort_by(|left, right| left.start.cmp(&right.start).then(left.end.cmp(&right.end)));
    for index in 0..anchors.len() {
        let anchor = &anchors[index];
        let next_anchor_start = anchors
            .get(index + 1)
            .map(|item| item.start)
            .unwrap_or(value.len());
        let search_start = anchor.end;
        let lookahead_end = add_chars(value, search_start, ACCESS_KEY_SECRET_LOOKAHEAD_CHARS);
        let search_end = value.len().min(lookahead_end).min(next_anchor_start);
        if search_start < search_end {
            let stop_at_known_anchor =
                search_end == next_anchor_start && next_anchor_start < value.len();
            ranges.extend(scan_access_key_secret_candidates(
                value,
                search_start,
                search_end,
                anchor.rule.mask_type,
                replacement_mode,
                stop_at_known_anchor,
            ));
        }
    }
    ranges
}

struct SecretToken {
    start: Option<usize>,
    end: usize,
    length: usize,
    padding: usize,
    invalid: bool,
    upper: bool,
    lower: bool,
    digit: bool,
}

fn scan_access_key_secret_candidates(
    value: &str,
    start: usize,
    end: usize,
    mask_type: MaskType,
    replacement_mode: MaskReplacementMode,
    stop_at_known_anchor: bool,
) -> Vec<MaskRange> {
    let mut ranges = Vec::new();
    let mut token = SecretToken {
        start: None,
        end: 0,
        length: 0,
        padding: 0,
        invalid: false,
        upper: false,
        lower: false,
        digit: false,
    };
    let mut can_start_token = true;

    let finish = |token: &mut SecretToken,
                  include_padding: bool,
                  ranges: &mut Vec<MaskRange>,
                  value: &str| {
        let actual_padding = if include_padding && token.padding <= 2 {
            token.padding
        } else {
            0
        };
        let candidate_length = token.length + actual_padding;
        if token.start.is_some()
            && !token.invalid
            && token.padding <= 2
            && (ACCESS_KEY_SECRET_MIN_LENGTH..=ACCESS_KEY_SECRET_MAX_LENGTH)
                .contains(&candidate_length)
            && token.upper
            && token.lower
            && token.digit
        {
            let token_start = token.start.unwrap_or(0);
            let candidate_end = token.end + actual_padding;
            let raw = &value[token_start..candidate_end];
            let replacement = if replacement_mode == MaskReplacementMode::Preview {
                build_mask_replacement(
                    ACCESS_KEY_SECRET_REPLACEMENT,
                    mask_type,
                    raw,
                    replacement_mode,
                )
            } else {
                ACCESS_KEY_SECRET_REPLACEMENT.to_string()
            };
            ranges.push(MaskRange {
                start: token_start,
                end: candidate_end,
                replacement,
                rule_id: ACCESS_KEY_SECRET_RULE_ID.to_string(),
                mask_type,
            });
        }
        *token = SecretToken {
            start: None,
            end: 0,
            length: 0,
            padding: 0,
            invalid: false,
            upper: false,
            lower: false,
            digit: false,
        };
    };

    let mut index = start;
    while index < end {
        let code = code_at(value, index);
        let next = index + super::types::char_len_at(value, index).max(1);
        if is_access_key_secret_body_char(code) {
            if token.start.is_some() && token.padding > 0 {
                finish(&mut token, false, &mut ranges, value);
                can_start_token = true;
            }
            if token.start.is_none() {
                if !can_start_token {
                    index = next;
                    continue;
                }
                token.start = Some(index);
            }
            token.length += 1;
            token.end = next;
            if token.length > ACCESS_KEY_SECRET_MAX_LENGTH {
                token.invalid = true;
            }
            if (b'A' as i32..=b'Z' as i32).contains(&code) {
                token.upper = true;
            } else if (b'a' as i32..=b'z' as i32).contains(&code) {
                token.lower = true;
            } else if (b'0' as i32..=b'9' as i32).contains(&code) {
                token.digit = true;
            }
            can_start_token = false;
            index = next;
            continue;
        }
        if code == '=' as i32 {
            if token.start.is_some() {
                token.padding += 1;
                if token.padding > 2 {
                    token.invalid = true;
                }
                can_start_token = false;
            } else {
                can_start_token = true;
            }
            index = next;
            continue;
        }
        if token.start.is_some() {
            finish(&mut token, true, &mut ranges, value);
        }
        can_start_token = true;
        index = next;
    }

    let next_code = if end < value.len() {
        code_at(value, end)
    } else {
        -1
    };
    let token_continues = is_access_key_secret_body_char(next_code) || next_code == '=' as i32;
    if (stop_at_known_anchor || !token_continues) && token.start.is_some() {
        finish(&mut token, true, &mut ranges, value);
    }
    ranges
}

fn is_access_key_secret_body_char(code: i32) -> bool {
    (b'A' as i32..=b'Z' as i32).contains(&code)
        || (b'a' as i32..=b'z' as i32).contains(&code)
        || (b'0' as i32..=b'9' as i32).contains(&code)
        || code == '+' as i32
        || code == '-' as i32
        || code == '/' as i32
        || code == '_' as i32
}

pub fn find_first_sensitive_match(
    value: &str,
    rules: &[CompiledMaskRule],
    options: &StringMaskOptions,
) -> Option<MaskRange> {
    let ranges = collect_sensitive_ranges(value, rules, options, MaskReplacementMode::Placeholder);
    ranges.into_iter().reduce(|first, range| {
        if range.start < first.start || (range.start == first.start && range.end > first.end) {
            range
        } else {
            first
        }
    })
}

fn collect_large_string_ranges(
    value: &str,
    normalized: &str,
    rules: &[&CompiledMaskRule],
    replacement_mode: MaskReplacementMode,
    options: &ResolvedStringMaskOptions,
) -> Vec<MaskRange> {
    let windows = build_keyword_windows(normalized, rules, options.keyword_context_window);
    if windows.is_empty() {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    for window in windows {
        let start = floor_char_boundary(value, window.0);
        let end = ceil_char_boundary(value, window.1);
        if start >= end {
            continue;
        }
        ranges.extend(collect_ranges_for_segment(
            &value[start..end],
            &normalized[start..end],
            start,
            rules,
            replacement_mode,
            options,
        ));
    }
    ranges
}

fn build_keyword_windows(
    normalized: &str,
    rules: &[&CompiledMaskRule],
    context_window: usize,
) -> Vec<(usize, usize)> {
    let mut windows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for rule in rules {
        for keyword in &rule.normalized_prefilter {
            if !seen.insert(keyword.clone()) {
                continue;
            }
            let mut from = 0usize;
            while from < normalized.len() {
                let Some(rel) = normalized[from..].find(keyword) else {
                    break;
                };
                let index = from + rel;
                let start = index.saturating_sub(context_window);
                let end = normalized.len().min(index + keyword.len() + context_window);
                windows.push((start, end));
                from = index + keyword.len().max(1);
            }
        }
    }
    if windows.len() <= 1 {
        return windows;
    }
    windows.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for window in windows {
        if let Some(previous) = merged.last_mut() {
            if window.0 <= previous.1 {
                previous.1 = previous.1.max(window.1);
                continue;
            }
        }
        merged.push(window);
    }
    merged
}

fn collect_ranges_for_segment(
    segment: &str,
    normalized_segment: &str,
    offset: usize,
    rules: &[&CompiledMaskRule],
    replacement_mode: MaskReplacementMode,
    options: &ResolvedStringMaskOptions,
) -> Vec<MaskRange> {
    let mut ranges = Vec::new();
    for rule in rules {
        if !rule.has_prefilter(normalized_segment) {
            continue;
        }
        match rule.kind {
            MaskRuleKind::Regex if rule.regex.is_some() => {
                ranges.extend(collect_regex_ranges(
                    segment,
                    offset,
                    rule,
                    replacement_mode,
                ));
            }
            MaskRuleKind::Block if rule.block_regex.is_some() => {
                ranges.extend(collect_block_ranges(
                    segment,
                    offset,
                    rule,
                    replacement_mode,
                    options.private_key_block_limit,
                ));
            }
            MaskRuleKind::UrlWithPassword if rule.scheme_set.is_some() => {
                ranges.extend(collect_url_with_password_ranges(
                    segment,
                    offset,
                    rule,
                    replacement_mode,
                ));
            }
            _ => {}
        }
    }
    ranges
}

fn collect_regex_ranges(
    segment: &str,
    offset: usize,
    rule: &CompiledMaskRule,
    replacement_mode: MaskReplacementMode,
) -> Vec<MaskRange> {
    let Some(regex) = rule.regex.as_ref() else {
        return Vec::new();
    };
    let mut ranges = Vec::new();
    for found in regex.find_iter(segment).flatten() {
        if found.as_str().is_empty() {
            continue;
        }
        ranges.push(MaskRange {
            start: offset + found.start(),
            end: offset + found.end(),
            replacement: build_mask_replacement(
                &rule.replacement,
                rule.mask_type,
                found.as_str(),
                replacement_mode,
            ),
            rule_id: rule.id.clone(),
            mask_type: rule.mask_type,
        });
    }
    ranges
}

fn collect_block_ranges(
    segment: &str,
    offset: usize,
    rule: &CompiledMaskRule,
    replacement_mode: MaskReplacementMode,
    block_limit: usize,
) -> Vec<MaskRange> {
    let Some(regex) = rule.block_regex.as_ref() else {
        return Vec::new();
    };
    let mut ranges = Vec::new();
    for found in regex.find_iter(segment).flatten() {
        if found.as_str().is_empty() || found.as_str().len() > block_limit {
            continue;
        }
        ranges.push(MaskRange {
            start: offset + found.start(),
            end: offset + found.end(),
            replacement: build_mask_replacement(
                &rule.replacement,
                rule.mask_type,
                found.as_str(),
                replacement_mode,
            ),
            rule_id: rule.id.clone(),
            mask_type: rule.mask_type,
        });
    }
    ranges
}

fn collect_url_with_password_ranges(
    segment: &str,
    offset: usize,
    rule: &CompiledMaskRule,
    replacement_mode: MaskReplacementMode,
) -> Vec<MaskRange> {
    let mut ranges = Vec::new();
    for found in URL_CANDIDATE.find_iter(segment) {
        if found.as_str().is_empty() {
            continue;
        }
        let candidate = trim_url_candidate(found.as_str());
        if candidate.is_empty() || !is_database_url_with_password(candidate, rule) {
            continue;
        }
        ranges.push(MaskRange {
            start: offset + found.start(),
            end: offset + found.start() + candidate.len(),
            replacement: build_mask_replacement(
                &rule.replacement,
                rule.mask_type,
                candidate,
                replacement_mode,
            ),
            rule_id: rule.id.clone(),
            mask_type: rule.mask_type,
        });
    }
    ranges
}

fn trim_url_candidate(candidate: &str) -> &str {
    candidate.trim_end_matches([')', ',', '.', ';', ']', '}'])
}

fn is_database_url_with_password(candidate: &str, rule: &CompiledMaskRule) -> bool {
    let Some(parsed) = parse_standard_url(candidate) else {
        return false;
    };
    let scheme = parsed.protocol.trim_end_matches(':');
    rule.scheme_set
        .as_ref()
        .is_some_and(|set| set.contains(scheme) && !parsed.password.is_empty())
}

fn lowercase_ascii(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii() {
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

fn add_chars(value: &str, start: usize, count: usize) -> usize {
    let mut index = start;
    for _ in 0..count {
        if index >= value.len() {
            break;
        }
        let len = super::types::char_len_at(value, index);
        if len == 0 {
            break;
        }
        index += len;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::{
        collect_sensitive_ranges, find_first_sensitive_match, CompiledMaskRule,
        MaskReplacementMode, StringMaskOptions,
    };
    use crate::mask::rule_loader::load_enabled_rules;
    use crate::mask::types::{MaskConfig, MaskMode};

    fn all_rules() -> Vec<CompiledMaskRule> {
        load_enabled_rules(&MaskConfig {
            mode: MaskMode::All,
            types: Vec::new(),
            replacement_mode: None,
        })
    }

    #[test]
    fn finds_cloud_access_keys_api_keys_private_keys_and_database_urls() {
        let rules = all_rules();
        let options = StringMaskOptions::default();
        assert_eq!(
            find_first_sensitive_match("aliyun=LTAI1234567890ABCD", &rules, &options)
                .unwrap()
                .replacement,
            "[ACCESSKEY_MASKED]"
        );
        assert_eq!(
            find_first_sensitive_match("aws=AKIAIOSFODNN7EXAMPLE", &rules, &options)
                .unwrap()
                .replacement,
            "[ACCESSKEY_MASKED]"
        );
        assert_eq!(
            find_first_sensitive_match("openai=sk-1234567890abcdefghijklmnop", &rules, &options)
                .unwrap()
                .replacement,
            "[APIKEY_MASKED]"
        );
        assert_eq!(
            find_first_sensitive_match(
                "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----",
                &rules,
                &options,
            )
            .unwrap()
            .replacement,
            "[PRIVATEKEY_MASKED]"
        );
        assert_eq!(
            find_first_sensitive_match(
                "mysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot",
                &rules,
                &options,
            )
            .unwrap()
            .replacement,
            "[DATABASEURL_MASKED]"
        );
        assert_eq!(
            find_first_sensitive_match(
                "jdbc:mysql://localhost:3306/db?user=root&password=MySynthMysql12",
                &rules,
                &options,
            )
            .unwrap()
            .replacement,
            "[DATABASEURL_MASKED]"
        );
    }

    #[test]
    fn does_not_match_short_keys_or_passwordless_database_urls() {
        let rules = all_rules();
        let options = StringMaskOptions::default();
        assert!(find_first_sensitive_match("short_aliyun=LTAI123", &rules, &options).is_none());
        assert!(
            find_first_sensitive_match("mysql://localhost:3306/pilot", &rules, &options).is_none()
        );
        assert!(collect_sensitive_ranges(
            "hello world",
            &rules,
            &options,
            MaskReplacementMode::Placeholder
        )
        .is_empty());
    }

    #[test]
    fn returns_the_leftmost_secret_when_several_types_appear() {
        let rules = all_rules();
        let hit = find_first_sensitive_match(
            "sk-1234567890abcdefghijklmnop then LTAI1234567890ABCD",
            &rules,
            &StringMaskOptions::default(),
        )
        .unwrap();
        assert_eq!(hit.replacement, "[APIKEY_MASKED]");
        assert_eq!(hit.rule_id, "apiKey.openaiCompatible");
    }
}
