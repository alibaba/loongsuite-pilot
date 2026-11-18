use std::io::Read;
use std::time::Duration;

use reqwest::header::{HeaderMap, ACCEPT};
use reqwest::{Client, Url};

use super::config::Input;

pub(crate) struct Response {
    pub(crate) bytes: Vec<u8>,
    pub(crate) headers: HeaderMap,
}

pub(crate) fn client() -> anyhow::Result<Client> {
    Ok(Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}

pub(crate) async fn get(
    client: &Client,
    url: Url,
    timeout: Duration,
    limit: u64,
    access: Option<(&Input, &str)>,
) -> Result<Response, String> {
    let mut request = client
        .get(url)
        .timeout(timeout)
        .header(ACCEPT, "application/json, text/plain");
    if let Some((input, workspace)) = access {
        let token = token(input)
            .await
            .ok_or_else(|| "missing_api_token".to_string())?;
        request = request
            .bearer_auth(token)
            .header("X-Workspace-ID", workspace);
    }
    let mut response = request.send().await.map_err(network_error)?;
    if !response.status().is_success() {
        return Err(format!("http_{}", response.status().as_u16()));
    }
    let size = response.content_length();
    if size.is_some_and(|size| size > limit) {
        return Err("response_too_large".to_string());
    }
    let headers = response.headers().clone();
    let mut bytes = Vec::with_capacity(size.unwrap_or(0).min(limit) as usize);
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if (bytes.len() as u64).saturating_add(chunk.len() as u64) > limit {
            return Err("response_too_large".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Response { bytes, headers })
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "timeout".into()
    } else {
        "network_error".into()
    }
}

async fn token(input: &Input) -> Option<String> {
    const MAX_TOKEN_BYTES: u64 = 4096;
    let token = if let Some(file) = input.token_file.clone() {
        tokio::task::spawn_blocking(move || {
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NONBLOCK);
            }
            let file = options.open(file).ok()?;
            if !file.metadata().ok()?.is_file() {
                return None;
            }
            let mut token = String::new();
            file.take(MAX_TOKEN_BYTES + 1)
                .read_to_string(&mut token)
                .ok()?;
            Some(token)
        })
        .await
        .ok()
        .flatten()?
    } else {
        std::env::var(input.token_env.as_deref().unwrap_or("MULTICA_TOKEN")).ok()?
    };
    let token = token.trim();
    if token.is_empty()
        || token.len() as u64 > MAX_TOKEN_BYTES
        || !token.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return None;
    }
    Some(token.to_owned())
}
