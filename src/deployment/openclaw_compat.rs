//! OpenClaw version gate shared with `assets/plugins/openclaw/compatibility.mjs`.

pub const MIN_OPENCLAW_VERSION: &str = "2026.3.8";

pub fn at_least(value: &str, floor: &str) -> bool {
    let Some(caps) =
        regex::Regex::new(r"^v?(\d{4})\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")
            .ok()
            .and_then(|pattern| pattern.captures(value.trim()))
    else {
        return false;
    };
    let core = [1, 2, 3].map(|index| {
        caps.get(index)
            .and_then(|item| item.as_str().parse::<u64>().ok())
            .unwrap_or(0)
    });
    let target: Vec<u64> = floor
        .split('.')
        .filter_map(|part| part.parse().ok())
        .collect();
    if target.len() < 3 {
        return false;
    }
    for index in 0..3 {
        if core[index] != target[index] {
            return core[index] > target[index];
        }
    }
    match caps.get(4) {
        None => true,
        Some(suffix) => regex::Regex::new(r"^\d+(?:\.\d+)*$")
            .unwrap()
            .is_match(suffix.as_str()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenClawCapabilities {
    pub version: String,
    pub adapter: String,
    pub conversation_access: bool,
}

pub fn open_claw_capabilities(version: &str) -> Option<OpenClawCapabilities> {
    if !at_least(version, MIN_OPENCLAW_VERSION) {
        return None;
    }
    // The minimum-version comparison admits newer-core prereleases. Each
    // feature gate still compares its own stable boundary, so e.g. a 5.12
    // preview keeps the legacy adapter while retaining 4.24 conversation access.
    Some(OpenClawCapabilities {
        version: version.trim().to_string(),
        adapter: if at_least(version, "2026.5.12") {
            "modern"
        } else {
            "legacy"
        }
        .into(),
        conversation_access: at_least(version, "2026.4.24"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gates_versions_and_adapter() {
        assert!(open_claw_capabilities("2026.3.7").is_none());
        let legacy = open_claw_capabilities("2026.3.8").unwrap();
        assert_eq!(legacy.adapter, "legacy");
        assert!(!legacy.conversation_access);
        let mid = open_claw_capabilities("2026.4.24").unwrap();
        assert!(mid.conversation_access);
        assert_eq!(mid.adapter, "legacy");
        let modern = open_claw_capabilities("v2026.5.12-1").unwrap();
        assert_eq!(modern.adapter, "modern");
        let preview = open_claw_capabilities("2026.5.12-beta").unwrap();
        assert_eq!(preview.adapter, "legacy");
        assert!(preview.conversation_access);
    }
}
