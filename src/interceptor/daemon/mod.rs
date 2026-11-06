//! Standalone interceptor daemon entry.

mod lifecycle;
mod runtime;
mod server;

use crate::interceptor::paths::{
    default_pilot_data_dir, interceptor_data_dir, interceptor_lock_path, interceptor_log_path,
};
use crate::utils::{
    acquire_single_instance_lock, create_logger, flush_logs_sync, init_file_logging,
    read_installed_version, INTERCEPTOR_PROCESS_PATTERNS,
};
use runtime::read_installed_git_commit;
use serde_json::{Map, Value};
use std::io::Write;

#[cfg(test)]
pub(crate) use lifecycle::start_interceptor_service_at_port;

pub use lifecycle::{
    start_interceptor_service, InterceptorService, StartInterceptorServiceOptions,
};
pub use runtime::{build_runtime, remove_own_pid, write_pid, write_runtime, RuntimeWriteOptions};
pub use server::{create_interceptor_server, InterceptorServer, InterceptorServerOptions};

pub async fn run_daemon() -> i32 {
    let logger = create_logger("InterceptorDaemon");
    let data_dir = default_pilot_data_dir();
    let interceptor_dir = interceptor_data_dir(Some(&data_dir));
    if let Err(err) = std::fs::create_dir_all(interceptor_dir.join("logs")) {
        let mut meta = Map::new();
        meta.insert("error".to_string(), Value::String(err.to_string()));
        logger.error("interceptor daemon failed to start", Some(&meta));
        flush_logs_sync();
        return 1;
    }
    if let Err(err) =
        init_file_logging(&interceptor_log_path(Some(&data_dir)).to_string_lossy()).await
    {
        let mut meta = Map::new();
        meta.insert("error".to_string(), Value::String(err.to_string()));
        logger.error("interceptor daemon failed to start", Some(&meta));
        flush_logs_sync();
        return 1;
    }
    let acquired = acquire_single_instance_lock(
        &interceptor_lock_path(Some(&data_dir)).to_string_lossy(),
        Some(INTERCEPTOR_PROCESS_PATTERNS),
    );
    let Some(lock) = acquired.lock else {
        let mut meta = Map::new();
        if let Some(pid) = acquired.holder_pid {
            meta.insert("holderPid".to_string(), Value::from(pid));
        }
        logger.warn(
            "another interceptor instance already holds the lock; exiting",
            Some(&meta),
        );
        flush_logs_sync();
        return 0;
    };
    let version = read_installed_version(&data_dir);
    let git_commit = read_installed_git_commit(&data_dir);
    let service = match start_interceptor_service(StartInterceptorServiceOptions {
        data_dir: data_dir.clone(),
        version,
        git_commit,
        verdict_store: None,
        emit_blocked_prompt: None,
    })
    .await
    {
        Ok(service) => service,
        Err(err) => {
            let mut meta = Map::new();
            meta.insert("error".to_string(), Value::String(err.to_string()));
            logger.error("interceptor daemon failed to start", Some(&meta));
            flush_logs_sync();
            lock.release();
            return 1;
        }
    };
    wait_for_shutdown().await;
    service.stop().await;
    lock.release();
    flush_logs_sync();
    let _ = std::io::stdout().flush();
    0
}

async fn wait_for_shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = match signal(SignalKind::terminate()) {
            Ok(signal) => signal,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
