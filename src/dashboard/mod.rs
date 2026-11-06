//! Read-only local dashboard HTTP server.
//!
//! Wire with `#[path = "dashboard/mod.rs"] pub mod dashboard;`.

mod dashboard_server;

pub use dashboard_server::{
    dashboard_instance_id, is_allowed_dashboard_host, DashboardServer, DashboardServerOptions,
    DASHBOARD_ID_HEADER, DASHBOARD_ID_VALUE, DASHBOARD_INSTANCE_HEADER, DEFAULT_DASHBOARD_HOST,
    DEFAULT_DASHBOARD_PORT,
};

// Match JavaScript Number.isInteger: fractional ports must not be truncated.
pub(crate) fn configured_port(value: Option<&serde_json::Value>) -> u16 {
    value
        .and_then(serde_json::Value::as_f64)
        .filter(|port| port.is_finite() && port.fract() == 0.0 && *port >= 1.0 && *port <= 65535.0)
        .map(|port| port as u16)
        .unwrap_or(DEFAULT_DASHBOARD_PORT)
}
