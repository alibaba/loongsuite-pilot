//! Project a checkpoint owner record without retaining a second copy of large
//! strings in the JSON decoder. The caller bounds input to one physical line.
use std::io::{self, BufRead};

use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Clone, Copy)]
enum Fields {
    Root,
    Payload,
    All,
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid Codex owner JSON")
}

fn peek(r: &mut impl BufRead) -> io::Result<Option<u8>> {
    loop {
        let buf = r.fill_buf()?;
        let whitespace = buf
            .iter()
            .take_while(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
            .count();
        if whitespace == 0 {
            return Ok(buf.first().copied());
        }
        r.consume(whitespace);
    }
}

fn expect(r: &mut impl BufRead, byte: u8) -> io::Result<()> {
    if peek(r)? != Some(byte) {
        return Err(invalid());
    }
    r.consume(1);
    Ok(())
}

// Copy plain UTF-8 runs directly into their final allocation. Delegate escaped
// Unicode (including surrogate pairs) to serde with at most 14 bytes of input.
fn string(r: &mut impl BufRead) -> io::Result<String> {
    expect(r, b'"')?;
    let mut out = Vec::new();
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            return Err(invalid());
        }
        let n = buf
            .iter()
            .position(|&b| b < 32 || b == b'"' || b == b'\\')
            .unwrap_or(buf.len());
        out.extend_from_slice(&buf[..n]);
        let delimiter = buf.get(n).copied();
        r.consume(n + usize::from(delimiter.is_some()));
        match delimiter {
            None => continue,
            Some(b'"') => return String::from_utf8(out).map_err(|_| invalid()),
            Some(b'\\') => {
                let mut escape = [0; 14];
                escape[..2].copy_from_slice(b"\"\\");
                r.read_exact(&mut escape[2..3])?;
                let mut end = 3;
                if escape[2] == b'u' {
                    r.read_exact(&mut escape[3..7])?;
                    end = 7;
                    if matches!(escape[3], b'd' | b'D')
                        && matches!(escape[4], b'8' | b'9' | b'a' | b'A' | b'b' | b'B')
                    {
                        r.read_exact(&mut escape[7..13])?;
                        end = 13;
                    }
                }
                escape[end] = b'"';
                let decoded: char =
                    serde_json::from_slice(&escape[..=end]).map_err(|_| invalid())?;
                let mut utf8 = [0; 4];
                out.extend_from_slice(decoded.encode_utf8(&mut utf8).as_bytes());
            }
            _ => return Err(invalid()),
        }
    }
}

fn scalar(r: &mut impl BufRead) -> io::Result<Value> {
    let mut token = Vec::new();
    loop {
        let buf = r.fill_buf()?;
        let n = buf
            .iter()
            .position(|b| matches!(b, b',' | b']' | b'}' | b' ' | b'\t' | b'\r' | b'\n'))
            .unwrap_or(buf.len());
        token.extend_from_slice(&buf[..n]);
        let done = n < buf.len() || buf.is_empty();
        r.consume(n);
        if done {
            break;
        }
    }
    serde_json::from_slice(&token).map_err(|_| invalid())
}

fn skip(r: &mut impl BufRead) -> io::Result<()> {
    if matches!(peek(r)?, Some(b'{' | b'[' | b'"')) {
        // For delimited values serde consumes the closing delimiter exactly.
        serde::de::IgnoredAny::deserialize(&mut serde_json::Deserializer::from_reader(r))
            .map_err(io::Error::from)?;
    } else {
        scalar(r)?;
    }
    Ok(())
}

fn value(r: &mut impl BufRead, depth: usize) -> io::Result<Value> {
    if depth > 128 {
        return Err(invalid());
    }
    match peek(r)? {
        Some(b'"') => string(r).map(Value::String),
        Some(b'{') => object(r, Fields::All, depth).map(Value::Object),
        Some(b'[') => {
            r.consume(1);
            let mut items = Vec::new();
            if peek(r)? != Some(b']') {
                loop {
                    items.push(value(r, depth + 1)?);
                    if peek(r)? == Some(b']') {
                        break;
                    }
                    expect(r, b',')?;
                }
            }
            expect(r, b']')?;
            Ok(Value::Array(items))
        }
        Some(b'-' | b'0'..=b'9' | b't' | b'f' | b'n') => scalar(r),
        _ => Err(invalid()),
    }
}

fn object(r: &mut impl BufRead, fields: Fields, depth: usize) -> io::Result<Map<String, Value>> {
    expect(r, b'{')?;
    let mut map = Map::new();
    if peek(r)? != Some(b'}') {
        loop {
            let key = string(r)?;
            expect(r, b':')?;
            match (fields, key.as_str()) {
                (Fields::Root, "payload") => {
                    map.insert(key, Value::Object(object(r, Fields::Payload, depth + 1)?));
                }
                (Fields::All, _)
                | (_, "timestamp")
                | (Fields::Root, "type")
                | (
                    Fields::Payload,
                    "id" | "session_id" | "source" | "forked_from_id" | "thread_source"
                    | "model_provider" | "base_instructions" | "dynamic_tools",
                ) => {
                    map.insert(key, value(r, depth + 1)?);
                }
                _ => skip(r)?,
            }
            if peek(r)? == Some(b'}') {
                break;
            }
            expect(r, b',')?;
        }
    }
    expect(r, b'}')?;
    Ok(map)
}

pub(super) fn read(r: &mut impl BufRead) -> io::Result<Map<String, Value>> {
    let result = object(r, Fields::Root, 0)?;
    if peek(r)?.is_some() {
        return Err(invalid());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    #[test]
    fn projected_json_preserves_escapes_and_numbers_across_buffer_boundaries() {
        let raw = r#"{"ignore":false,"payload":{"base_instructions":{"text":"中\n\t\\\"\uD83D\uDE80"},"dynamic_tools":[[],{},{"v":[null,true,-1.25e2]}],"ignored":[{"unknown":"\""}],"id":"last"},"type":"session_meta"}"#;
        let mut expected: Value = serde_json::from_str(raw).unwrap();
        expected.as_object_mut().unwrap().remove("ignore");
        expected["payload"]
            .as_object_mut()
            .unwrap()
            .remove("ignored");
        for capacity in [1, 2, 7, 64] {
            let mut reader = BufReader::with_capacity(capacity, raw.as_bytes());
            assert_eq!(Value::Object(read(&mut reader).unwrap()), expected);
        }
        for bad in [
            r#"{"payload":{"id":"\uD800x"}}"#,
            r#"{"payload":{"dynamic_tools":[1,]}}"#,
            r#"{"payload":{"id":"\q"}}"#,
            r#"{"payload":{}} trailing"#,
        ] {
            assert!(read(&mut bad.as_bytes()).is_err());
        }
    }
}
