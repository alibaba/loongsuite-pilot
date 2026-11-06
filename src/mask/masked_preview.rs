//! Star-masked previews appended to fixed markers when replacement mode is `preview`.

use super::types::{MaskReplacementMode, MaskType};
use regex::Regex;
use std::sync::LazyLock;

static PRIVATE_KEY_PREVIEW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END [A-Z ]*PRIVATE KEY-----$")
        .expect("private key preview pattern")
});

static JDBC_PREVIEW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(jdbc:(?:mysql|postgresql)://)([^/]+)(/.*)?$").expect("jdbc preview pattern")
});

pub const MAX_MASKED_PREVIEW_LENGTH: usize = 512;

const API_KEY_PREFIXES: &[&str] = &["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "sk-"];

/// Build the final replacement only after a detector has confirmed the type.
/// Any malformed or unexpectedly large preview falls back to the existing marker.
pub fn build_mask_replacement(
    marker: &str,
    mask_type: MaskType,
    raw_value: &str,
    mode: MaskReplacementMode,
) -> String {
    if mode != MaskReplacementMode::Preview {
        return marker.to_string();
    }
    let Some(preview) = build_masked_preview(mask_type, raw_value) else {
        return marker.to_string();
    };
    if preview.is_empty()
        || preview.chars().count() > MAX_MASKED_PREVIEW_LENGTH
        || preview
            .chars()
            .any(|ch| matches!(ch, '{' | '}' | '\r' | '\n'))
    {
        return marker.to_string();
    }
    format!("{marker}{{{preview}}}")
}

fn build_masked_preview(mask_type: MaskType, raw_value: &str) -> Option<String> {
    match mask_type {
        MaskType::CloudAccessKey => Some(mask_middle(raw_value, 4, 4)),
        MaskType::ApiKey => Some(mask_api_key(raw_value)),
        MaskType::PrivateKey => mask_private_key(raw_value),
        MaskType::DatabaseUrl => mask_database_url(raw_value),
        MaskType::IdCard => Some(mask_middle(raw_value, 4, 4)),
        MaskType::Phone => mask_phone(raw_value),
        MaskType::Email => mask_email(raw_value),
        MaskType::IpAddress => mask_ipv4(raw_value),
        MaskType::BankCard => mask_bank_card(raw_value),
    }
}

fn mask_api_key(value: &str) -> String {
    let normalized = value.to_ascii_lowercase();
    let prefix = API_KEY_PREFIXES
        .iter()
        .copied()
        .find(|candidate| normalized.starts_with(candidate));
    let Some(prefix) = prefix else {
        return mask_middle(value, 2, 4);
    };
    let body = &value[prefix.len()..];
    format!("{}{}", &value[..prefix.len()], mask_middle(body, 1, 4))
}

fn mask_phone(value: &str) -> Option<String> {
    let mut digits: String = value.chars().filter(|ch| ch.is_ascii_digit()).collect();
    if digits.starts_with("0086") && digits.len() == 15 {
        digits = digits[4..].to_string();
    } else if digits.starts_with("86") && digits.len() == 13 {
        digits = digits[2..].to_string();
    }

    if is_mobile_digits(&digits) {
        return Some(format!(
            "{}****{}",
            &digits[..3],
            &digits[digits.len() - 4..]
        ));
    }
    if !is_landline_digits(&digits) {
        return None;
    }
    let area_code = formatted_area(value).unwrap_or_else(|| {
        let width = if digits.len() >= 12 { 4 } else { 3 };
        digits[..width].to_string()
    });
    let subscriber_length = digits.len().saturating_sub(area_code.len());
    if subscriber_length < 5 {
        return None;
    }
    Some(format!(
        "{}{}{}",
        area_code,
        "*".repeat(subscriber_length - 4),
        &digits[digits.len() - 4..]
    ))
}

fn is_mobile_digits(digits: &str) -> bool {
    let bytes = digits.as_bytes();
    bytes.len() == 11
        && bytes[0] == b'1'
        && (b'3'..=b'9').contains(&bytes[1])
        && bytes[2..].iter().all(|b| b.is_ascii_digit())
}

fn is_landline_digits(digits: &str) -> bool {
    let bytes = digits.as_bytes();
    (10..=12).contains(&bytes.len())
        && bytes[0] == b'0'
        && bytes[1..].iter().all(|b| b.is_ascii_digit())
}

fn formatted_area(value: &str) -> Option<String> {
    if let Some(rest) = value.strip_prefix('(') {
        if let Some(end) = rest.find(')') {
            let area = &rest[..end];
            if is_area_code(area) {
                return Some(area.to_string());
            }
        }
    }
    if let Some(end) = value.find('-') {
        let area = &value[..end];
        if is_area_code(area) {
            return Some(area.to_string());
        }
    }
    None
}

fn is_area_code(area: &str) -> bool {
    let bytes = area.as_bytes();
    (bytes.len() == 3 || bytes.len() == 4)
        && bytes[0] == b'0'
        && bytes[1..].iter().all(|b| b.is_ascii_digit())
}

fn mask_bank_card(value: &str) -> Option<String> {
    let digits: String = value
        .chars()
        .filter(|ch| *ch != ' ' && *ch != '-')
        .collect();
    if !(15..=19).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(mask_middle(&digits, 6, 4))
}

fn mask_email(value: &str) -> Option<String> {
    let at_index = value.rfind('@')?;
    if at_index == 0 || at_index + 1 >= value.len() {
        return None;
    }
    let local = &value[..at_index];
    let domain = value[at_index + 1..].to_ascii_lowercase();
    let local_chars = local.chars().count();
    let masked_local = if local_chars >= 6 {
        mask_middle(local, 2, 2)
    } else if local_chars >= 3 {
        mask_middle(local, 1, 1)
    } else if local_chars == 2 {
        format!("{}*", local.chars().next().unwrap_or('*'))
    } else {
        format!("{local}*")
    };
    Some(format!("{masked_local}@{domain}"))
}

pub(crate) fn mask_ipv4(value: &str) -> Option<String> {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 4 || parts.iter().any(|part| !is_ipv4_octet_text(part)) {
        return None;
    }
    Some(format!("{}.*.*.{}", parts[0], parts[3]))
}

fn is_ipv4_octet_text(part: &str) -> bool {
    (1..=3).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit())
}

fn mask_private_key(value: &str) -> Option<String> {
    let caps = PRIVATE_KEY_PREVIEW.captures(value)?;
    let key_type = caps.get(1)?.as_str().trim();
    let compact: String = caps
        .get(2)?
        .as_str()
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    if compact.len() < 8 {
        return None;
    }
    Some(format!(
        "{key_type}:{}********{}",
        &compact[..4],
        &compact[compact.len() - 4..]
    ))
}

fn mask_database_url(value: &str) -> Option<String> {
    if value.len() >= 5 && value[..5].eq_ignore_ascii_case("jdbc:") {
        return mask_jdbc_url(value);
    }
    let parsed = parse_standard_url(value)?;
    let user_info = if !parsed.username.is_empty() || !parsed.password.is_empty() {
        format!("{}:****@", parsed.username)
    } else {
        String::new()
    };
    let hostname = mask_ipv4(&parsed.hostname).unwrap_or(parsed.hostname);
    let port = if parsed.port.is_empty() {
        String::new()
    } else {
        format!(":{}", parsed.port)
    };
    Some(format!(
        "{}//{user_info}{hostname}{port}{}",
        parsed.protocol, parsed.pathname
    ))
}

fn mask_jdbc_url(value: &str) -> Option<String> {
    let parameter_index = value.find(['?', ';']);
    let without_parameters = match parameter_index {
        Some(index) => &value[..index],
        None => value,
    };
    let caps = JDBC_PREVIEW.captures(without_parameters)?;
    let prefix = caps.get(1)?.as_str();
    let authority = caps.get(2)?.as_str();
    let path = caps.get(3).map(|m| m.as_str()).unwrap_or("");
    Some(format!(
        "{prefix}{}{path}",
        mask_database_authority(authority)
    ))
}

fn mask_database_authority(authority: &str) -> String {
    let (raw_user_info, raw_host) = match authority.rfind('@') {
        Some(index) => (&authority[..index], &authority[index + 1..]),
        None => ("", authority),
    };
    let username = match raw_user_info.find(':') {
        Some(index) => &raw_user_info[..index],
        None => raw_user_info,
    };
    let host = match split_ipv4_host(raw_host) {
        Some((ip, port)) => format!("{}{port}", mask_ipv4(ip).unwrap_or_else(|| ip.to_string())),
        None => raw_host.to_string(),
    };
    if raw_user_info.is_empty() {
        host
    } else {
        format!("{username}:****@{host}")
    }
}

fn split_ipv4_host(raw_host: &str) -> Option<(&str, &str)> {
    let (host, port) = match raw_host.rfind(':') {
        Some(index) => (&raw_host[..index], &raw_host[index..]),
        None => (raw_host, ""),
    };
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 || parts.iter().any(|part| !is_ipv4_octet_text(part)) {
        return None;
    }
    if !port.is_empty() && !port[1..].bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((host, port))
}

fn mask_middle(value: &str, keep_start: usize, keep_end: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    let len = chars.len();
    if len > keep_start + keep_end {
        let stars = len - keep_start - keep_end;
        return format!(
            "{}{}{}",
            chars[..keep_start].iter().collect::<String>(),
            "*".repeat(stars),
            chars[len - keep_end..].iter().collect::<String>()
        );
    }
    if len >= 5 {
        let stars = len - 4;
        return format!(
            "{}{}{}",
            chars[..2].iter().collect::<String>(),
            "*".repeat(stars),
            chars[len - 2..].iter().collect::<String>()
        );
    }
    if len >= 3 {
        let stars = len - 2;
        return format!("{}{}{}", chars[0], "*".repeat(stars), chars[len - 1]);
    }
    if len == 2 {
        return format!("{}*", chars[0]);
    }
    format!("{value}*")
}

pub(crate) struct ParsedDatabaseUrl {
    pub protocol: String,
    pub username: String,
    pub password: String,
    pub hostname: String,
    pub port: String,
    pub pathname: String,
}

pub(crate) fn parse_standard_url(raw: &str) -> Option<ParsedDatabaseUrl> {
    let scheme_end = raw.find("://")?;
    let scheme = &raw[..scheme_end];
    if !is_scheme(scheme) {
        return None;
    }
    let protocol = format!("{}:", scheme.to_ascii_lowercase());
    let rest = &raw[scheme_end + 3..];
    let before_fragment = rest.split_once('#').map(|(head, _)| head).unwrap_or(rest);
    let before_query = before_fragment
        .split_once('?')
        .map(|(head, _)| head)
        .unwrap_or(before_fragment);
    let (authority, pathname) = match before_query.find('/') {
        Some(index) => (&before_query[..index], before_query[index..].to_string()),
        None => (before_query, String::new()),
    };
    if authority.is_empty() {
        return None;
    }
    let (userinfo, hostport) = match authority.rfind('@') {
        Some(index) => (&authority[..index], &authority[index + 1..]),
        None => ("", authority),
    };
    let (username, password) = if authority.contains('@') {
        match userinfo.find(':') {
            Some(index) => (&userinfo[..index], &userinfo[index + 1..]),
            None => (userinfo, ""),
        }
    } else {
        ("", "")
    };
    let (hostname, port) = split_host_port(hostport)?;
    if hostname.is_empty() {
        return None;
    }
    Some(ParsedDatabaseUrl {
        protocol,
        username: percent_decode(username),
        password: percent_decode(password),
        hostname,
        port,
        pathname,
    })
}

fn is_scheme(scheme: &str) -> bool {
    let mut chars = scheme.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '.' | '-'))
}

fn split_host_port(hostport: &str) -> Option<(String, String)> {
    if let Some(rest) = hostport.strip_prefix('[') {
        let end = rest.find(']')?;
        let host = &rest[..end];
        let after = &rest[end + 1..];
        if after.is_empty() {
            return Some((host.to_string(), String::new()));
        }
        let port = after.strip_prefix(':')?;
        if !is_port(port) {
            return None;
        }
        return Some((host.to_string(), port.to_string()));
    }
    if let Some(index) = hostport.rfind(':') {
        let host = &hostport[..index];
        let port = &hostport[index + 1..];
        if host.is_empty() || !is_port(port) {
            return None;
        }
        return Some((host.to_ascii_lowercase(), port.to_string()));
    }
    Some((hostport.to_ascii_lowercase(), String::new()))
}

fn is_port(port: &str) -> bool {
    !port.is_empty()
        && port.len() <= 5
        && port.bytes().all(|b| b.is_ascii_digit())
        && port.parse::<u32>().ok().is_some_and(|value| value <= 65535)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::build_mask_replacement;
    use crate::mask::rule_loader::load_mask_plan;
    use crate::mask::string_masker::mask_string;
    use crate::mask::types::{
        MaskConfig, MaskMode, MaskReplacementMode, MaskType, PlanOrRules, StringMaskOptions,
    };

    fn preview_plan() -> crate::mask::types::MaskPlan {
        load_mask_plan(&MaskConfig {
            mode: MaskMode::All,
            types: Vec::new(),
            replacement_mode: Some(MaskReplacementMode::Preview),
        })
    }

    fn placeholder_plan() -> crate::mask::types::MaskPlan {
        load_mask_plan(&MaskConfig {
            mode: MaskMode::All,
            types: Vec::new(),
            replacement_mode: Some(MaskReplacementMode::Placeholder),
        })
    }

    fn mask_with(value: &str, plan: &crate::mask::types::MaskPlan) -> String {
        mask_string(
            value,
            PlanOrRules::Plan(plan),
            &StringMaskOptions::default(),
        )
        .into_owned()
    }

    fn synthetic_access_key() -> String {
        ["LTAI123456", "7890ABCD"].concat()
    }

    fn synthetic_api_key() -> String {
        ["sk-1234567890", "abcdefghijklmnop"].concat()
    }

    fn synthetic_private_key() -> String {
        [
            ["-----BEGIN OPENSSH ", "PRIVATE KEY-----"].concat(),
            "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=".to_string(),
            ["-----END OPENSSH ", "PRIVATE KEY-----"].concat(),
        ]
        .join("\n")
    }

    #[test]
    fn keeps_placeholder_output_byte_compatible_by_default() {
        let plan = placeholder_plan();
        assert_eq!(
            mask_with("phone=13800138000", &plan),
            "phone=[PHONE_MASKED]"
        );
        assert_eq!(
            mask_with("mysql://agent:****@db.example.com/orders", &plan),
            "[DATABASEURL_MASKED]"
        );
    }

    #[test]
    fn builds_stable_previews_for_access_keys_and_api_keys() {
        let access_key = synthetic_access_key();
        let api_key = synthetic_api_key();
        let masked = mask_with(&format!("{access_key}|{api_key}"), &preview_plan());
        assert_eq!(
            masked,
            format!(
                "[ACCESSKEY_MASKED]{{LTAI{}ABCD}}|[APIKEY_MASKED]{{sk-1{}mnop}}",
                "*".repeat(10),
                "*".repeat(21)
            )
        );
    }

    #[test]
    fn builds_a_fixed_length_private_key_preview_without_line_breaks() {
        assert_eq!(
            mask_with(&synthetic_private_key(), &preview_plan()),
            "[PRIVATEKEY_MASKED]{OPENSSH PRIVATE KEY:b3Bl********bmU=}"
        );
    }

    #[test]
    fn does_not_trust_an_unmasked_value_inside_a_preview_shaped_token() {
        let plan = preview_plan();
        let placeholder = placeholder_plan();
        let cases = [
            ("APIKEY", synthetic_api_key()),
            ("PHONE", "13800138000".to_string()),
            ("EMAIL", "alice@example.com".to_string()),
        ];
        for (marker, raw) in cases {
            let input = format!("[{marker}_MASKED]{{{raw}}}");
            assert!(!mask_with(&input, &placeholder).contains(&raw));
            assert!(!mask_with(&input, &plan).contains(&raw));
        }
    }

    #[test]
    fn drops_database_query_and_fragment_and_masks_password_and_ipv4() {
        let standard = "mysql://agent:secret@192.168.1.20:3306/orders?token=abc#debug";
        let jdbc = "jdbc:mysql://192.168.1.20:3306/orders?user=root&password=secret&token=abc";
        assert_eq!(
            mask_with(&format!("{standard}|{jdbc}"), &preview_plan()),
            "[DATABASEURL_MASKED]{mysql://agent:****@192.*.*.20:3306/orders}|[DATABASEURL_MASKED]{jdbc:mysql://192.*.*.20:3306/orders}"
        );
    }

    #[test]
    fn builds_previews_for_id_card_email_ipv4_and_bank_card() {
        let input = [
            "11010519491231002X",
            "zhangsan@example.com",
            "192.168.1.10",
            "6221 2600 0000 0000",
        ]
        .join("|");
        assert_eq!(
            mask_with(&input, &preview_plan()),
            "[IDCARD_MASKED]{1101**********002X}|[EMAIL_MASKED]{zh****an@example.com}|[IP_ADDRESS_MASKED]{192.*.*.10}|[CREDIT_CARD_MASKED]{622126******0000}"
        );
    }

    #[test]
    fn normalizes_equivalent_mobile_and_landline_formats_before_previewing() {
        let input = [
            "13800138000",
            "138-0013-8000",
            "+86 138 0013 8000",
            "010-12345678",
            "(010)12345678",
        ]
        .join("|");
        assert_eq!(
            mask_with(&input, &preview_plan()),
            [
                "[PHONE_MASKED]{138****8000}",
                "[PHONE_MASKED]{138****8000}",
                "[PHONE_MASKED]{138****8000}",
                "[PHONE_MASKED]{010****5678}",
                "[PHONE_MASKED]{010****5678}",
            ]
            .join("|")
        );
    }

    #[test]
    fn masks_a_database_url_immediately_before_an_existing_preview_token() {
        let preview = preview_plan();
        let placeholder = placeholder_plan();
        let cases = [
            (
                "mysql://agent:secret@192.168.1.20:3306/orders",
                "[DATABASEURL_MASKED]{mysql://agent:****@192.*.*.20:3306/orders}",
            ),
            (
                "jdbc:mysql://db.example.com/orders?user=root&password=secret",
                "[DATABASEURL_MASKED]{jdbc:mysql://db.example.com/orders}",
            ),
        ];
        let existing = "[PHONE_MASKED]{138****8000}";
        for (database_url, expected) in cases {
            assert_eq!(
                mask_with(&format!("{database_url}{existing}"), &preview),
                format!("{expected}{existing}")
            );
            assert_eq!(
                mask_with(&format!("{database_url}{existing}"), &placeholder),
                format!("[DATABASEURL_MASKED]{existing}")
            );
        }
    }

    #[test]
    fn is_idempotent_for_all_generated_preview_token_types() {
        let plan = preview_plan();
        let raw_values = [
            synthetic_access_key(),
            synthetic_api_key(),
            synthetic_private_key(),
            "mysql://agent:secret@192.168.1.20:3306/orders?token=abc#debug".to_string(),
            "jdbc:mysql://db.example.com/orders?user=root&password=secret".to_string(),
            "11010519491231002X".to_string(),
            "13800138000".to_string(),
            "zhangsan@example.com".to_string(),
            "192.168.1.10".to_string(),
            "6221 2600 0000 0000".to_string(),
        ];
        let once = raw_values
            .iter()
            .map(|value| mask_with(value, &plan))
            .collect::<Vec<_>>()
            .join("|");
        assert_eq!(mask_with(&once, &plan), once);
    }

    #[test]
    fn keeps_old_and_preview_tokens_while_masking_new_plaintext() {
        let plan = preview_plan();
        let existing = mask_with("zhangsan@example.com", &plan);
        let input = format!("[PHONE_MASKED]|{existing}|13800138000");
        assert_eq!(
            mask_with(&input, &plan),
            format!("[PHONE_MASKED]|{existing}|[PHONE_MASKED]{{138****8000}}")
        );
    }

    #[test]
    fn falls_back_to_the_fixed_marker_when_a_preview_is_unsafe_or_too_long() {
        assert_eq!(
            build_mask_replacement(
                "[DATABASEURL_MASKED]",
                MaskType::DatabaseUrl,
                &format!("mysql://{}:secret@db.example.com/orders", "a".repeat(600)),
                MaskReplacementMode::Preview,
            ),
            "[DATABASEURL_MASKED]"
        );
        assert_eq!(
            build_mask_replacement(
                "[EMAIL_MASKED]",
                MaskType::Email,
                "a@example.{com",
                MaskReplacementMode::Preview,
            ),
            "[EMAIL_MASKED]"
        );
    }
}
