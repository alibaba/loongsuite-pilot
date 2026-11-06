//! Upload retry / timeout defaults.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub const MULTIMODAL_UPLOAD_MAX_ATTEMPTS: u32 = 3;
pub const MULTIMODAL_UPLOAD_BASE_DELAY_MS: u64 = 200;
pub const MULTIMODAL_UPLOAD_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay_ms: u64,
}

pub const DEFAULT_MULTIMODAL_RETRY: RetryPolicy = RetryPolicy {
    max_attempts: MULTIMODAL_UPLOAD_MAX_ATTEMPTS,
    base_delay_ms: MULTIMODAL_UPLOAD_BASE_DELAY_MS,
};

#[derive(Clone, Debug)]
pub struct AttemptError {
    pub retryable: bool,
    pub error: Option<String>,
    pub status_code: Option<u16>,
    pub request_id: Option<String>,
}

#[derive(Clone, Debug)]
pub enum RetryOutcome<T> {
    Ok(T),
    Err {
        error: Option<String>,
        status_code: Option<u16>,
        request_id: Option<String>,
    },
}

pub async fn sleep_ms(ms: u64, signal: Option<&Arc<AtomicBool>>) {
    if ms == 0 || signal.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return;
    }
    tokio::select! {
        biased;
        _ = wait_abort(signal) => {}
        _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
    }
}

async fn wait_abort(signal: Option<&Arc<AtomicBool>>) {
    let Some(signal) = signal else {
        std::future::pending::<()>().await;
        return;
    };
    while !signal.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// Full-jitter backoff delay. `attempt` is 1-based.
pub fn retry_delay_ms(policy: RetryPolicy, attempt: u32) -> u64 {
    let shift = attempt.saturating_sub(1).min(16);
    let exp = (policy.base_delay_ms.saturating_mul(1u64 << shift)).min(10_000);
    let bound = exp.max(1);
    rand_below(bound)
}

fn rand_below(bound: u64) -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos() as u64)
        .unwrap_or(0);
    let mixed = nanos
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(bound);
    mixed % bound
}

pub async fn with_retries<T, F, Fut>(
    policy: RetryPolicy,
    mut run: F,
    signal: Option<Arc<AtomicBool>>,
) -> RetryOutcome<T>
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = Result<T, AttemptError>>,
{
    let mut last_error = None;
    let mut last_status = None;
    let mut last_request_id = None;
    let attempts = policy.max_attempts.max(1);
    for attempt in 1..=attempts {
        if signal
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
        {
            return RetryOutcome::Err {
                error: Some("aborted".to_string()),
                status_code: None,
                request_id: None,
            };
        }
        match run(attempt).await {
            Ok(value) => return RetryOutcome::Ok(value),
            Err(err) => {
                last_error = err.error;
                last_status = err.status_code;
                last_request_id = err.request_id.clone();
                if !err.retryable || attempt >= attempts {
                    return RetryOutcome::Err {
                        error: last_error,
                        status_code: last_status,
                        request_id: last_request_id,
                    };
                }
                sleep_ms(retry_delay_ms(policy, attempt), signal.as_ref()).await;
            }
        }
    }
    RetryOutcome::Err {
        error: last_error,
        status_code: last_status,
        request_id: last_request_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_stays_within_jitter_bounds() {
        let policy = RetryPolicy {
            max_attempts: 3,
            base_delay_ms: 100,
        };
        for _ in 0..20 {
            let delay = retry_delay_ms(policy, 1);
            assert!(delay < 100, "{delay}");
        }
    }

    #[tokio::test]
    async fn returns_success_on_first_ok_attempt() {
        let mut calls = 0u32;
        let result = with_retries(
            RetryPolicy {
                max_attempts: 3,
                base_delay_ms: 0,
            },
            |_| {
                calls += 1;
                async { Ok::<_, AttemptError>(42) }
            },
            None,
        )
        .await;
        assert!(matches!(result, RetryOutcome::Ok(42)));
        assert_eq!(calls, 1);
    }

    #[tokio::test]
    async fn stops_immediately_on_non_retryable_failure() {
        let mut calls = 0u32;
        let result = with_retries(
            RetryPolicy {
                max_attempts: 3,
                base_delay_ms: 0,
            },
            |_| {
                calls += 1;
                async {
                    Err::<i32, _>(AttemptError {
                        retryable: false,
                        error: Some("forbidden".into()),
                        status_code: Some(403),
                        request_id: None,
                    })
                }
            },
            None,
        )
        .await;
        match result {
            RetryOutcome::Err {
                error,
                status_code,
                request_id,
            } => {
                assert_eq!(error.as_deref(), Some("forbidden"));
                assert_eq!(status_code, Some(403));
                assert!(request_id.is_none());
            }
            RetryOutcome::Ok(_) => panic!("expected error"),
        }
        assert_eq!(calls, 1);
    }

    #[tokio::test]
    async fn retries_until_max_attempts() {
        let mut attempt = 0u32;
        let result = with_retries(
            RetryPolicy {
                max_attempts: 3,
                base_delay_ms: 0,
            },
            |_| {
                attempt += 1;
                let id = attempt;
                async move {
                    Err::<(), _>(AttemptError {
                        retryable: true,
                        error: Some("busy".into()),
                        status_code: Some(503),
                        request_id: Some(format!("req-{id}")),
                    })
                }
            },
            None,
        )
        .await;
        match result {
            RetryOutcome::Err {
                error,
                status_code,
                request_id,
            } => {
                assert_eq!(error.as_deref(), Some("busy"));
                assert_eq!(status_code, Some(503));
                assert_eq!(request_id.as_deref(), Some("req-3"));
            }
            RetryOutcome::Ok(_) => panic!("expected error"),
        }
        assert_eq!(attempt, 3);
    }

    #[tokio::test]
    async fn returns_value_after_a_later_success() {
        let mut attempt = 0u32;
        let result = with_retries(
            RetryPolicy {
                max_attempts: 3,
                base_delay_ms: 0,
            },
            |_| {
                attempt += 1;
                let n = attempt;
                async move {
                    if n < 2 {
                        Err(AttemptError {
                            retryable: true,
                            error: Some("tmp".into()),
                            status_code: Some(500),
                            request_id: None,
                        })
                    } else {
                        Ok("ok")
                    }
                }
            },
            None,
        )
        .await;
        assert!(matches!(result, RetryOutcome::Ok("ok")));
        assert_eq!(attempt, 2);
    }

    #[tokio::test]
    async fn completed_and_cancelled_sleep_release_the_abort_signal() {
        let flag = Arc::new(AtomicBool::new(false));
        let weak = Arc::downgrade(&flag);
        sleep_ms(5, Some(&flag)).await;
        assert!(!flag.load(Ordering::SeqCst));
        assert_eq!(Arc::strong_count(&flag), 1);
        let abort = tokio::spawn({
            let flag = flag.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(5)).await;
                flag.store(true, Ordering::SeqCst);
            }
        });
        tokio::time::timeout(Duration::from_millis(500), sleep_ms(60_000, Some(&flag)))
            .await
            .expect("sleep must stop after abort");
        abort.await.unwrap();
        assert_eq!(Arc::strong_count(&flag), 1);
        drop(flag);
        assert!(
            weak.upgrade().is_none(),
            "sleep must not retain abort state"
        );
    }

    #[tokio::test]
    async fn stops_without_another_attempt_after_abort() {
        let flag = Arc::new(AtomicBool::new(false));
        let seen = flag.clone();
        let mut calls = 0u32;
        let result = with_retries(
            RetryPolicy {
                max_attempts: 3,
                base_delay_ms: 20,
            },
            |_| {
                calls += 1;
                seen.store(true, Ordering::SeqCst);
                async {
                    Err::<(), _>(AttemptError {
                        retryable: true,
                        error: Some("busy".into()),
                        status_code: Some(503),
                        request_id: None,
                    })
                }
            },
            Some(flag),
        )
        .await;
        match result {
            RetryOutcome::Err {
                error,
                status_code,
                request_id,
            } => {
                assert_eq!(error.as_deref(), Some("aborted"));
                assert_eq!(status_code, None);
                assert_eq!(request_id, None);
            }
            RetryOutcome::Ok(_) => panic!("expected abort"),
        }
        assert_eq!(calls, 1);
    }
}
