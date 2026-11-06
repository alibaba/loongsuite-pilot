//! Built-in detectors for mainland China ID cards, phones, emails, IPv4, and bank cards.

use super::masked_preview::build_mask_replacement;
use super::types::{char_len_at, code_at, prev_char, MaskRange, MaskReplacementMode, MaskType};
use chrono::Datelike;

const MAX_PHONE_CANDIDATE_LENGTH: usize = 18;
const MAX_BANK_CARD_CANDIDATE_LENGTH: usize = 37;
const MAX_EMAIL_LENGTH: usize = 254;
const MAX_EMAIL_LOCAL_LENGTH: usize = 64;
const MAX_EMAIL_DOMAIN_LABEL_LENGTH: usize = 63;

const ID_CARD_WEIGHTS: [i32; 17] = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CARD_CHECKSUM: [char; 11] = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

fn replacement(mask_type: MaskType) -> &'static str {
    match mask_type {
        MaskType::IdCard => "[IDCARD_MASKED]",
        MaskType::Phone => "[PHONE_MASKED]",
        MaskType::Email => "[EMAIL_MASKED]",
        MaskType::IpAddress => "[IP_ADDRESS_MASKED]",
        MaskType::BankCard => "[CREDIT_CARD_MASKED]",
        MaskType::CloudAccessKey => "[ACCESSKEY_MASKED]",
        MaskType::ApiKey => "[APIKEY_MASKED]",
        MaskType::PrivateKey => "[PRIVATEKEY_MASKED]",
        MaskType::DatabaseUrl => "[DATABASEURL_MASKED]",
    }
}

pub(crate) fn collect_pii_ranges(
    value: &str,
    enabled_types: &super::types::MaskTypeSet,
    replacement_mode: MaskReplacementMode,
) -> Vec<MaskRange> {
    if value.is_empty() || enabled_types.is_empty() {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    let detect_id_card = enabled_types.contains(MaskType::IdCard);
    let detect_phone = enabled_types.contains(MaskType::Phone);
    let detect_bank_card = enabled_types.contains(MaskType::BankCard);
    let detect_ip = enabled_types.contains(MaskType::IpAddress);
    let detect_numeric = detect_id_card || detect_phone || detect_bank_card;
    let has_ascii_digit =
        (detect_numeric || detect_ip) && value.bytes().any(|b| b.is_ascii_digit());

    if detect_numeric && has_ascii_digit {
        collect_numeric_ranges(
            value,
            &mut ranges,
            detect_id_card,
            detect_phone,
            detect_bank_card,
            replacement_mode,
        );
    }
    if enabled_types.contains(MaskType::Email) && value.contains('@') {
        collect_email_ranges(value, &mut ranges, replacement_mode);
    }
    if detect_ip && has_ascii_digit && value.contains('.') {
        collect_ip_address_ranges(value, &mut ranges, replacement_mode);
    }
    ranges
}

fn collect_numeric_ranges(
    value: &str,
    ranges: &mut Vec<MaskRange>,
    detect_id_card: bool,
    detect_phone: bool,
    detect_bank_card: bool,
    replacement_mode: MaskReplacementMode,
) {
    let mut candidate_start: Option<usize> = None;
    let current_date = if detect_id_card {
        current_date_number()
    } else {
        0
    };
    let detect_formatted = detect_phone || detect_bank_card;
    let mut index = 0usize;
    loop {
        let code = if index < value.len() {
            code_at(value, index)
        } else {
            -1
        };
        if detect_id_card
            && is_ascii_digit(code)
            && (index == 0 || !is_ascii_alnum(prev_code(value, index)))
        {
            collect_id_card_at(value, index, ranges, current_date, replacement_mode);
        }
        if index < value.len() && is_numeric_candidate_char(code) {
            if candidate_start.is_none() && is_numeric_candidate_start(code) {
                candidate_start = Some(index);
            }
        } else {
            if let Some(start) = candidate_start {
                if detect_formatted {
                    collect_formatted_numeric_candidate(
                        value,
                        start,
                        index,
                        ranges,
                        detect_phone,
                        detect_bank_card,
                        replacement_mode,
                    );
                }
            }
            candidate_start = None;
        }
        if index >= value.len() {
            break;
        }
        index = step(value, index);
    }
}

fn collect_id_card_at(
    value: &str,
    start: usize,
    ranges: &mut Vec<MaskRange>,
    current_date_number: i32,
    replacement_mode: MaskReplacementMode,
) {
    let mut end = start;
    let mut chars = Vec::with_capacity(18);
    for _ in 0..18 {
        if end >= value.len() {
            return;
        }
        let Some(ch) = value[end..].chars().next() else {
            return;
        };
        chars.push(ch);
        end += ch.len_utf8();
    }
    if end < value.len() && is_ascii_alnum(code_at(value, end)) {
        return;
    }
    if chars[..17].iter().any(|ch| !ch.is_ascii_digit()) {
        return;
    }
    let last = chars[17];
    if !last.is_ascii_digit() && last != 'X' && last != 'x' {
        return;
    }
    let candidate: String = chars.iter().collect();
    if !is_valid_id_card(&candidate, current_date_number) {
        return;
    }
    ranges.push(create_range(
        value,
        start,
        end,
        MaskType::IdCard,
        replacement_mode,
    ));
}

fn current_date_number() -> i32 {
    let date = chrono::Local::now().date_naive();
    date.year() * 10_000 + date.month() as i32 * 100 + date.day() as i32
}

fn is_province(code: &str) -> bool {
    matches!(
        code,
        "11" | "12"
            | "13"
            | "14"
            | "15"
            | "21"
            | "22"
            | "23"
            | "31"
            | "32"
            | "33"
            | "34"
            | "35"
            | "36"
            | "37"
            | "41"
            | "42"
            | "43"
            | "44"
            | "45"
            | "46"
            | "50"
            | "51"
            | "52"
            | "53"
            | "54"
            | "61"
            | "62"
            | "63"
            | "64"
            | "65"
    )
}

fn is_valid_id_card(candidate: &str, current_date_number: i32) -> bool {
    if !is_province(&candidate[..2]) {
        return false;
    }
    let year: i32 = candidate[6..10].parse().unwrap_or(0);
    let month: i32 = candidate[10..12].parse().unwrap_or(0);
    let day: i32 = candidate[12..14].parse().unwrap_or(0);
    let date_number = year * 10_000 + month * 100 + day;
    if year < 1900 || date_number > current_date_number || !is_valid_calendar_date(year, month, day)
    {
        return false;
    }
    if &candidate[14..17] == "000" {
        return false;
    }
    let mut weighted_sum = 0i32;
    for (index, byte) in candidate.as_bytes()[..17].iter().enumerate() {
        weighted_sum += i32::from(byte - b'0') * ID_CARD_WEIGHTS[index];
    }
    candidate.chars().nth(17).map(|ch| ch.to_ascii_uppercase())
        == Some(ID_CARD_CHECKSUM[(weighted_sum % 11) as usize])
}

fn is_valid_calendar_date(year: i32, month: i32, day: i32) -> bool {
    if !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    let days = [
        31,
        if is_leap_year(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    day <= days[(month - 1) as usize]
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn collect_formatted_numeric_candidate(
    value: &str,
    raw_start: usize,
    raw_end: usize,
    ranges: &mut Vec<MaskRange>,
    detect_phone: bool,
    detect_bank_card: bool,
    replacement_mode: MaskReplacementMode,
) {
    let end = trim_numeric_candidate_end(value, raw_start, raw_end);
    if end <= raw_start {
        return;
    }
    let first = code_at(value, raw_start);
    let initial_phone = detect_phone && is_potential_phone_start(first);
    let initial_bank = detect_bank_card && is_potential_bank_card_start(first);
    let max_len = if initial_bank {
        MAX_BANK_CARD_CANDIDATE_LENGTH
    } else {
        MAX_PHONE_CANDIDATE_LENGTH
    };
    let full_within = end - raw_start <= max_len;
    if (initial_phone || initial_bank)
        && full_within
        && collect_validated_numeric_range(
            value,
            raw_start,
            end,
            ranges,
            initial_phone,
            initial_bank,
            replacement_mode,
        )
    {
        return;
    }

    let mut start = raw_start;
    while start < end {
        let start_code = code_at(value, start);
        let possible_phone = detect_phone && is_potential_phone_start(start_code);
        let possible_bank = detect_bank_card && is_potential_bank_card_start(start_code);
        let window = if possible_bank {
            MAX_BANK_CARD_CANDIDATE_LENGTH
        } else {
            MAX_PHONE_CANDIDATE_LENGTH
        };
        let bounded_end = end.min(start + window);
        let mut digit_count = 0usize;
        let mut sub_end = start + 1;
        while sub_end <= bounded_end {
            if is_ascii_digit(code_at(value, sub_end - 1)) {
                digit_count += 1;
            }
            let is_candidate_end = sub_end == end
                || (sub_end < value.len()
                    && code_at(value, sub_end) == ' ' as i32
                    && is_numeric_candidate_start(code_at(value, sub_end - 1)));
            if is_candidate_end && !(full_within && start == raw_start && sub_end == end) {
                let validate_phone =
                    possible_phone && is_potential_phone_digit_count(start_code, digit_count);
                let validate_bank = possible_bank && (15..=19).contains(&digit_count);
                if validate_phone || validate_bank {
                    collect_validated_numeric_range(
                        value,
                        start,
                        sub_end,
                        ranges,
                        validate_phone,
                        validate_bank,
                        replacement_mode,
                    );
                }
            }
            sub_end += 1;
        }

        let mut separator = find_from(value, ' ', start, end);
        while let Some(sep) = separator {
            if sep + 1 < end && !is_numeric_candidate_start(code_at(value, sep + 1)) {
                separator = find_from(value, ' ', sep + 1, end);
                continue;
            }
            break;
        }
        let Some(sep) = separator else { break };
        if sep + 1 >= end {
            break;
        }
        start = sep + 1;
    }
}

fn is_potential_phone_start(code: i32) -> bool {
    code == '(' as i32 || code == '+' as i32 || code == '0' as i32 || code == '1' as i32
}

fn is_potential_phone_digit_count(start_code: i32, digit_count: usize) -> bool {
    if start_code == '+' as i32 {
        return digit_count == 13;
    }
    if start_code == '1' as i32 {
        return digit_count == 11;
    }
    if start_code == '0' as i32 {
        return (10..=12).contains(&digit_count) || digit_count == 15;
    }
    start_code == '(' as i32 && (10..=12).contains(&digit_count)
}

fn is_potential_bank_card_start(code: i32) -> bool {
    (b'2' as i32..=b'6' as i32).contains(&code)
}

fn collect_validated_numeric_range(
    value: &str,
    start: usize,
    end: usize,
    ranges: &mut Vec<MaskRange>,
    detect_phone: bool,
    detect_bank_card: bool,
    replacement_mode: MaskReplacementMode,
) -> bool {
    if end <= start {
        return false;
    }
    if (start > 0 && is_ascii_alnum(prev_code(value, start)))
        || (end < value.len() && is_ascii_alnum(code_at(value, end)))
    {
        return false;
    }
    let candidate = &value[start..end];
    let mut matched = false;
    if detect_phone && is_valid_phone(candidate) {
        ranges.push(create_range(
            value,
            start,
            end,
            MaskType::Phone,
            replacement_mode,
        ));
        matched = true;
    }
    if detect_bank_card && is_valid_bank_card(candidate) {
        ranges.push(create_range(
            value,
            start,
            end,
            MaskType::BankCard,
            replacement_mode,
        ));
        matched = true;
    }
    matched
}

fn trim_numeric_candidate_end(value: &str, start: usize, raw_end: usize) -> usize {
    let mut end = raw_end;
    while end > start && is_trimmable_numeric_suffix(code_at(value, end - 1)) {
        end -= 1;
    }
    end
}

fn is_valid_phone(candidate: &str) -> bool {
    if !(10..=MAX_PHONE_CANDIDATE_LENGTH).contains(&candidate.len()) {
        return false;
    }
    if candidate.contains('(') || candidate.contains(')') {
        return is_paren_landline(candidate);
    }
    if !has_valid_simple_separators(candidate, true) {
        return false;
    }
    let compact: String = candidate
        .chars()
        .filter(|ch| *ch != ' ' && *ch != '-')
        .collect();
    if is_mobile(&compact) || is_plus86(&compact) || is_0086(&compact) {
        return true;
    }
    let bytes = compact.as_bytes();
    if bytes.first() != Some(&b'0') || bytes.get(1) == Some(&b'0') {
        return false;
    }
    is_landline_compact(&compact)
}

fn is_paren_landline(candidate: &str) -> bool {
    let Some(rest) = candidate.strip_prefix('(') else {
        return false;
    };
    let Some(close) = rest.find(')') else {
        return false;
    };
    let area = &rest[..close];
    let area_bytes = area.as_bytes();
    if !(3..=4).contains(&area_bytes.len())
        || area_bytes[0] != b'0'
        || !area_bytes[1].is_ascii_digit()
        || area_bytes[1] == b'0'
        || !area_bytes[2..].iter().all(|b| b.is_ascii_digit())
    {
        return false;
    }
    let mut after = &rest[close + 1..];
    if after.starts_with([' ', '-']) {
        after = &after[1..];
    }
    (7..=8).contains(&after.len()) && after.bytes().all(|b| b.is_ascii_digit())
}

fn is_mobile(compact: &str) -> bool {
    let bytes = compact.as_bytes();
    bytes.len() == 11
        && bytes[0] == b'1'
        && (b'3'..=b'9').contains(&bytes[1])
        && bytes[2..].iter().all(|b| b.is_ascii_digit())
}

fn is_plus86(compact: &str) -> bool {
    let bytes = compact.as_bytes();
    bytes.len() == 14
        && bytes.starts_with(b"+861")
        && (b'3'..=b'9').contains(&bytes[4])
        && bytes[5..].iter().all(|b| b.is_ascii_digit())
}

fn is_0086(compact: &str) -> bool {
    let bytes = compact.as_bytes();
    bytes.len() == 15
        && bytes.starts_with(b"00861")
        && (b'3'..=b'9').contains(&bytes[5])
        && bytes[6..].iter().all(|b| b.is_ascii_digit())
}

fn is_landline_compact(compact: &str) -> bool {
    let len = compact.len();
    (10..=12).contains(&len) && compact.bytes().all(|b| b.is_ascii_digit())
}

fn is_valid_bank_card(candidate: &str) -> bool {
    if !has_valid_simple_separators(candidate, false) {
        return false;
    }
    let digits: String = candidate
        .chars()
        .filter(|ch| *ch != ' ' && *ch != '-')
        .collect();
    if !(15..=19).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    matches_card_issuer(&digits) && passes_luhn(&digits)
}

fn has_valid_simple_separators(candidate: &str, allow_leading_plus: bool) -> bool {
    let chars: Vec<char> = candidate.chars().collect();
    for (index, ch) in chars.iter().copied().enumerate() {
        let code = ch as i32;
        if is_ascii_digit(code) {
            continue;
        }
        if allow_leading_plus && code == '+' as i32 && index == 0 {
            continue;
        }
        if code != ' ' as i32 && code != '-' as i32 {
            return false;
        }
        if index == 0
            || index + 1 >= chars.len()
            || !is_ascii_digit(chars[index - 1] as i32)
            || !is_ascii_digit(chars[index + 1] as i32)
        {
            return false;
        }
    }
    true
}

fn matches_card_issuer(digits: &str) -> bool {
    let length = digits.len();
    let prefix2: i32 = digits[..2].parse().unwrap_or(0);
    let prefix4: i32 = digits[..4].parse().unwrap_or(0);
    if digits.starts_with('4') {
        return (16..=19).contains(&length);
    }
    if (51..=55).contains(&prefix2) {
        return length == 16;
    }
    if (2221..=2720).contains(&prefix4) {
        return length == 16;
    }
    if prefix2 == 34 || prefix2 == 37 {
        return length == 15;
    }
    if digits.starts_with("6011") || digits.starts_with("65") {
        return (16..=19).contains(&length);
    }
    prefix2 == 62 && (16..=19).contains(&length)
}

fn passes_luhn(digits: &str) -> bool {
    let mut sum = 0i32;
    let mut double_digit = false;
    for byte in digits.bytes().rev() {
        let mut digit = i32::from(byte - b'0');
        if double_digit {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
        double_digit = !double_digit;
    }
    sum % 10 == 0
}

fn collect_email_ranges(
    value: &str,
    ranges: &mut Vec<MaskRange>,
    replacement_mode: MaskReplacementMode,
) {
    let mut search = 0usize;
    while let Some(rel) = value[search..].find('@') {
        let at = search + rel;
        let mut start = at;
        let mut local_len = 0usize;
        while start > 0 && local_len < MAX_EMAIL_LOCAL_LENGTH + 1 {
            let Some((prev, code)) = prev_char(value, start) else {
                break;
            };
            if !is_email_local_char(code) {
                break;
            }
            start = prev;
            local_len += 1;
        }
        let stopped_by_local_limit = prev_char(value, start)
            .map(|(_, code)| is_email_local_char(code))
            .unwrap_or(false);

        let mut end = at + 1;
        let mut span = local_len + 1;
        while end < value.len() && span <= MAX_EMAIL_LENGTH {
            let code = code_at(value, end);
            if !is_email_domain_char(code) {
                break;
            }
            end += char_len_at(value, end);
            span += 1;
        }
        while end > at + 1 {
            let Some((prev, code)) = prev_char(value, end) else {
                break;
            };
            if code != '.' as i32 {
                break;
            }
            end = prev;
            span = span.saturating_sub(1);
        }

        let next_code = if end < value.len() {
            code_at(value, end)
        } else {
            -1
        };
        let stopped_by_total_limit =
            next_code >= 0 && is_email_domain_char(next_code) && next_code != '.' as i32;
        let touches_another_at = prev_char(value, start)
            .map(|(_, code)| code == '@' as i32)
            .unwrap_or(false)
            || next_code == '@' as i32;
        let after_next = if end < value.len() {
            let next = end + char_len_at(value, end);
            if next >= value.len() {
                -1
            } else {
                code_at(value, next)
            }
        } else {
            -1
        };
        let trailing_punctuation_dot =
            next_code == '.' as i32 && (after_next < 0 || !is_email_domain_char(after_next));
        let touches_email_char = is_email_local_char(next_code) && !trailing_punctuation_dot;

        if (1..=MAX_EMAIL_LOCAL_LENGTH).contains(&local_len)
            && span <= MAX_EMAIL_LENGTH
            && !stopped_by_local_limit
            && !stopped_by_total_limit
            && !touches_another_at
            && !touches_email_char
            && is_valid_email(value, start, at, end)
        {
            ranges.push(create_range(
                value,
                start,
                end,
                MaskType::Email,
                replacement_mode,
            ));
        }
        search = at + 1;
    }
}

fn is_valid_email(value: &str, start: usize, at: usize, end: usize) -> bool {
    if code_at(value, start) == '.' as i32 || prev_code(value, at) == '.' as i32 {
        return false;
    }
    let mut index = start + char_len_at(value, start);
    while index < at {
        if code_at(value, index) == '.' as i32 && prev_code(value, index) == '.' as i32 {
            return false;
        }
        index += char_len_at(value, index);
    }
    let domain = &value[at + 1..end];
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    for label in &labels {
        let chars: Vec<char> = label.chars().collect();
        if chars.is_empty() || chars.len() > MAX_EMAIL_DOMAIN_LABEL_LENGTH {
            return false;
        }
        if !is_ascii_alnum(chars[0] as i32) || !is_ascii_alnum(chars[chars.len() - 1] as i32) {
            return false;
        }
        if chars.len() > 2 {
            for ch in &chars[1..chars.len() - 1] {
                let code = *ch as i32;
                if !is_ascii_alnum(code) && code != '-' as i32 {
                    return false;
                }
            }
        }
    }
    let tld = labels[labels.len() - 1];
    tld.chars().count() >= 2 && tld.chars().all(|ch| is_ascii_letter(ch as i32))
}

fn collect_ip_address_ranges(
    value: &str,
    ranges: &mut Vec<MaskRange>,
    replacement_mode: MaskReplacementMode,
) {
    let mut index = 0usize;
    while index < value.len() {
        let code = code_at(value, index);
        if !is_ascii_digit(code) || (index > 0 && is_digit_or_dot(prev_code(value, index))) {
            index = step(value, index);
            continue;
        }
        let mut end = index + 1;
        while end < value.len() && is_digit_or_dot(code_at(value, end)) {
            end += 1;
        }
        let mut candidate_end = end;
        while candidate_end > index && code_at(value, candidate_end - 1) == '.' as i32 {
            candidate_end -= 1;
        }
        if (7..=15).contains(&(candidate_end - index))
            && is_valid_ip_address(value, index, candidate_end)
        {
            ranges.push(create_range(
                value,
                index,
                candidate_end,
                MaskType::IpAddress,
                replacement_mode,
            ));
        }
        index = end;
    }
}

fn is_valid_ip_address(value: &str, start: usize, end: usize) -> bool {
    let bytes = value.as_bytes();
    let mut part_count = 0i32;
    let mut part_value = 0i32;
    let mut part_length = 0i32;
    let mut first_digit = -1i32;
    for byte in bytes[start..end].iter().copied().chain(*b".") {
        let code = i32::from(byte);
        if is_ascii_digit(code) {
            if part_length == 0 {
                first_digit = code;
            }
            part_length += 1;
            if part_length > 3 {
                return false;
            }
            part_value = part_value * 10 + code - 48;
            if part_value > 255 {
                return false;
            }
            continue;
        }
        if code != '.' as i32 || part_length == 0 {
            return false;
        }
        if part_length > 1 && first_digit == '0' as i32 {
            return false;
        }
        part_count += 1;
        part_value = 0;
        part_length = 0;
        first_digit = -1;
    }
    part_count == 4
}

fn create_range(
    value: &str,
    start: usize,
    end: usize,
    mask_type: MaskType,
    replacement_mode: MaskReplacementMode,
) -> MaskRange {
    MaskRange {
        start,
        end,
        replacement: build_mask_replacement(
            replacement(mask_type),
            mask_type,
            &value[start..end],
            replacement_mode,
        ),
        rule_id: format!("pii.{}", mask_type.as_str()),
        mask_type,
    }
}

fn find_from(value: &str, needle: char, from: usize, end: usize) -> Option<usize> {
    value[from..end].find(needle).map(|index| from + index)
}

fn step(value: &str, index: usize) -> usize {
    let len = char_len_at(value, index);
    if len == 0 {
        index.saturating_add(1).min(value.len())
    } else {
        index + len
    }
}

fn prev_code(value: &str, index: usize) -> i32 {
    prev_char(value, index).map(|(_, code)| code).unwrap_or(-1)
}

fn is_numeric_candidate_start(code: i32) -> bool {
    is_ascii_digit(code) || code == '+' as i32 || code == '(' as i32
}

fn is_numeric_candidate_char(code: i32) -> bool {
    is_ascii_digit(code)
        || code == ' ' as i32
        || code == '+' as i32
        || code == '-' as i32
        || code == '(' as i32
        || code == ')' as i32
}

fn is_trimmable_numeric_suffix(code: i32) -> bool {
    code == ' ' as i32 || code == '-' as i32
}

fn is_digit_or_dot(code: i32) -> bool {
    is_ascii_digit(code) || code == '.' as i32
}

fn is_email_local_char(code: i32) -> bool {
    is_ascii_alnum(code) || matches!(code, 37 | 43 | 45 | 46 | 95)
}

fn is_email_domain_char(code: i32) -> bool {
    is_ascii_alnum(code) || code == '-' as i32 || code == '.' as i32
}

fn is_ascii_alnum(code: i32) -> bool {
    is_ascii_digit(code) || is_ascii_letter(code)
}

fn is_ascii_letter(code: i32) -> bool {
    (b'A' as i32..=b'Z' as i32).contains(&code) || (b'a' as i32..=b'z' as i32).contains(&code)
}

fn is_ascii_digit(code: i32) -> bool {
    (b'0' as i32..=b'9' as i32).contains(&code)
}

#[cfg(test)]
mod tests {
    use crate::mask::rule_loader::load_mask_plan;
    use crate::mask::string_masker::{apply_mask_ranges, mask_string};
    use crate::mask::types::{
        MaskConfig, MaskMode, MaskRange, MaskType, PlanOrRules, StringMaskOptions, PII_MASK_TYPES,
    };
    use chrono::Datelike;
    use std::str::FromStr;

    fn all_pii() -> Vec<MaskType> {
        PII_MASK_TYPES
            .iter()
            .map(|name| MaskType::from_str(name).unwrap())
            .collect()
    }

    fn mask(value: &str, types: &[MaskType]) -> String {
        let plan = load_mask_plan(&MaskConfig {
            mode: MaskMode::Custom,
            types: types.to_vec(),
            replacement_mode: None,
        });
        mask_string(
            value,
            PlanOrRules::Plan(&plan),
            &StringMaskOptions::default(),
        )
        .into_owned()
    }

    fn build_id_card(first17: &str) -> String {
        let weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
        let checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
        let sum: usize = first17
            .chars()
            .enumerate()
            .map(|(index, digit)| digit.to_digit(10).unwrap() as usize * weights[index])
            .sum();
        format!("{first17}{}", checks[sum % 11])
    }

    #[test]
    fn masks_valid_mainland_china_id_cards_after_strict_validation() {
        let known = "11010519491231002X";
        let lower = format!("{}x", &known[..known.len() - 1]);
        assert_eq!(
            mask(&format!("id={known} lower={lower}"), &[MaskType::IdCard]),
            "id=[IDCARD_MASKED] lower=[IDCARD_MASKED]"
        );
    }

    #[test]
    fn rejects_invalid_id_card_province_date_sequence_checksum_and_boundaries() {
        let future_year = chrono::Local::now().date_naive().year() + 1;
        let prefix = format!("110105{future_year}");
        let future = build_id_card(&format!("{}0101001", &prefix[..10]));
        let valid = build_id_card("11010520000101001");
        let flipped_last = if valid.ends_with('0') { '1' } else { '0' };
        let flipped = format!("{}{flipped_last}", &valid[..valid.len() - 1]);
        let invalid = [
            build_id_card("99010520000101001"),
            build_id_card("11010520001301001"),
            future,
            build_id_card("11010520000101000"),
            flipped,
            format!("A{valid}B"),
            "130503670401001".to_string(),
        ];
        let input = invalid.join("|");
        assert_eq!(mask(&input, &[MaskType::IdCard]), input);
    }

    #[test]
    fn masks_mainland_china_mobile_and_landline_formats() {
        let phones = [
            "13800138000",
            "+86 138 0013 8000",
            "0086-138-0013-8000",
            "010-12345678",
            "(010)12345678",
            "057112345678",
        ];
        let masked = mask(&phones.join("|"), &[MaskType::Phone]);
        assert_eq!(masked.matches("[PHONE_MASKED]").count(), phones.len());
        for phone in phones {
            assert!(!masked.contains(phone), "{phone} in {masked}");
        }
    }

    #[test]
    fn masks_adjacent_phone_candidates_separated_only_by_whitespace() {
        assert_eq!(
            mask("13800138000 13900139000", &[MaskType::Phone]),
            "[PHONE_MASKED] [PHONE_MASKED]"
        );
    }

    #[test]
    fn masks_valid_phones_in_numeric_sequences_longer_than_one_candidate_window() {
        let phones: Vec<&str> = (0..12)
            .map(|index| {
                if index % 2 == 0 {
                    "13800138000"
                } else {
                    "13900139000"
                }
            })
            .collect();
        assert_eq!(
            mask(&phones.join(" "), &[MaskType::Phone]),
            phones
                .iter()
                .map(|_| "[PHONE_MASKED]")
                .collect::<Vec<_>>()
                .join(" ")
        );
    }

    #[test]
    fn rejects_invalid_service_extension_overseas_and_embedded_phone_formats() {
        let invalid = [
            "12800138000",
            "4008001234",
            "8001234567",
            "+1-202-555-0123",
            "010-12345678-123",
            "001-12345678",
            "(001)12345678",
            "A13800138000B",
        ];
        let input = invalid.join("|");
        assert_eq!(mask(&input, &[MaskType::Phone]), input);
    }

    #[test]
    fn masks_common_ascii_emails_and_preserves_trailing_punctuation() {
        let input = "primary=user.name+tag@example-domain.com, backup=a_b@example.co.";
        assert_eq!(
            mask(input, &[MaskType::Email]),
            "primary=[EMAIL_MASKED], backup=[EMAIL_MASKED]."
        );
    }

    #[test]
    fn rejects_malformed_and_out_of_scope_emails() {
        let invalid = [
            ".user@example.com",
            "user..name@example.com",
            "user@example-.com",
            "user@localhost",
            "user@example.c",
            "user@example.com_",
            "中文@example.com",
            "a@b@c.com",
        ];
        let input = invalid.join("|");
        assert_eq!(mask(&input, &[MaskType::Email]), input);
    }

    #[test]
    fn masks_public_private_loopback_and_link_local_ipv4_addresses() {
        let input = "8.8.8.8|192.168.1.10|127.0.0.1|169.254.10.20.";
        assert_eq!(
            mask(input, &[MaskType::IpAddress]),
            "[IP_ADDRESS_MASKED]|[IP_ADDRESS_MASKED]|[IP_ADDRESS_MASKED]|[IP_ADDRESS_MASKED]."
        );
    }

    #[test]
    fn rejects_malformed_ipv4_addresses_but_accepts_a_version_shaped_address() {
        let invalid = "256.1.1.1|192.168.01.1|1.2.3|1.2.3.4.5";
        assert_eq!(mask(invalid, &[MaskType::IpAddress]), invalid);
        assert_eq!(
            mask("version=1.2.3.4", &[MaskType::IpAddress]),
            "version=[IP_ADDRESS_MASKED]"
        );
    }

    #[test]
    fn masks_supported_card_issuers_after_luhn_validation() {
        let cards = [
            "6221 2600 0000 0000",
            "4111111111111111",
            "5555-5555-5555-4444",
            "378282246310005",
            "6011111111111117",
        ];
        let masked = mask(&cards.join("|"), &[MaskType::BankCard]);
        assert_eq!(masked.matches("[CREDIT_CARD_MASKED]").count(), cards.len());
        for card in cards {
            assert!(!masked.contains(card), "{card}");
        }
    }

    #[test]
    fn rejects_bank_card_candidates_with_invalid_prefix_luhn_length_or_boundaries() {
        let invalid = [
            "4111111111111112",
            "9111111111111111",
            "41111111111111",
            "A4111111111111111B",
        ];
        let input = invalid.join("|");
        assert_eq!(mask(&input, &[MaskType::BankCard]), input);
    }

    #[test]
    fn only_runs_pii_detectors_selected_by_custom_mode() {
        assert_eq!(
            mask(
                "email=user@example.com phone=13800138000",
                &[MaskType::Email]
            ),
            "email=[EMAIL_MASKED] phone=13800138000"
        );
    }

    #[test]
    fn uses_deterministic_overlap_priority_for_numeric_pii_ranges() {
        let value = "123456789012345678";
        let masked = apply_mask_ranges(
            value,
            &[
                MaskRange {
                    start: 0,
                    end: value.len(),
                    replacement: "[PHONE_MASKED]".into(),
                    rule_id: "pii.phone".into(),
                    mask_type: MaskType::Phone,
                },
                MaskRange {
                    start: 0,
                    end: value.len(),
                    replacement: "[CREDIT_CARD_MASKED]".into(),
                    rule_id: "pii.bankCard".into(),
                    mask_type: MaskType::BankCard,
                },
                MaskRange {
                    start: 0,
                    end: value.len(),
                    replacement: "[IDCARD_MASKED]".into(),
                    rule_id: "pii.idCard".into(),
                    mask_type: MaskType::IdCard,
                },
            ],
        );
        assert_eq!(masked, "[IDCARD_MASKED]");
    }

    #[test]
    fn fully_masks_emails_that_contain_higher_priority_numeric_pii() {
        assert_eq!(
            mask(
                "user.13800138000@example.com|11010519491231002X@example.com",
                &[MaskType::Phone, MaskType::IdCard, MaskType::Email]
            ),
            "[PHONE_MASKED]|[IDCARD_MASKED]"
        );
    }

    #[test]
    fn keeps_existing_broad_secret_rules_ahead_of_nested_pii_matches() {
        let value = "mysql://agent:secret@example.com:3306/db";
        let plan = load_mask_plan(&MaskConfig {
            mode: MaskMode::All,
            types: Vec::new(),
            replacement_mode: None,
        });
        assert_eq!(
            mask_string(
                value,
                PlanOrRules::Plan(&plan),
                &StringMaskOptions::default()
            )
            .as_ref(),
            "[DATABASEURL_MASKED]"
        );
    }

    #[test]
    fn preserves_existing_markers_and_rejects_overlong_numeric_candidates() {
        let overlong = "4".repeat(1_000);
        let input = format!("[PHONE_MASKED]|{overlong}");
        assert_eq!(mask(&input, &all_pii()), input);
    }

    #[test]
    fn masks_valid_candidates_at_string_boundaries_and_beside_unicode_text() {
        assert_eq!(
            mask(
                "13800138000中文user@example.com",
                &[MaskType::Phone, MaskType::Email]
            ),
            "[PHONE_MASKED]中文[EMAIL_MASKED]"
        );
    }

    #[test]
    fn masks_pii_in_large_text_using_the_same_bounded_detector_path() {
        let phone = "13800138000";
        let input = format!(
            "{} {phone} {}",
            "x".repeat(80 * 1024),
            "y".repeat(80 * 1024)
        );
        let plan = load_mask_plan(&MaskConfig {
            mode: MaskMode::Custom,
            types: vec![MaskType::Phone],
            replacement_mode: None,
        });
        let masked = mask_string(
            &input,
            PlanOrRules::Plan(&plan),
            &StringMaskOptions {
                large_string_threshold_bytes: Some(64 * 1024),
                ..StringMaskOptions::default()
            },
        );
        assert!(masked.contains("[PHONE_MASKED]"));
        assert!(!masked.contains(phone));
    }
}
