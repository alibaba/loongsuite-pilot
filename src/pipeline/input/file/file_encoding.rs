//! The BufferEncoding values already accepted by the original file input.
use base64::Engine;

pub(super) enum FileEncoding {
    Utf8,
    Utf16Le,
    Latin1,
    Ascii,
    Base64,
    Base64Url,
    Hex,
    Unknown(String),
}
impl FileEncoding {
    pub(super) fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("").to_ascii_lowercase().as_str() {
            "" | "utf8" | "utf-8" => Self::Utf8,
            "utf16le" | "utf-16le" | "ucs2" | "ucs-2" => Self::Utf16Le,
            "latin1" | "binary" => Self::Latin1,
            "ascii" => Self::Ascii,
            "base64" => Self::Base64,
            "base64url" => Self::Base64Url,
            "hex" => Self::Hex,
            _ => Self::Unknown(value.unwrap_or("").into()),
        }
    }
    pub(super) fn decode(&self, bytes: &[u8]) -> std::io::Result<String> {
        Ok(match self {
            Self::Utf8 => String::from_utf8_lossy(bytes).into_owned(),
            Self::Utf16Le => {
                // Buffer ignores an odd trailing byte. Rust strings replace
                // isolated UTF16 surrogates because they cannot represent them.
                let units: Vec<u16> = bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| u16::from_le_bytes(*pair))
                    .collect();
                String::from_utf16_lossy(&units)
            }
            Self::Latin1 => bytes.iter().map(|byte| char::from(*byte)).collect(),
            Self::Ascii => bytes.iter().map(|byte| char::from(*byte & 0x7f)).collect(),
            Self::Base64 => base64::engine::general_purpose::STANDARD.encode(bytes),
            Self::Base64Url => base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes),
            Self::Hex => hex::encode(bytes),
            Self::Unknown(value) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("Unknown encoding: {value}"),
                ))
            }
        })
    }
    pub(super) fn byte_length(&self, text: &str) -> usize {
        match self {
            Self::Utf8 | Self::Unknown(_) => text.len(),
            Self::Utf16Le => text.encode_utf16().count() * 2,
            Self::Latin1 | Self::Ascii => text.encode_utf16().count(),
            Self::Hex => text.len() / 2,
            Self::Base64 | Self::Base64Url => {
                let len = text.len();
                let padding = if text.ends_with("==") {
                    2
                } else if text.ends_with('=') {
                    1
                } else {
                    0
                };
                (len - padding) * 3 / 4
            }
        }
    }
}
