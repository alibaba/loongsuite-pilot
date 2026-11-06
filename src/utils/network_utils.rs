//! Port of `src/utils/network-utils.ts`.

use super::fs_utils::read_installed_version;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::OnceLock;

/// First non-internal IPv4 address, or `127.0.0.1`.
///
/// Interface order follows `/proc/net/dev` on Linux, which is close to
/// `os.networkInterfaces()` but not identical when several external IPv4s exist.
pub fn resolve_local_ip() -> String {
    let networks = sysinfo::Networks::new_with_refreshed_list();
    let mut by_name: HashMap<String, Vec<Ipv4Addr>> = HashMap::new();
    let mut names = Vec::new();
    for (name, data) in networks.iter() {
        names.push(name.clone());
        let ips = data
            .ip_networks()
            .iter()
            .filter_map(|network| match network.addr {
                IpAddr::V4(addr) if !addr.is_loopback() && !addr.is_unspecified() => Some(addr),
                _ => None,
            })
            .collect();
        by_name.insert(name.clone(), ips);
    }
    for name in interface_order(&names) {
        if let Some(addr) = by_name.get(&name).and_then(|ips| ips.first()) {
            return addr.to_string();
        }
    }
    "127.0.0.1".to_string()
}

fn interface_order(known: &[String]) -> Vec<String> {
    let mut ordered = Vec::new();
    if let Ok(text) = std::fs::read_to_string("/proc/net/dev") {
        for line in text.lines().skip(2) {
            if let Some((name, _)) = line.split_once(':') {
                let name = name.trim();
                if !name.is_empty() {
                    ordered.push(name.to_string());
                }
            }
        }
    }
    let mut rest: Vec<String> = known
        .iter()
        .filter(|name| !ordered.iter().any(|seen| seen == *name))
        .cloned()
        .collect();
    rest.sort();
    ordered.extend(rest);
    ordered
}

pub fn local_ip() -> &'static str {
    static IP: OnceLock<String> = OnceLock::new();
    IP.get_or_init(resolve_local_ip).as_str()
}

pub fn build_user_agent(data_dir: &str) -> String {
    let version = read_installed_version(data_dir);
    let release = sysinfo::System::kernel_version().unwrap_or_default();
    format!(
        "loongsuite-pilot/{version} ({}; {release}; {}) ip/{}",
        node_os_type(),
        node_arch(),
        local_ip()
    )
}

fn node_os_type() -> &'static str {
    match std::env::consts::OS {
        "linux" => "Linux",
        "macos" => "Darwin",
        "windows" => "Windows_NT",
        "freebsd" => "FreeBSD",
        "openbsd" => "OpenBSD",
        "netbsd" => "NetBSD",
        "android" => "Android",
        other => other,
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "arm" => "arm",
        "powerpc64" => "ppc64",
        "powerpc" => "ppc",
        "s390x" => "s390x",
        "riscv64" => "riscv64",
        "loongarch64" => "loong64",
        "mips" => "mips",
        "mipsel" => "mipsel",
        "mips64" => "mips64",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::{build_user_agent, node_arch, node_os_type, resolve_local_ip};

    #[test]
    fn local_ip_is_loopback_or_dotted_quad() {
        let ip = resolve_local_ip();
        assert!(ip.split('.').count() == 4, "{ip}");
        assert_ne!(ip, "0.0.0.0");
    }

    #[test]
    fn user_agent_uses_node_os_names() {
        let agent = build_user_agent("/no/such/data-dir");
        assert!(agent.starts_with("loongsuite-pilot/"));
        assert!(agent.contains(&format!("({}", node_os_type())));
        assert!(agent.contains(&format!("; {})", node_arch())));
        assert!(agent.contains("ip/"));
        if cfg!(target_arch = "x86_64") {
            assert_eq!(node_arch(), "x64");
        }
        if cfg!(target_os = "linux") {
            assert_eq!(node_os_type(), "Linux");
        }
    }
}
