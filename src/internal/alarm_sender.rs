//! Open-source alarm transport. Private delivery implementations belong only
//! to the commercial repository. This boundary remains a no-op with all features.

use indexmap::IndexMap;

pub async fn configure(_data_dir: &str) {}

pub fn send_alarm(_topic: &str, _data: &IndexMap<String, String>) {}

pub fn send_status(_topic: &str, _data: &IndexMap<String, String>) {}

pub async fn post_alarm(_topic: &str, _data: &IndexMap<String, String>, _timeout_ms: u64) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn public_build_never_connects_even_with_private_configuration_present() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("configs/inner");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(
            inner.join("telemetry_config.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema": 1,
                "alarm": { "url": format!("http://{address}/alarm/track") },
                "status": { "url": format!("http://{address}/status/track") },
            }))
            .unwrap(),
        )
        .unwrap();
        configure(dir.path().to_str().unwrap()).await;
        let data = IndexMap::from([("version".into(), "2.0.0".into())]);
        send_alarm("pilot_alarm", &data);
        send_status("pilot_metrics", &data);
        assert!(!post_alarm("pilot_alarm", &data, 1000).await);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }
}
