//! 不执行候选程序的发行二进制校验。只接受目标平台的单架构 64 位可执行映像。

use anyhow::{ensure, Context, Result};
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryInfo {
    pub format: &'static str,
    pub architecture: &'static str,
    /// 静态 ELF 没有解释器；不据此推断它使用了哪一种 libc。
    pub interpreter: Option<String>,
}

pub fn validate_binary(path: &Path, target: &str) -> Result<BinaryInfo> {
    let metadata = super::runtime_paths::runtime_metadata(path)?;
    ensure!(metadata.is_file(), "二进制不是普通文件");
    #[cfg(unix)]
    if !target.contains("windows") {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o111 != 0,
            "二进制没有执行权限"
        );
    }
    let mut file = File::open(path)?;
    inspect(&mut file, metadata.len(), target)
        .with_context(|| format!("二进制格式或架构不匹配：{}，目标 {target}", path.display()))
}

/// Validate a target-native shared library without requiring an executable entry.
pub fn validate_shared_library(path: &Path, target: &str) -> Result<BinaryInfo> {
    let metadata = super::runtime_paths::runtime_metadata(path)?;
    ensure!(metadata.is_file(), "SDK is not a regular file");
    let mut file = File::open(path)?;
    inspect_image(&mut file, metadata.len(), target, true)
}

fn inspect(input: &mut (impl Read + Seek), size: u64, target: &str) -> Result<BinaryInfo> {
    inspect_image(input, size, target, false)
}
fn inspect_image(
    input: &mut (impl Read + Seek),
    size: u64,
    target: &str,
    shared: bool,
) -> Result<BinaryInfo> {
    ensure!(
        super::runtime_paths::SUPPORTED_TARGETS.contains(&target),
        "不支持的目标平台"
    );
    let arm = target.starts_with("aarch64-");
    let architecture = if arm { "aarch64" } else { "x86_64" };
    let (format, interpreter) = if target.contains("linux") {
        ("elf64", elf_image(input, size, arm, shared)?)
    } else if target.contains("apple") {
        macho_image(input, size, arm, shared)?;
        ("mach-o64", None)
    } else {
        pe_image(input, size, arm, shared)?;
        ("pe32+", None)
    };
    Ok(BinaryInfo {
        format,
        architecture,
        interpreter,
    })
}

fn range(size: u64, offset: u64, length: u64) -> Result<()> {
    ensure!(
        offset.checked_add(length).is_some_and(|end| end <= size),
        "二进制结构越界或被截断"
    );
    Ok(())
}

fn read_at<const N: usize>(
    input: &mut (impl Read + Seek),
    size: u64,
    offset: u64,
) -> Result<[u8; N]> {
    range(size, offset, N as u64)?;
    input.seek(SeekFrom::Start(offset))?;
    let mut bytes = [0; N];
    input.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn u16le(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().expect("固定长度字段"))
}
fn u32le(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("固定长度字段"))
}
fn u64le(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("固定长度字段"))
}

fn elf_image(
    input: &mut (impl Read + Seek),
    size: u64,
    arm: bool,
    shared: bool,
) -> Result<Option<String>> {
    let header = read_at::<64>(input, size, 0)?;
    ensure!(
        &header[..7] == b"\x7fELF\x02\x01\x01",
        "不是 little-endian ELF64"
    );
    ensure!(matches!(header[7], 0 | 3), "不是 Linux/System V ELF");
    ensure!(
        matches!(u16le(&header, 16), 2 | 3) && u32le(&header, 20) == 1,
        "不是 ELF 可执行映像"
    );
    ensure!(
        u16le(&header, 18) == if arm { 183 } else { 62 },
        "ELF CPU 架构不匹配"
    );
    if shared {
        ensure!(u16le(&header, 16) == 3, "SDK must be ET_DYN");
    } else {
        ensure!(u64le(&header, 24) != 0, "ELF 缺少可执行入口");
    }
    ensure!(
        u16le(&header, 52) == 64 && u16le(&header, 54) == 56,
        "ELF 头长度无效"
    );
    let offset = u64le(&header, 32);
    let count = u16le(&header, 56) as u64;
    ensure!(
        offset >= 64 && count > 0 && count <= 4096,
        "ELF program headers 无效"
    );
    range(size, offset, count * 56)?;
    let mut load = false;
    let mut interpreter = None;
    for index in 0..count {
        let segment = read_at::<56>(input, size, offset + index * 56)?;
        let start = u64le(&segment, 8);
        let filesz = u64le(&segment, 32);
        range(size, start, filesz)?;
        match u32le(&segment, 0) {
            1 => {
                ensure!(filesz <= u64le(&segment, 40), "ELF load segment 长度无效");
                load = true;
            }
            3 => {
                ensure!(
                    interpreter.is_none() && (2..=4096).contains(&filesz),
                    "ELF 解释器无效"
                );
                input.seek(SeekFrom::Start(start))?;
                let mut bytes = vec![0; filesz as usize];
                input.read_exact(&mut bytes)?;
                ensure!(
                    bytes.pop() == Some(0) && !bytes.contains(&0),
                    "ELF 解释器未正确终止"
                );
                let path = String::from_utf8(bytes)?;
                let expected = if arm {
                    "/lib/ld-linux-aarch64.so.1"
                } else {
                    "/lib64/ld-linux-x86-64.so.2"
                };
                ensure!(path == expected, "ELF 动态解释器与目标 libc 不匹配：{path}");
                interpreter = Some(path);
            }
            _ => {}
        }
    }
    ensure!(load, "ELF 缺少 load segment");
    Ok(interpreter)
}

fn macho_image(input: &mut (impl Read + Seek), size: u64, arm: bool, shared: bool) -> Result<()> {
    let header = read_at::<32>(input, size, 0)?;
    ensure!(
        u32le(&header, 0) == 0xfeedfacf,
        "不是单架构 little-endian Mach-O64"
    );
    ensure!(
        u32le(&header, 4) == if arm { 0x0100000c } else { 0x01000007 },
        "Mach-O CPU 架构不匹配"
    );
    ensure!(
        u32le(&header, 12) == if shared { 6 } else { 2 },
        "Mach-O image type mismatch"
    );
    let count = u32le(&header, 16);
    let length = u32le(&header, 20) as u64;
    ensure!(
        count > 0 && count <= 4096 && length <= 16 * 1024 * 1024,
        "Mach-O load commands 无效"
    );
    range(size, 32, length)?;
    let end = 32 + length;
    let mut offset = 32;
    let mut load = false;
    let mut entry = false;
    for _ in 0..count {
        range(end, offset, 8)?;
        let command = read_at::<8>(input, size, offset)?;
        let kind = u32le(&command, 0);
        let length = u32le(&command, 4) as u64;
        ensure!(
            length >= 8 && length.is_multiple_of(8),
            "Mach-O command 长度无效"
        );
        range(end, offset, length)?;
        if kind == 0x19 {
            ensure!(length >= 72, "Mach-O segment 被截断");
            let segment = read_at::<72>(input, size, offset)?;
            let filesz = u64le(&segment, 48);
            range(size, u64le(&segment, 40), filesz)?;
            ensure!(filesz <= u64le(&segment, 32), "Mach-O segment 长度无效");
            ensure!(
                72 + u32le(&segment, 64) as u64 * 80 == length,
                "Mach-O section 表无效"
            );
            load |= filesz > 0;
        } else if kind == 0x80000028 {
            ensure!(length == 24 && !entry, "Mach-O LC_MAIN 无效");
            let main = read_at::<24>(input, size, offset)?;
            ensure!(u64le(&main, 8) < size, "Mach-O 入口越界");
            entry = true;
        }
        offset += length;
    }
    ensure!(
        offset == end && load && (shared || entry),
        "Mach-O 缺少可执行 segment/入口或长度不一致"
    );
    Ok(())
}

fn pe_image(input: &mut (impl Read + Seek), size: u64, arm: bool, shared: bool) -> Result<()> {
    let dos = read_at::<64>(input, size, 0)?;
    ensure!(&dos[..2] == b"MZ", "缺少 DOS header");
    let offset = u32le(&dos, 60) as u64;
    ensure!(offset >= 64, "PE header 位置无效");
    let coff = read_at::<24>(input, size, offset)?;
    ensure!(&coff[..4] == b"PE\0\0", "缺少 PE signature");
    ensure!(
        u16le(&coff, 4) == if arm { 0xaa64 } else { 0x8664 },
        "PE CPU 架构不匹配"
    );
    let flags = u16le(&coff, 22);
    ensure!(
        flags & 0x0002 != 0 && (flags & 0x2000 != 0) == shared,
        "PE 不是可执行程序或为 DLL"
    );
    let count = u16le(&coff, 6) as u64;
    let optional_size = u16le(&coff, 20) as u64;
    ensure!(
        count > 0 && count <= 96 && optional_size >= 112,
        "PE section/optional header 无效"
    );
    range(size, offset + 24, optional_size + count * 40)?;
    let optional = read_at::<112>(input, size, offset + 24)?;
    ensure!(u16le(&optional, 0) == 0x20b, "PE 不是 PE32+");
    ensure!(
        u32le(&optional, 16) != 0 && matches!(u16le(&optional, 68), 2 | 3),
        "PE 缺少应用入口或 subsystem 无效"
    );
    ensure!(
        112 + u32le(&optional, 108) as u64 * 8 <= optional_size,
        "PE data directory 表越界"
    );
    let mut load = false;
    for index in 0..count {
        let section = read_at::<40>(input, size, offset + 24 + optional_size + index * 40)?;
        let length = u32le(&section, 16) as u64;
        if length > 0 {
            range(size, u32le(&section, 20) as u64, length)?;
            load = true;
        }
    }
    ensure!(load, "PE 缺少文件内 section");
    Ok(())
}

/// 只用于格式校验的合成文件，不能启动或冒充平台构建产物。
#[cfg(test)]
pub(crate) fn fixture_binary(target: &str) -> Vec<u8> {
    let arm = target.starts_with("aarch64-");
    let mut bytes = vec![0; 1024];
    let put16 = |bytes: &mut [u8], offset, value: u16| {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes())
    };
    let put32 = |bytes: &mut [u8], offset, value: u32| {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes())
    };
    let put64 = |bytes: &mut [u8], offset, value: u64| {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes())
    };
    if target.contains("linux") {
        bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        put16(&mut bytes, 16, 3);
        put16(&mut bytes, 18, if arm { 183 } else { 62 });
        put32(&mut bytes, 20, 1);
        put64(&mut bytes, 24, 512);
        put64(&mut bytes, 32, 64);
        put16(&mut bytes, 52, 64);
        put16(&mut bytes, 54, 56);
        put16(&mut bytes, 56, 1);
        put32(&mut bytes, 64, 1);
        put64(&mut bytes, 96, 1024);
        put64(&mut bytes, 104, 4096);
    } else if target.contains("apple") {
        put32(&mut bytes, 0, 0xfeedfacf);
        put32(&mut bytes, 4, if arm { 0x0100000c } else { 0x01000007 });
        put32(&mut bytes, 12, 2);
        put32(&mut bytes, 16, 2);
        put32(&mut bytes, 20, 96);
        put32(&mut bytes, 32, 0x19);
        put32(&mut bytes, 36, 72);
        put64(&mut bytes, 64, 4096);
        put64(&mut bytes, 80, 1024);
        put32(&mut bytes, 104, 0x80000028);
        put32(&mut bytes, 108, 24);
        put64(&mut bytes, 112, 512);
    } else if target.contains("windows") {
        bytes[..2].copy_from_slice(b"MZ");
        put32(&mut bytes, 60, 64);
        bytes[64..68].copy_from_slice(b"PE\0\0");
        put16(&mut bytes, 68, if arm { 0xaa64 } else { 0x8664 });
        put16(&mut bytes, 70, 1);
        put16(&mut bytes, 84, 112);
        put16(&mut bytes, 86, 2);
        put16(&mut bytes, 88, 0x20b);
        put32(&mut bytes, 104, 4096);
        put16(&mut bytes, 156, 3);
        put32(&mut bytes, 216, 512);
        put32(&mut bytes, 220, 512);
    } else {
        panic!("fixture 不支持的目标");
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::super::runtime_paths::{build_target, SUPPORTED_TARGETS};
    use super::*;
    use std::io::Cursor;

    #[test]
    fn all_six_formats_accept_only_matching_os_and_architecture() {
        for source in SUPPORTED_TARGETS {
            let bytes = fixture_binary(source);
            for target in SUPPORTED_TARGETS {
                let result = inspect(&mut Cursor::new(&bytes), bytes.len() as u64, target);
                let compatible = source == target;
                assert_eq!(
                    result.is_ok(),
                    compatible,
                    "{source} => {target}: {result:?}"
                );
            }
        }
    }

    #[test]
    fn rejects_truncated_headers_scripts_dll_and_invalid_tables() {
        for target in SUPPORTED_TARGETS {
            let bytes = fixture_binary(target);
            for length in [0, 1, 63, 127, 255, 1023] {
                assert!(
                    inspect(&mut Cursor::new(&bytes[..length]), length as u64, target).is_err(),
                    "{target}: {length}"
                );
            }
            let text = b"#!/bin/sh\nnode dist/index.js\n";
            assert!(inspect(&mut Cursor::new(text), text.len() as u64, target).is_err());
            let mut bad = bytes;
            if target.contains("linux") {
                bad[32..40].copy_from_slice(&u64::MAX.to_le_bytes());
            } else if target.contains("apple") {
                bad[20..24].copy_from_slice(&u32::MAX.to_le_bytes());
            } else {
                bad[86..88].copy_from_slice(&0x2002u16.to_le_bytes());
            }
            assert!(inspect(&mut Cursor::new(&bad), bad.len() as u64, target).is_err());
        }
    }

    #[test]
    fn dynamic_elf_interpreter_must_match_libc_and_architecture() {
        for target in SUPPORTED_TARGETS
            .into_iter()
            .filter(|target| target.contains("linux"))
        {
            let mut bytes = fixture_binary(target);
            bytes[56..58].copy_from_slice(&2u16.to_le_bytes());
            bytes[120..124].copy_from_slice(&3u32.to_le_bytes());
            bytes[128..136].copy_from_slice(&256u64.to_le_bytes());
            let interpreter = if target.starts_with("aarch64") {
                "/lib/ld-linux-aarch64.so.1"
            } else {
                "/lib64/ld-linux-x86-64.so.2"
            };
            bytes[152..160].copy_from_slice(&((interpreter.len() + 1) as u64).to_le_bytes());
            bytes[256..256 + interpreter.len()].copy_from_slice(interpreter.as_bytes());
            for candidate in SUPPORTED_TARGETS
                .into_iter()
                .filter(|target| target.contains("linux"))
            {
                let result = inspect(&mut Cursor::new(&bytes), bytes.len() as u64, candidate);
                assert_eq!(
                    result.is_ok(),
                    target == candidate,
                    "{target} => {candidate}: {result:?}"
                );
            }
        }
    }

    #[test]
    fn rejects_removed_musl_targets_and_their_interpreters() {
        for (gnu, musl, interpreter) in [
            (
                "x86_64-unknown-linux-gnu",
                "x86_64-unknown-linux-musl",
                "/lib/ld-musl-x86_64.so.1",
            ),
            (
                "aarch64-unknown-linux-gnu",
                "aarch64-unknown-linux-musl",
                "/lib/ld-musl-aarch64.so.1",
            ),
        ] {
            let mut bytes = fixture_binary(gnu);
            assert!(inspect(&mut Cursor::new(&bytes), bytes.len() as u64, musl).is_err());
            bytes[56..58].copy_from_slice(&2u16.to_le_bytes());
            bytes[120..124].copy_from_slice(&3u32.to_le_bytes());
            bytes[128..136].copy_from_slice(&256u64.to_le_bytes());
            bytes[152..160].copy_from_slice(&((interpreter.len() + 1) as u64).to_le_bytes());
            bytes[256..256 + interpreter.len()].copy_from_slice(interpreter.as_bytes());
            assert!(inspect(&mut Cursor::new(&bytes), bytes.len() as u64, gnu).is_err());
        }
    }

    #[test]
    fn inspects_the_running_native_test_binary_without_execution() {
        let info = validate_binary(&std::env::current_exe().unwrap(), build_target()).unwrap();
        assert_eq!(info.architecture, std::env::consts::ARCH);
    }
}
