//! Alarm and running-status delivery.
//!
//! Open-source builds keep [`send_alarm`], [`send_status`], [`send_running_status`],
//! and [`post_alarm`] as no-ops. The `proprietary` feature turns on the statistic
//! web-tracking post and the configurable internal self-monitoring transport.
//! Its private destinations are loaded from the installation data directory.

mod alarm_sender;
pub use alarm_sender::configure as configure_telemetry;
pub mod sender;
mod statistic;
mod webtracking_post;

pub use sender::{post_alarm, send_alarm, send_running_status, send_status};
pub use statistic::status_url;
pub use webtracking_post::{build_web_tracking_url, post_web_tracking};

#[cfg(test)]
pub use sender::{clear_sends, inject_send_error, injected_error, recorded_sends, RecordedSend};
