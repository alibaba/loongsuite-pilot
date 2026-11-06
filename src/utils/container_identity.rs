//! Port of `src/utils/container-identity.ts`.

use std::io;

const CGROUP_CONTAINER_ID_LEN: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerIdentitySource {
    Cgroup,
    BootId,
    Unknown,
}

impl ContainerIdentitySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cgroup => "cgroup",
            Self::BootId => "boot_id",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerIdentity {
    /// cgroup container id, host boot_id, or `unknown`.
    pub identity: String,
    pub source: ContainerIdentitySource,
}

/// Same identity k8s-preload and native-deps-guard compare against.
///
/// A 64-hex id from this process's cgroup means the process is inside a
/// container. Outside one, the host boot_id is used. Host boot_id must never
/// be treated as a container scope.
pub fn identity_from_parts(
    cgroup_text: Option<&str>,
    boot_id_text: Option<&str>,
) -> ContainerIdentity {
    if let Some(identity) = cgroup_text.and_then(first_container_id) {
        return ContainerIdentity {
            identity,
            source: ContainerIdentitySource::Cgroup,
        };
    }
    if let Some(boot_id) = boot_id_text.map(str::trim).filter(|text| !text.is_empty()) {
        return ContainerIdentity {
            identity: boot_id.to_string(),
            source: ContainerIdentitySource::BootId,
        };
    }
    ContainerIdentity {
        identity: "unknown".to_string(),
        source: ContainerIdentitySource::Unknown,
    }
}

pub fn read_container_identity() -> ContainerIdentity {
    read_container_identity_with(|path| std::fs::read_to_string(path))
}

pub fn read_container_identity_with<F>(mut read: F) -> ContainerIdentity
where
    F: FnMut(&str) -> io::Result<String>,
{
    let cgroup_text = read("/proc/self/cgroup").ok();
    if cgroup_text
        .as_deref()
        .and_then(first_container_id)
        .is_some()
    {
        return identity_from_parts(cgroup_text.as_deref(), None);
    }
    let boot_id_text = read("/proc/sys/kernel/random/boot_id").ok();
    identity_from_parts(None, boot_id_text.as_deref())
}

fn first_container_id(text: &str) -> Option<String> {
    // JavaScript `/[0-9a-f]{64}/` matches the first 64 lowercase hex chars even
    // when a longer hex run follows. It does not require a boundary.
    let bytes = text.as_bytes();
    if bytes.len() < CGROUP_CONTAINER_ID_LEN {
        return None;
    }
    let last = bytes.len() - CGROUP_CONTAINER_ID_LEN;
    for start in 0..=last {
        if bytes[start..start + CGROUP_CONTAINER_ID_LEN]
            .iter()
            .copied()
            .all(is_lower_hex)
        {
            return Some(text[start..start + CGROUP_CONTAINER_ID_LEN].to_string());
        }
    }
    None
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

#[cfg(test)]
mod tests {
    use super::{identity_from_parts, read_container_identity_with, ContainerIdentitySource};

    #[test]
    fn prefers_64_hex_cgroup_id_over_boot_id() {
        let id = "a".repeat(64);
        let text = format!("0::/kubepods/{id}/payload");
        let found = identity_from_parts(Some(&text), Some("boot\n"));
        assert_eq!(found.identity, id);
        assert_eq!(found.source, ContainerIdentitySource::Cgroup);
    }

    #[test]
    fn falls_back_to_trimmed_boot_id() {
        let found = identity_from_parts(Some("no container here"), Some("  boot-1 \n"));
        assert_eq!(found.identity, "boot-1");
        assert_eq!(found.source, ContainerIdentitySource::BootId);
        let unknown = identity_from_parts(None, Some("   "));
        assert_eq!(unknown.identity, "unknown");
        assert_eq!(unknown.source, ContainerIdentitySource::Unknown);
    }

    #[test]
    fn reader_skips_boot_id_when_cgroup_matches() {
        let id = "b".repeat(64);
        let mut reads = Vec::new();
        let found = read_container_identity_with(|path| {
            reads.push(path.to_string());
            if path.ends_with("cgroup") {
                Ok(format!("0::/{id}"))
            } else {
                Ok("should-not-read".into())
            }
        });
        assert_eq!(found.identity, id);
        assert_eq!(reads, vec!["/proc/self/cgroup".to_string()]);
    }

    #[test]
    fn reader_uses_boot_id_when_cgroup_has_no_container() {
        let found = read_container_identity_with(|path| {
            if path.ends_with("cgroup") {
                Err(std::io::Error::from(std::io::ErrorKind::NotFound))
            } else {
                Ok("boot-id\n".into())
            }
        });
        assert_eq!(found.source, ContainerIdentitySource::BootId);
        assert_eq!(found.identity, "boot-id");
    }

    #[test]
    fn uppercase_hex_is_not_a_container_id() {
        let id = "A".repeat(64);
        let found = identity_from_parts(Some(&id), None);
        assert_eq!(found.source, ContainerIdentitySource::Unknown);
    }
}
