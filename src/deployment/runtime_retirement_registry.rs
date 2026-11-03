//! Lossless read-only registry values: console code pages cannot identify a path.
const MAX_VALUE_BYTES: usize = 1024 * 1024;

fn decode_string(kind: u32, bytes: &[u8]) -> Result<String, String> {
    if !matches!(kind, 1 | 2)
        || bytes.len() < 2
        || bytes.len() > MAX_VALUE_BYTES
        || !bytes.len().is_multiple_of(2)
    {
        return Err("runtime registry value has invalid type or size".into());
    }
    let mut units: Vec<_> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    if units.last() != Some(&0) {
        return Err("runtime registry string is not terminated".into());
    }
    while units.last() == Some(&0) {
        units.pop();
    }
    if units.contains(&0) {
        return Err("runtime registry string has embedded NUL".into());
    }
    let text = String::from_utf16(&units)
        .map_err(|_| "runtime registry string has invalid UTF16".to_owned())?;
    if text.contains(['\r', '\n']) {
        return Err("runtime registry string has multiple lines".into());
    }
    Ok(text)
}

fn query_target(args: &[String]) -> Result<(&str, &str), String> {
    if args.len() != 4 || args[0] != "query" || args[2] != "/v" {
        return Err("runtime registry query arguments are invalid".into());
    }
    let subkey = args[1]
        .strip_prefix(r"HKCU\")
        .filter(|key| !key.is_empty() && !key.contains('\0'))
        .ok_or("runtime registry query must name an HKCU subkey")?;
    if !super::WIN_DEFS.iter().any(|def| def.env_name == args[3]) {
        return Err("runtime registry query value is not a retired runtime override".into());
    }
    Ok((subkey, &args[3]))
}

fn read_string(
    mut read: impl FnMut(Option<&mut [u16]>) -> (i32, u32, u32),
) -> Result<(u32, String), String> {
    // A concurrent writer may grow a value between sizing and reading. Bound
    // retries and every allocation; uncertainty never authorizes a delete.
    for _ in 0..3 {
        let (status, kind, size) = read(None);
        if status != 0 {
            return Err(format!("runtime registry query failed ({status})"));
        }
        if !matches!(kind, 1 | 2)
            || size < 2
            || size as usize > MAX_VALUE_BYTES
            || !size.is_multiple_of(2)
        {
            return Err(
                "runtime registry value exceeded output budget or has invalid type/size".into(),
            );
        }
        let mut units = vec![0u16; size as usize / 2];
        let capacity = size;
        let (status, kind, size) = read(Some(&mut units));
        if status == 234 || size > capacity {
            continue;
        } // ERROR_MORE_DATA
        if status != 0 {
            return Err(format!("runtime registry query failed ({status})"));
        }
        let bytes: Vec<_> = units
            .into_iter()
            .flat_map(u16::to_le_bytes)
            .take(size as usize)
            .collect();
        return decode_string(kind, &bytes).map(|text| (kind, text));
    }
    Err("runtime registry value changed during bounded reads".into())
}

#[cfg(windows)]
pub(super) fn query(args: &[String]) -> Result<String, String> {
    use std::ffi::c_void;
    #[link(name = "Advapi32")]
    unsafe extern "system" {
        fn RegGetValueW(
            key: *mut c_void,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            size: *mut u32,
        ) -> i32;
    }
    let (subkey, value_name) = query_target(args)?;
    let subkey: Vec<_> = subkey.encode_utf16().chain(Some(0)).collect();
    let name: Vec<_> = value_name.encode_utf16().chain(Some(0)).collect();
    // SZ/EXPAND_SZ only; do not expand variables into an apparently owned path.
    const FLAGS: u32 = 0x0000_0002 | 0x0000_0004 | 0x1000_0000 | 0x2000_0000;
    let key = 0x8000_0001u32 as i32 as isize as *mut c_void;
    // No key handles are opened or mutated. Both reads address the exact caller
    // subkey, including the private Software key supplied by Native tests.
    let (kind, text) = read_string(|buffer| {
        let mut kind = 0;
        let (data, mut size) = match buffer {
            Some(units) => (
                units.as_mut_ptr().cast::<c_void>(),
                (units.len() * 2) as u32,
            ),
            None => (std::ptr::null_mut(), 0),
        };
        let status = unsafe {
            RegGetValueW(
                key,
                subkey.as_ptr(),
                name.as_ptr(),
                FLAGS,
                &mut kind,
                data,
                &mut size,
            )
        };
        (status, kind, size)
    })?;
    let kind = if kind == 1 { "REG_SZ" } else { "REG_EXPAND_SZ" };
    Ok(format!("    {value_name}    {kind}    {text}\r\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn encoded(text: &str) -> Vec<u8> {
        text.encode_utf16()
            .chain(Some(0))
            .flat_map(u16::to_le_bytes)
            .collect()
    }
    #[test]
    fn strict_utf16_keeps_chinese_emoji_apostrophe_and_registry_expand_literals() {
        let value = r"C:\用户 O'Brien [runtime]🚀\custom data\runtime.mjs";
        for kind in [1, 2] {
            assert_eq!(decode_string(kind, &encoded(value)).unwrap(), value);
        }
        let value = r"%USERPROFILE%\loongsuite-pilot\runtime.mjs";
        assert_eq!(decode_string(2, &encoded(value)).unwrap(), value);
        assert_eq!(decode_string(1, &encoded("")).unwrap(), "");
    }
    #[test]
    fn malformed_non_string_oversized_and_multi_line_values_never_grant_ownership() {
        for kind in [0, 3, 4, 7] {
            assert!(decode_string(kind, &encoded("owned")).is_err());
        }
        for bytes in [
            vec![],
            vec![0],
            vec![b'A', 0],
            vec![0x00, 0xd8, 0, 0],
            encoded("owned\0foreign"),
            encoded("owned\nforeign"),
            encoded("owned\rforeign"),
            vec![0; MAX_VALUE_BYTES + 2],
        ] {
            assert!(decode_string(1, &bytes).is_err());
        }
    }

    #[test]
    fn exact_hkcu_query_scope_names_are_preserved_without_user_environment_fallback() {
        let args = vec![
            "query".into(),
            r"HKCU\Software\private-fixture".into(),
            "/v".into(),
            super::super::WIN_DEFS[0].env_name.into(),
        ];
        assert_eq!(query_target(&args).unwrap().0, r"Software\private-fixture");
        for key in [r"HKLM\Environment", r"HKCU\", ""] {
            let mut invalid = args.clone();
            invalid[1] = key.into();
            assert!(query_target(&invalid).is_err());
        }
        let mut invalid = args.clone();
        invalid[3] = "UNRELATED_VALUE".into();
        assert!(query_target(&invalid).is_err());
        let mut invalid = args.clone();
        invalid[2] = "/ve".into();
        assert!(query_target(&invalid).is_err());
    }
    #[test]
    fn size_change_retries_are_bounded_and_never_accept_partial_or_oversized_data() {
        let mut calls = 0;
        let (kind, text) = read_string(|buffer| {
            calls += 1;
            match calls {
                1 => (0, 1, 2),
                2 => (234, 1, 4),
                3 => (0, 2, 4),
                4 => {
                    buffer.unwrap().copy_from_slice(&[b'A' as u16, 0]);
                    (0, 2, 4)
                }
                _ => unreachable!(),
            }
        })
        .unwrap();
        assert_eq!((kind, text), (2, "A".into()));
        assert_eq!(calls, 4);
        calls = 0;
        assert!(read_string(|buffer| {
            calls += 1;
            if buffer.is_none() {
                (0, 1, 2)
            } else {
                (234, 1, 4)
            }
        })
        .is_err());
        assert_eq!(calls, 6);
        calls = 0;
        assert!(read_string(|buffer| {
            calls += 1;
            assert!(buffer.is_none());
            (0, 1, MAX_VALUE_BYTES as u32 + 2)
        })
        .is_err());
        assert_eq!(calls, 1);
        assert!(read_string(|_| (0, 4, 4)).is_err());
    }
}
