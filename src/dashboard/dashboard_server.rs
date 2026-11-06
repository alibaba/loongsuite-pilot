//! Port of `src/dashboard/dashboard-server.ts`.

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

pub const DEFAULT_DASHBOARD_HOST: &str = "127.0.0.1";
pub const DEFAULT_DASHBOARD_PORT: u16 = 8765;
pub const DASHBOARD_ID_HEADER: &str = "x-loongsuite-pilot-dashboard";
pub const DASHBOARD_ID_VALUE: &str = "metrics-summary-v1";
pub const DASHBOARD_INSTANCE_HEADER: &str = "x-loongsuite-pilot-instance";

pub struct DashboardServerOptions {
    pub data_dir: String,
    pub asset_path: String,
    pub host: Option<String>,
    pub port: Option<u16>,
}

pub struct DashboardServer {
    host: String,
    port: u16,
    asset_path: String,
    summary_path: String,
    instance_id: String,
    running: AtomicBool,
    bound_port: Mutex<Option<u16>>,
    last_start_error: Mutex<Option<String>>,
    stop: Mutex<Option<Arc<AtomicBool>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl DashboardServer {
    pub fn new(options: DashboardServerOptions) -> Self {
        let host = options
            .host
            .unwrap_or_else(|| DEFAULT_DASHBOARD_HOST.to_string());
        let port = options.port.unwrap_or(DEFAULT_DASHBOARD_PORT);
        Self {
            host,
            port,
            asset_path: options.asset_path,
            summary_path: Path::new(&options.data_dir)
                .join("logs")
                .join("metrics-summary.json")
                .to_string_lossy()
                .into_owned(),
            instance_id: dashboard_instance_id(&options.data_dir),
            running: AtomicBool::new(false),
            bound_port: Mutex::new(None),
            last_start_error: Mutex::new(None),
            stop: Mutex::new(None),
            thread: Mutex::new(None),
        }
    }

    pub fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn address(&self) -> Option<String> {
        self.bound_port
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .map(|port| format!("http://{}:{port}/", self.host))
    }

    /// Last startup refusal, including a non-fatal occupied listening port.
    pub fn last_start_error(&self) -> Option<String> {
        self.last_start_error
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    pub fn start(&self) -> Result<(), String> {
        if self.running() {
            return Ok(());
        }
        *self
            .last_start_error
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = None;
        let listener = match TcpListener::bind((self.host.as_str(), self.port)) {
            Ok(listener) => listener,
            Err(error) => {
                let detail = format!(
                    "dashboard bind failed at {}:{} ({:?}): {}",
                    self.host,
                    self.port,
                    error.kind(),
                    error
                );
                crate::utils::create_logger("DashboardServer").warn(&detail, None);
                *self
                    .last_start_error
                    .lock()
                    .unwrap_or_else(|err| err.into_inner()) = Some(detail);
                return Ok(());
            }
        };
        let bound = listener
            .local_addr()
            .map(|addr| addr.port())
            .unwrap_or(self.port);
        *self
            .bound_port
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(bound);
        let stop = Arc::new(AtomicBool::new(false));
        *self.stop.lock().unwrap_or_else(|err| err.into_inner()) = Some(stop.clone());
        listener
            .set_nonblocking(true)
            .map_err(|err| err.to_string())?;
        let asset = self.asset_path.clone();
        let summary = self.summary_path.clone();
        let instance = self.instance_id.clone();
        let host = self.host.clone();
        let running = Arc::new(AtomicBool::new(true));
        self.running.store(true, Ordering::SeqCst);
        let running_flag = running;
        let thread = std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ =
                            handle_connection(stream, &asset, &summary, &instance, &host, bound);
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                    Err(_) => break,
                }
            }
            running_flag.store(false, Ordering::SeqCst);
        });
        *self.thread.lock().unwrap_or_else(|err| err.into_inner()) = Some(thread);
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(stop) = self
            .stop
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take()
        {
            stop.store(true, Ordering::SeqCst);
        }
        if let Some(thread) = self
            .thread
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take()
        {
            let _ = thread.join();
        }
        self.running.store(false, Ordering::SeqCst);
        *self
            .bound_port
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = None;
    }
}

impl Drop for DashboardServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn read_request_head(
    mut read: impl FnMut(&mut [u8]) -> std::io::Result<usize>,
) -> std::io::Result<String> {
    let mut buf = [0_u8; 8192];
    let mut used = 0;
    loop {
        if used == buf.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "dashboard request headers exceed limit",
            ));
        }
        let count = match read(&mut buf[used..]) {
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "incomplete dashboard request headers",
            ));
        }
        used += count;
        if let Some(end) = buf[..used].windows(4).position(|part| part == b"\r\n\r\n") {
            return Ok(String::from_utf8_lossy(&buf[..end + 4]).into_owned());
        }
    }
}

fn handle_connection(
    mut stream: TcpStream,
    asset_path: &str,
    summary_path: &str,
    instance_id: &str,
    host: &str,
    port: u16,
) -> std::io::Result<()> {
    // TCP 读取不等于完整 HTTP 请求；累计到请求头结束，且共享两秒总预算。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let request = read_request_head(|buf| {
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::TimedOut))?;
        stream.set_read_timeout(Some(remaining))?;
        stream.read(buf)
    })?;
    let mut lines = request.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let target = parts.next().unwrap_or("/");
    let mut host_header = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("host") {
                host_header = Some(value.trim().to_string());
            }
        }
    }
    let head_only = method.eq_ignore_ascii_case("HEAD");
    if !is_allowed_dashboard_host(host_header.as_deref().unwrap_or(""), host, port) {
        return send(
            &mut stream,
            421,
            "application/json; charset=utf-8",
            br#"{"error":"invalid dashboard host"}"#,
            head_only,
            instance_id,
        );
    }
    if !method.eq_ignore_ascii_case("GET") && !head_only {
        return send(
            &mut stream,
            405,
            "application/json; charset=utf-8",
            br#"{"error":"method not allowed"}"#,
            head_only,
            instance_id,
        );
    }
    let path = target.split('?').next().unwrap_or("/");
    if path == "/" || path == "/index.html" {
        let html = std::fs::read(asset_path).unwrap_or_default();
        return send(
            &mut stream,
            200,
            "text/html; charset=utf-8",
            &html,
            head_only,
            instance_id,
        );
    }
    if path == "/metrics-summary.json" {
        return match std::fs::read(summary_path) {
            Ok(body) => send(
                &mut stream,
                200,
                "application/json; charset=utf-8",
                &body,
                head_only,
                instance_id,
            ),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => send(
                &mut stream,
                503,
                "application/json; charset=utf-8",
                br#"{"error":"metrics summary is not ready"}"#,
                head_only,
                instance_id,
            ),
            Err(_) => send(
                &mut stream,
                500,
                "application/json; charset=utf-8",
                br#"{"error":"dashboard request failed"}"#,
                head_only,
                instance_id,
            ),
        };
    }
    send(
        &mut stream,
        404,
        "application/json; charset=utf-8",
        br#"{"error":"not found"}"#,
        head_only,
        instance_id,
    )
}

fn send(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    head_only: bool,
    instance_id: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        421 => "Misdirected Request",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\ncache-control: no-store\r\nx-content-type-options: nosniff\r\ncross-origin-resource-policy: same-origin\r\n{DASHBOARD_ID_HEADER}: {DASHBOARD_ID_VALUE}\r\n{DASHBOARD_INSTANCE_HEADER}: {instance_id}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    if !head_only {
        stream.write_all(body)?;
    }
    Ok(())
}

pub fn is_allowed_dashboard_host(host_header: &str, host: &str, port: u16) -> bool {
    let mut allowed = vec![
        format!("{host}:{port}").to_lowercase(),
        format!("{DEFAULT_DASHBOARD_HOST}:{port}"),
        format!("localhost:{port}"),
    ];
    if port == 80 {
        allowed.push(host.to_lowercase());
        allowed.push(DEFAULT_DASHBOARD_HOST.to_string());
        allowed.push("localhost".into());
    }
    allowed
        .iter()
        .any(|item| item == &host_header.to_lowercase())
}

/// 与原有 path.resolve 合同一致：按词法折叠路径，不要求目录存在或解析链接。
pub fn dashboard_instance_id(path: &str) -> String {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| Path::new(path).to_path_buf());
    let mut normalized = std::path::PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    hex::encode(Sha256::digest(normalized.to_string_lossy().as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    fn request(address: &str, path: &str, host: Option<&str>) -> (u16, String, String) {
        let url = address.trim_end_matches('/');
        let without = url.trim_start_matches("http://");
        let (host_name, port) = without.split_once(':').unwrap();
        let mut stream = TcpStream::connect((host_name, port.parse::<u16>().unwrap())).unwrap();
        let host_header = host.unwrap_or(without);
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut buf = String::new();
        stream.read_to_string(&mut buf).unwrap();
        let (head, body) = buf.split_once("\r\n\r\n").unwrap_or((&buf, ""));
        let status = head
            .lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .nth(1)
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);
        (status, head.to_string(), body.to_string())
    }

    #[test]
    fn request_headers_wait_for_terminator_and_enforce_bounds() {
        let request = "GET /metrics-summary.json HTTP/1.1\r\nHost: localhost:8765\r\n\r\n";
        for fragment_size in [1, 2, 17, 8192] {
            let mut source = std::io::Cursor::new(request.as_bytes());
            let mut interrupted = false;
            let head = read_request_head(|buf| {
                if !interrupted {
                    interrupted = true;
                    return Err(std::io::ErrorKind::Interrupted.into());
                }
                let limit = buf.len().min(fragment_size);
                source.read(&mut buf[..limit])
            })
            .unwrap();
            assert_eq!(head, request);
        }
        for incomplete in ["", "GET / HTTP/1.1\r\nHost: localhost:8765\r\n"] {
            let mut source = std::io::Cursor::new(incomplete.as_bytes());
            assert_eq!(
                read_request_head(|buf| source.read(buf))
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::UnexpectedEof
            );
        }
        let boundary = format!("{}\r\n\r\n", "x".repeat(8192 - 4));
        let mut source = std::io::Cursor::new(boundary.as_bytes());
        assert_eq!(read_request_head(|buf| source.read(buf)).unwrap(), boundary);
        let mut source = std::io::Cursor::new(format!("x{boundary}").into_bytes());
        assert_eq!(
            read_request_head(|buf| source.read(buf))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
        assert_eq!(
            read_request_head(|_| Err(std::io::ErrorKind::TimedOut.into()))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
    }

    #[test]
    fn defaults_and_loopback_host_rules() {
        assert_eq!(DEFAULT_DASHBOARD_PORT, 8765);
        assert!(is_allowed_dashboard_host("127.0.0.1", "127.0.0.1", 80));
        assert!(is_allowed_dashboard_host("localhost", "127.0.0.1", 80));
        assert!(!is_allowed_dashboard_host("127.0.0.1", "127.0.0.1", 8765));
        assert!(!is_allowed_dashboard_host(
            "attacker.example",
            "127.0.0.1",
            80
        ));
    }

    #[test]
    fn serves_the_page_and_the_unmodified_summary() {
        let dir = tempfile::tempdir().unwrap();
        let asset = dir.path().join("index.html");
        std::fs::write(&asset, "<!doctype html><title>dashboard fixture</title>").unwrap();
        let summary_path = dir.path().join("logs").join("metrics-summary.json");
        std::fs::create_dir_all(summary_path.parent().unwrap()).unwrap();
        let summary =
            r#"{"version":1,"ranges":{"today":{"agentShares":[{"agentType":"future-agent"}]}}}"#;
        std::fs::write(&summary_path, summary).unwrap();
        let server = DashboardServer::new(DashboardServerOptions {
            data_dir: dir.path().to_string_lossy().into_owned(),
            asset_path: asset.to_string_lossy().into_owned(),
            host: None,
            port: Some(0),
        });
        server.start().unwrap();
        let address = server.address().unwrap();
        let (status, _, body) = request(&address, "/", None);
        assert_eq!(status, 200);
        assert!(body.contains("dashboard fixture"));
        let (status, head, body) = request(&address, "/metrics-summary.json", None);
        assert_eq!(status, 200);
        assert_eq!(body, summary);
        assert!(head
            .to_lowercase()
            .contains("x-loongsuite-pilot-dashboard: metrics-summary-v1"));
        assert!(head
            .to_lowercase()
            .contains("cross-origin-resource-policy: same-origin"));
        let (status, _, _) = request(&address, "/api/overview", None);
        assert_eq!(status, 404);
        let (status, _, body) =
            request(&address, "/metrics-summary.json", Some("attacker.example"));
        assert_eq!(status, 421);
        assert_eq!(body, r#"{"error":"invalid dashboard host"}"#);
        server.stop();
        assert!(!server.running());
        let _ = head;
    }

    #[test]
    fn returns_503_until_the_summary_exists_and_ignores_an_occupied_port() {
        const TEST_NAME: &str = "dashboard::dashboard_server::tests::returns_503_until_the_summary_exists_and_ignores_an_occupied_port";
        const CHILD: &str = "PILOT_ISOLATED_DASHBOARD_REBIND";
        if std::env::var(CHILD).ok().as_deref() != Some(TEST_NAME) {
            // Other parallel tests fork for privilege/process-tree contracts.
            // Their children can briefly retain our occupied socket. Exercise
            // exact release/rebind assertions in a process without those forks.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST_NAME])
                .env(CHILD, TEST_NAME)
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(output.status.success(), "{output:?}");
            assert!(stdout.contains(TEST_NAME), "{output:?}");
            assert!(
                stdout.contains("test result: ok. 1 passed; 0 failed"),
                "{output:?}"
            );
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let asset = dir.path().join("index.html");
        std::fs::write(&asset, "page").unwrap();
        let server = DashboardServer::new(DashboardServerOptions {
            data_dir: dir.path().to_string_lossy().into_owned(),
            asset_path: asset.to_string_lossy().into_owned(),
            host: None,
            port: Some(0),
        });
        server.start().unwrap();
        let (status, _, body) = request(&server.address().unwrap(), "/metrics-summary.json", None);
        assert_eq!(status, 503);
        assert_eq!(body, r#"{"error":"metrics summary is not ready"}"#);
        assert!(!body.contains(&dir.path().to_string_lossy().to_string()));
        assert!(!body.contains("\"path\""));
        let occupied = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let occupied_port = occupied.local_addr().unwrap().port();
        let blocked = DashboardServer::new(DashboardServerOptions {
            data_dir: dir.path().to_string_lossy().into_owned(),
            asset_path: asset.to_string_lossy().into_owned(),
            host: Some("127.0.0.1".into()),
            port: Some(occupied_port),
        });
        blocked.start().unwrap();
        assert!(!blocked.running());
        let refusal = blocked.last_start_error().unwrap();
        assert!(refusal.contains("AddrInUse"));
        assert!(refusal.contains(&occupied_port.to_string()));
        drop(occupied);
        blocked.start().unwrap();
        assert!(blocked.running());
        assert!(blocked.last_start_error().is_none());
        blocked.stop();
        server.stop();
    }
}
