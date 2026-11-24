use super::budget::{DoubaoWorkError as Error, Result};
use indexmap::IndexMap;
use serde_json::Value;
use std::sync::LazyLock;

pub(super) const MAX_RECORD: usize = 8 * 1024 * 1024;
const TABLE_MAGIC: [u8; 8] = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb];
const BLINK_ENVELOPE: [u8; 15] = [0xff, 0x15, 0xfe, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

pub(super) fn take<'a>(data: &mut &'a [u8], len: usize) -> Result<&'a [u8]> {
    let Some((head, tail)) = data.split_at_checked(len) else {
        return Err(Error::invalid("truncated Doubao chat data"));
    };
    *data = tail;
    Ok(head)
}

pub(super) fn read<const N: usize>(data: &mut &[u8]) -> Result<[u8; N]> {
    Ok(take(data, N)?.try_into().expect("slice length checked"))
}

pub(super) fn varint(data: &mut &[u8]) -> Result<usize> {
    let mut value = 0u64;
    for shift in (0..=49).step_by(7) {
        let [byte] = read(data)?;
        value |= u64::from(byte & 127) << shift;
        if byte & 128 == 0 {
            return usize::try_from(value)
                .map_err(|_| Error::invalid("Doubao chat length overflow"));
        }
    }
    Err(Error::invalid("invalid Doubao chat varint"))
}

pub(super) fn checked_crc(stored: u32, segments: &[&[u8]]) -> bool {
    static CRC: LazyLock<[u32; 256]> = LazyLock::new(|| {
        std::array::from_fn(|index| {
            (0..8).fold(index as u32, |crc, _| {
                (crc >> 1) ^ if crc & 1 != 0 { 0x82f63b78 } else { 0 }
            })
        })
    });
    let crc = segments
        .iter()
        .flat_map(|bytes| bytes.iter())
        .fold(!0u32, |crc, byte| {
            CRC[(crc as u8 ^ byte) as usize] ^ (crc >> 8)
        });
    !crc == stored.wrapping_sub(0xa282ead8).rotate_right(17)
}

pub(super) fn write_batch(
    mut data: &[u8],
    mut record: impl FnMut(&[u8], &[u8], u64) -> Result<()>,
) -> Result<()> {
    let sequence = u64::from_le_bytes(read(&mut data)?);
    let count = u32::from_le_bytes(read(&mut data)?);
    if count > 65536 || sequence.checked_add(u64::from(count)).is_none() {
        return Err(Error::invalid("invalid Doubao chat write batch size"));
    }
    for index in 0..count {
        let [kind] = read(&mut data)?;
        let len = varint(&mut data)?;
        let key = take(&mut data, len)?;
        let value = match kind {
            0 => &[],
            1 => {
                let len = varint(&mut data)?;
                take(&mut data, len)?
            }
            _ => return Err(Error::invalid("invalid Doubao chat operation")),
        };
        record(key, value, sequence + u64::from(index))?;
    }
    if !data.is_empty() {
        return Err(Error::invalid("invalid Doubao chat write batch length"));
    }
    Ok(())
}

pub(super) fn table_index(table: &[u8]) -> Result<Vec<(usize, usize)>> {
    let footer = table
        .len()
        .checked_sub(48)
        .and_then(|index| table.get(index..))
        .filter(|footer| footer.ends_with(&TABLE_MAGIC))
        .ok_or_else(|| Error::invalid("invalid Doubao chat table footer"))?;
    let mut handles = &footer[..40];
    varint(&mut handles)?;
    varint(&mut handles)?;
    let handle = (varint(&mut handles)?, varint(&mut handles)?);
    let mut index = Vec::new();
    block_records(&table_block(table, handle)?, |_, mut value| {
        if index.len() >= 4096 {
            return Err(Error::invalid("Doubao chat table index capacity exceeded"));
        }
        index.push((varint(&mut value)?, varint(&mut value)?));
        Ok(())
    })?;
    Ok(index)
}

pub(super) fn table_records(
    table: &[u8],
    handle: (usize, usize),
    mut record: impl FnMut(&[u8], &[u8], u64) -> Result<()>,
) -> Result<()> {
    block_records(&table_block(table, handle)?, |key, value| {
        let (key, tag) = key
            .split_last_chunk::<8>()
            .ok_or_else(|| Error::invalid("invalid Doubao chat internal key"))?;
        let tag = u64::from_le_bytes(*tag);
        match tag as u8 {
            0 => record(key, &[], tag >> 8),
            1 => record(key, value, tag >> 8),
            _ => Err(Error::invalid("invalid Doubao chat table record type")),
        }
    })
}

fn table_block(table: &[u8], (offset, size): (usize, usize)) -> Result<std::borrow::Cow<'_, [u8]>> {
    let end = offset
        .checked_add(size)
        .filter(|end| size <= MAX_RECORD && end.saturating_add(5) <= table.len().saturating_sub(48))
        .ok_or_else(|| Error::invalid("invalid Doubao chat table block"))?;
    let data = &table[offset..end];
    let kind = &table[end..end + 1];
    let crc = u32::from_le_bytes(table[end + 1..end + 5].try_into().unwrap());
    if !checked_crc(crc, &[data, kind]) {
        return Err(Error::invalid("Doubao chat table checksum mismatch"));
    }
    match kind[0] {
        0 => Ok(std::borrow::Cow::Borrowed(data)),
        1 => Ok(std::borrow::Cow::Owned(unsnappy(data)?)),
        _ => Err(Error::invalid("unsupported Doubao chat table compression")),
    }
}

fn block_records(block: &[u8], mut record: impl FnMut(&[u8], &[u8]) -> Result<()>) -> Result<()> {
    let (data, count) = block
        .split_last_chunk::<4>()
        .ok_or_else(|| Error::invalid("invalid Doubao chat restart index"))?;
    let count = u32::from_le_bytes(*count) as usize;
    let end = count
        .checked_mul(4)
        .and_then(|bytes| data.len().checked_sub(bytes))
        .filter(|_| count > 0)
        .ok_or_else(|| Error::invalid("invalid Doubao chat restart count"))?;
    let mut cursor = &data[..end];
    let mut key = Vec::new();
    while !cursor.is_empty() {
        let shared = varint(&mut cursor)?;
        let suffix = varint(&mut cursor)?;
        let len = varint(&mut cursor)?;
        if shared > key.len() || shared.saturating_add(suffix) > 64 * 1024 {
            return Err(Error::invalid("invalid Doubao chat prefix key"));
        }
        key.truncate(shared);
        key.extend_from_slice(take(&mut cursor, suffix)?);
        record(&key, take(&mut cursor, len)?)?;
    }
    Ok(())
}

fn unsnappy(mut data: &[u8]) -> Result<Vec<u8>> {
    let len = varint(&mut data)?;
    if len > MAX_RECORD {
        return Err(Error::invalid("Doubao chat table expansion limit"));
    }
    let mut out = Vec::with_capacity(len);
    while !data.is_empty() {
        let [tag] = read(&mut data)?;
        let code = usize::from(tag >> 2);
        let kind = tag & 3;
        let (count, distance) = match kind {
            0 if code < 60 => (code + 1, 0),
            0 => (little(&mut data, code - 59)?.saturating_add(1), 0),
            1 => (
                (code & 7) + 4,
                ((tag as usize & 224) << 3) | little(&mut data, 1)?,
            ),
            2 => (code + 1, little(&mut data, 2)?),
            _ => (code + 1, little(&mut data, 4)?),
        };
        if count > len - out.len() || (kind != 0 && (distance == 0 || distance > out.len())) {
            return Err(Error::invalid(
                "invalid Doubao chat table compression offset",
            ));
        }
        if kind == 0 {
            out.extend_from_slice(take(&mut data, count)?);
        } else {
            for _ in 0..count {
                out.push(out[out.len() - distance]);
            }
        }
    }
    if out.len() != len {
        return Err(Error::invalid("short Doubao chat table expansion"));
    }
    Ok(out)
}

fn little(input: &mut &[u8], len: usize) -> Result<usize> {
    let mut bytes = [0; 4];
    bytes[..len].copy_from_slice(take(input, len)?);
    Ok(u32::from_le_bytes(bytes) as usize)
}

enum JsValue {
    Scalar(Value),
    Object(IndexMap<String, usize>),
    Array(Vec<usize>),
}

struct CloneData<'a> {
    bytes: &'a [u8],
    values: Vec<JsValue>,
    references: Vec<usize>,
}

impl CloneData<'_> {
    fn tag(&mut self) -> Result<u8> {
        self.bytes = self.bytes.trim_ascii_start_matches_zero();
        Ok(read::<1>(&mut self.bytes)?[0])
    }

    fn number(&mut self) -> Result<usize> {
        varint(&mut self.bytes)
    }

    fn value(&mut self, depth: usize) -> Result<usize> {
        if depth >= 64 || self.values.len() >= 200_000 {
            return Err(Error::invalid(
                "Doubao chat structured clone capacity exceeded",
            ));
        }
        let tag = self.tag()?;
        if tag == b'^' {
            let index = self.number()?;
            return self
                .references
                .get(index)
                .copied()
                .ok_or_else(|| Error::invalid("invalid V8 object reference"));
        }
        let index = self.values.len();
        self.values.push(JsValue::Scalar(Value::Null));
        let value = match tag {
            b'o' | b'A' | b'a' => {
                self.references.push(index);
                let (length, end) = match tag {
                    b'o' => (0, b'{'),
                    b'A' => (self.number()?, b'$'),
                    _ => (self.number()?, b'@'),
                };
                if length > 200_000 {
                    return Err(Error::invalid("V8 array capacity exceeded"));
                }
                let mut elements = Vec::new();
                if tag == b'A' {
                    for _ in 0..length {
                        elements.push(self.value(depth + 1)?);
                    }
                }
                let mut properties = IndexMap::new();
                while self.bytes.trim_ascii_start_matches_zero().first().copied() != Some(end) {
                    let key = self.value(depth + 1)?;
                    let key = match &self.values[key] {
                        JsValue::Scalar(Value::String(key)) => key.clone(),
                        JsValue::Scalar(Value::Number(key)) => key.to_string(),
                        _ => return Err(Error::invalid("invalid V8 property name")),
                    };
                    let entry = self.value(depth + 1)?;
                    if properties.insert(key, entry).is_some() {
                        return Err(Error::invalid("duplicate V8 property"));
                    }
                }
                self.tag()?;
                if self.number()? != properties.len() || (tag != b'o' && self.number()? != length) {
                    return Err(Error::invalid("V8 object size mismatch"));
                }
                if tag == b'o' {
                    JsValue::Object(properties)
                } else {
                    if tag == b'a' {
                        let empty = self.values.len();
                        self.values.push(JsValue::Scalar(Value::Null));
                        elements.resize(length, empty);
                        for (key, entry) in properties {
                            if let Ok(index) = key.parse::<usize>() {
                                if let Some(item) = elements.get_mut(index) {
                                    *item = entry;
                                }
                            }
                        }
                    }
                    JsValue::Array(elements)
                }
            }
            b'S' | b'"' | b'c' => {
                let len = self.number()?;
                let text = take(&mut self.bytes, len)?;
                let text = match tag {
                    b'S' => std::str::from_utf8(text)
                        .map_err(|_| Error::invalid("invalid V8 UTF-8"))?
                        .to_owned(),
                    b'"' => text.iter().map(|byte| char::from(*byte)).collect(),
                    _ if len % 2 == 0 => String::from_utf16_lossy(
                        &text
                            .as_chunks::<2>()
                            .0
                            .iter()
                            .map(|part| u16::from_le_bytes([part[0], part[1]]))
                            .collect::<Vec<_>>(),
                    ),
                    _ => return Err(Error::invalid("invalid V8 UTF-16")),
                };
                JsValue::Scalar(text.into())
            }
            b'I' => {
                let raw = u32::try_from(self.number()?)
                    .map_err(|_| Error::invalid("invalid V8 integer"))?;
                JsValue::Scalar((((raw >> 1) as i32) ^ -((raw & 1) as i32)).into())
            }
            b'U' => JsValue::Scalar(self.number()?.into()),
            b'N' => {
                let num = f64::from_le_bytes(read(&mut self.bytes)?);
                let value = if num.fract() == 0.0 && num.abs() <= 9_007_199_254_740_991.0 {
                    (num as i64).into()
                } else {
                    serde_json::Number::from_f64(num).map_or(Value::Null, Value::Number)
                };
                JsValue::Scalar(value)
            }
            b'T' | b'F' => JsValue::Scalar((tag == b'T').into()),
            b'_' | b'0' | b'-' => JsValue::Scalar(Value::Null),
            _ => {
                return Err(Error::invalid(
                    "unsupported Doubao chat structured clone type",
                ))
            }
        };
        self.values[index] = value;
        Ok(index)
    }

    fn json(&self, index: usize, depth: usize, remaining: &mut usize) -> Result<Value> {
        if depth >= 64 || *remaining == 0 {
            return Err(Error::invalid("Doubao chat reference expansion limit"));
        }
        *remaining -= 1;
        Ok(match &self.values[index] {
            JsValue::Scalar(value) => {
                if let Some(text) = value.as_str() {
                    *remaining = remaining
                        .checked_sub(text.len())
                        .ok_or_else(|| Error::invalid("Doubao chat decoded content limit"))?;
                }
                value.clone()
            }
            JsValue::Object(values) => {
                let mut object = serde_json::Map::new();
                for (key, index) in values {
                    *remaining = remaining
                        .checked_sub(key.len())
                        .ok_or_else(|| Error::invalid("Doubao chat decoded content limit"))?;
                    object.insert(key.clone(), self.json(*index, depth + 1, remaining)?);
                }
                Value::Object(object)
            }
            JsValue::Array(values) => Value::Array(
                values
                    .iter()
                    .map(|index| self.json(*index, depth + 1, remaining))
                    .collect::<Result<_>>()?,
            ),
        })
    }
}

trait SkipPadding {
    fn trim_ascii_start_matches_zero(&self) -> &[u8];
}
impl SkipPadding for [u8] {
    fn trim_ascii_start_matches_zero(&self) -> &[u8] {
        let start = self
            .iter()
            .position(|byte| *byte != 0)
            .unwrap_or(self.len());
        &self[start..]
    }
}

pub(super) fn chat_values(mut data: &[u8]) -> Result<Option<IndexMap<String, Value>>> {
    if data.is_empty() {
        return Ok(None);
    }
    varint(&mut data)?;
    if take(&mut data, BLINK_ENVELOPE.len())? != BLINK_ENVELOPE || read::<1>(&mut data)? != [0xff] {
        return Err(Error::invalid("unrecognized Doubao chat Blink encoding"));
    }
    let version = varint(&mut data)?;
    if version != 15 {
        return Err(Error::invalid("unsupported Doubao chat V8 version"));
    }
    let mut decoder = CloneData {
        bytes: data,
        values: Vec::new(),
        references: Vec::new(),
    };
    let root = decoder.value(0)?;
    let object = |index| match decoder.values.get(index) {
        Some(JsValue::Object(value)) => Some(value),
        _ => None,
    };
    let tasks = object(root)
        .and_then(|value| object(*value.get("state")?))
        .and_then(|value| object(*value.get("mainTaskDataMap")?))
        .ok_or_else(|| Error::invalid("missing Doubao chat task map"))?;
    let mut remaining = MAX_RECORD;
    let tasks = tasks
        .iter()
        .skip(tasks.len().saturating_sub(128))
        .map(|(key, index)| Ok((key.clone(), decoder.json(*index, 0, &mut remaining)?)))
        .collect::<Result<_>>()?;
    Ok(Some(tasks))
}
