//! Port of `src/utils/content-hash.ts`.

use sha2::{Digest, Sha256};

/// First 16 hex chars of SHA-256 over the UTF-8 bytes of `text`.
pub fn content_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let hex = hex::encode(digest);
    hex[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::content_hash;

    #[test]
    fn matches_sha256_prefix_of_utf8_text() {
        // sha256("hello") begins 2cf24dba5fb0a30e…
        assert_eq!(content_hash("hello"), "2cf24dba5fb0a30e");
        assert_eq!(content_hash(""), "e3b0c44298fc1c14");
        assert_eq!(content_hash("你好"), content_hash("你好"));
        assert_ne!(content_hash("a"), content_hash("b"));
    }
}
