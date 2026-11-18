use crate::types::AgentActivityEntry;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct HermesOwner {
    pid: i32,
    start_ticks: String,
    namespace: String,
    boot_id: String,
    pub(super) source: String,
}

pub(crate) fn valid_source(source: &str) -> bool {
    let mut parts = source.split('-');
    let digits = |value: &str, max| {
        !value.is_empty() && value.len() <= max && value.bytes().all(|b| b.is_ascii_digit())
    };
    matches!((parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(pid), Some(stamp), Some(nonce), None)
            if digits(pid, 10) && digits(stamp, 24) && nonce.len() == 8
                && nonce.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
}

impl HermesOwner {
    pub(super) fn from_entry(entry: &AgentActivityEntry) -> Option<Self> {
        let owner = entry.get("agent.hermes.process")?.as_object()?;
        let pid = i32::try_from(owner.get("pid")?.as_i64()?)
            .ok()
            .filter(|pid| *pid > 0)?;
        let start_ticks = owner.get("start_ticks")?.as_str()?;
        let namespace = owner.get("pid_namespace")?.as_str()?;
        let boot_id = owner.get("boot_id")?.as_str()?;
        let source = owner.get("source_token")?.as_str()?;
        if start_ticks.is_empty()
            || start_ticks.len() > 30
            || !start_ticks.bytes().all(|b| b.is_ascii_digit())
            || !valid_namespace(namespace)
            || !valid_boot(boot_id)
            || !valid_source(source)
            || !source.starts_with(&format!("{pid}-"))
        {
            return None;
        }
        Some(Self {
            pid,
            start_ticks: start_ticks.into(),
            namespace: namespace.into(),
            boot_id: boot_id.into(),
            source: source.into(),
        })
    }

    pub(super) fn proven_dead(&self, current: &ProcessNamespace) -> bool {
        #[cfg(target_os = "linux")]
        {
            if self.namespace != current.namespace || self.boot_id != current.boot_id {
                return false;
            }
            match std::fs::read_to_string(format!("/proc/{}/stat", self.pid)) {
                Ok(stat) => {
                    let Some((state, ticks)) = stat_identity(&stat) else {
                        return false;
                    };
                    ticks != self.start_ticks || matches!(state, "Z" | "X")
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // SAFETY: pid is positive and signal zero only probes existence.
                    (unsafe { libc::kill(self.pid, 0) == -1 })
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                }
                Err(_) => false,
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = current;
            false
        }
    }
}

pub(super) struct ProcessNamespace {
    #[cfg(target_os = "linux")]
    namespace: String,
    #[cfg(target_os = "linux")]
    boot_id: String,
}

impl ProcessNamespace {
    pub(super) fn current() -> Option<Self> {
        #[cfg(target_os = "linux")]
        {
            let current = std::process::id().to_string();
            if std::fs::read_link("/proc/self").ok()?.as_os_str() != current.as_str() {
                return None;
            }
            let status = std::fs::read_to_string("/proc/self/status").ok()?;
            let pids = status
                .lines()
                .find_map(|line| line.strip_prefix("NSpid:"))?;
            if pids.trim() != current {
                return None;
            }
            let namespace = std::fs::read_link("/proc/self/ns/pid")
                .ok()?
                .into_os_string()
                .into_string()
                .ok()?;
            let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
            let boot_id = boot_id.trim();
            if !valid_namespace(&namespace) || !valid_boot(boot_id) {
                return None;
            }
            Some(Self {
                namespace,
                boot_id: boot_id.into(),
            })
        }
        #[cfg(not(target_os = "linux"))]
        None
    }
}

#[cfg(target_os = "linux")]
fn stat_identity(stat: &str) -> Option<(&str, &str)> {
    let mut fields = stat.rsplit_once(')')?.1.split_ascii_whitespace();
    let state = fields.next()?;
    let ticks = fields.nth(18)?;
    ticks
        .bytes()
        .all(|b| b.is_ascii_digit())
        .then_some((state, ticks))
}

fn valid_namespace(namespace: &str) -> bool {
    namespace.len() <= 48
        && namespace
            .strip_prefix("pid:[")
            .and_then(|rest| rest.strip_suffix(']'))
            .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
}

fn valid_boot(boot_id: &str) -> bool {
    boot_id.len() == 36
        && boot_id
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}
