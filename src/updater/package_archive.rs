//! 有界解包到全新私有目录；拒绝链接、重复路径和跨平台路径别名。

use super::release_manifest::ArchiveFormat;
use anyhow::{ensure, Context, Result};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

pub const MAX_DOWNLOAD_BYTES: usize = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;

pub struct UnpackedPackage {
    _temporary: tempfile::TempDir,
    pub root: PathBuf,
}

pub fn unpack(
    bytes: &[u8],
    format: ArchiveFormat,
    parent: &Path,
    package_name: &str,
) -> Result<UnpackedPackage> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_DOWNLOAD_BYTES,
        "下载归档大小无效"
    );
    validate_path(package_name, false)?;
    ensure!(!package_name.contains('/'), "包根目录必须是单一组件");
    fs::create_dir_all(parent)?;
    let mut builder = tempfile::Builder::new();
    builder.prefix(".unpack-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o700));
    }
    let temporary = builder.tempdir_in(parent)?;
    let mut state = ExtractState {
        root: temporary.path(),
        seen: HashSet::new(),
        components: HashMap::new(),
        total: 0,
    };
    match format {
        ArchiveFormat::TarGz => {
            let decoder = flate2::read::GzDecoder::new(bytes);
            let mut archive =
                tar::Archive::new(decoder.take(MAX_EXPANDED_BYTES + 32 * 1024 * 1024));
            // 禁止扩展头在校验前触发不受限分配；发行端生成标准 USTAR。
            for entry in archive.entries()?.raw(true) {
                let mut entry = entry?;
                let kind = entry.header().entry_type();
                ensure!(
                    kind.is_file() || kind.is_dir(),
                    "归档包含链接、特殊文件或扩展头"
                );
                let name = String::from_utf8(entry.path_bytes().into_owned())
                    .context("归档路径必须是 UTF-8")?;
                let size = entry.header().size()?;
                let mode = entry.header().mode()?;
                state.write(&name, kind.is_dir(), size, mode, &mut entry)?;
            }
            // 读取 gzip 尾部，以检测校验和错误和截断；尾部只能包含 TAR 零填充。
            let mut reader = archive.into_inner();
            let mut tail = [0_u8; 8192];
            loop {
                let n = reader.read(&mut tail)?;
                if n == 0 {
                    break;
                }
                ensure!(tail[..n].iter().all(|byte| *byte == 0), "归档包含尾随数据");
            }
        }
        ArchiveFormat::Zip => {
            let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
            ensure!(archive.len() <= MAX_ENTRIES, "归档条目数超限");
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index)?;
                ensure!(!entry.encrypted(), "不接受加密归档");
                let name = std::str::from_utf8(entry.name_raw())
                    .context("ZIP 路径必须是 UTF-8")?
                    .to_string();
                let is_dir = entry.is_dir();
                let mode = entry
                    .unix_mode()
                    .unwrap_or(if is_dir { 0o40755 } else { 0o100644 });
                let kind = mode & 0o170000;
                ensure!(
                    kind == 0 || (is_dir && kind == 0o040000) || (!is_dir && kind == 0o100000),
                    "ZIP 包含链接或特殊文件"
                );
                let size = entry.size();
                state.write(&name, is_dir, size, mode, &mut entry)?;
            }
        }
    }
    ensure!(!state.seen.is_empty(), "空归档");
    let roots: Vec<_> = fs::read_dir(temporary.path())?.collect::<std::io::Result<_>>()?;
    ensure!(
        roots.len() == 1 && roots[0].file_name() == package_name && roots[0].file_type()?.is_dir(),
        "归档必须且只能包含预期包根目录"
    );
    let root = temporary.path().join(package_name);
    ensure!(
        root.join("runtime-manifest.json").is_file(),
        "归档不是原生 Rust 包"
    );
    Ok(UnpackedPackage {
        _temporary: temporary,
        root,
    })
}

struct ExtractState<'a> {
    root: &'a Path,
    seen: HashSet<String>,
    components: HashMap<String, (String, bool)>,
    total: u64,
}

impl ExtractState<'_> {
    fn write(
        &mut self,
        name: &str,
        directory: bool,
        size: u64,
        mode: u32,
        reader: &mut impl Read,
    ) -> Result<()> {
        let name = validate_path(name, directory)?;
        ensure!(
            self.seen.len() < MAX_ENTRIES && self.seen.insert(name.to_lowercase()),
            "归档包含重复路径或条目数超限"
        );
        let mut prefix = String::new();
        let parts: Vec<_> = name.split('/').collect();
        for (index, part) in parts.iter().enumerate() {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let is_directory = index + 1 < parts.len() || directory;
            let record = self
                .components
                .entry(prefix.to_lowercase())
                .or_insert_with(|| (prefix.clone(), is_directory));
            ensure!(
                record.0 == prefix && record.1 == is_directory,
                "归档包含父目录大小写别名或文件/目录冲突"
            );
        }
        ensure!(size <= MAX_FILE_BYTES, "归档单文件大小超限");
        self.total = self.total.checked_add(size).context("归档大小溢出")?;
        ensure!(self.total <= MAX_EXPANDED_BYTES, "归档解压大小超限");
        let path = self.root.join(&name);
        if directory {
            ensure!(size == 0, "目录条目不能包含数据");
            fs::create_dir_all(&path)?;
            return Ok(());
        }
        fs::create_dir_all(path.parent().context("文件缺少父目录")?)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // 去掉 setuid/setgid/sticky 和组/其他用户写权限。
            options.mode(if mode & 0o111 != 0 { 0o755 } else { 0o644 });
        }
        #[cfg(not(unix))]
        let _ = mode;
        let mut file = options.open(&path)?;
        let actual = std::io::copy(&mut reader.take(size + 1), &mut file)?;
        ensure!(actual == size, "归档文件长度不匹配");
        file.sync_all()?;
        Ok(())
    }
}

fn validate_path(name: &str, directory: bool) -> Result<String> {
    let name = if directory {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    ensure!(
        !name.is_empty()
            && name.len() <= 4096
            && !name.contains(['\\', ':'])
            && !name.chars().any(char::is_control),
        "归档路径无效"
    );
    for component in name.split('/') {
        let reserved = component
            .split('.')
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        let device_number = reserved
            .strip_prefix("COM")
            .or_else(|| reserved.strip_prefix("LPT"));
        ensure!(
            !component.is_empty()
                && component != "."
                && component != ".."
                && !component.ends_with(['.', ' '])
                && !component.contains(['<', '>', '"', '|', '?', '*'])
                && !matches!(reserved.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                && !device_number
                    .is_some_and(|number| number.len() == 1 && "123456789".contains(number)),
            "归档包含越界路径或 Windows 路径别名"
        );
    }
    Ok(name.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tar_bytes(entries: &[(&str, &[u8], tar::EntryType)]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for (name, bytes, kind) in entries {
            let mut header = tar::Header::new_ustar();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            header.set_entry_type(*kind);
            builder.append_data(&mut header, name, *bytes).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn extracts_both_formats_and_preserves_executable_permission() {
        let dir = tempfile::tempdir().unwrap();
        let entries = [
            (
                "pkg/runtime-manifest.json",
                b"{}".as_slice(),
                tar::EntryType::Regular,
            ),
            (
                "pkg/bin/pilot",
                b"native".as_slice(),
                tar::EntryType::Regular,
            ),
        ];
        let tar = tar_bytes(&entries);
        let result = unpack(&tar, ArchiveFormat::TarGz, dir.path(), "pkg").unwrap();
        assert_eq!(fs::read(result.root.join("bin/pilot")).unwrap(), b"native");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(result.root.join("bin/pilot"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o755
            );
        }
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes, _) in entries {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        let zip = zip.finish().unwrap().into_inner();
        let result = unpack(&zip, ArchiveFormat::Zip, dir.path(), "pkg").unwrap();
        assert_eq!(fs::read(result.root.join("bin/pilot")).unwrap(), b"native");
    }

    #[test]
    fn unicode_staging_extracts_both_formats_and_cleans_failed_candidates() {
        let temp = tempfile::tempdir().unwrap();
        let entries = [
            (
                "pkg/runtime-manifest.json",
                b"{}".as_slice(),
                tar::EntryType::Regular,
            ),
            (
                "pkg/bin/pilot",
                b"candidate".as_slice(),
                tar::EntryType::Regular,
            ),
        ];
        let tar = tar_bytes(&entries);
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes, _) in entries {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        let zip = zip.finish().unwrap().into_inner();
        for name in ["ascii-install", "张三 安装 🚀"] {
            let parent = temp.path().join(name);
            fs::create_dir(&parent).unwrap();
            let current = parent.join("current");
            fs::write(&current, b"existing-version").unwrap();
            for (format, bytes) in [(ArchiveFormat::TarGz, &tar), (ArchiveFormat::Zip, &zip)] {
                let result = unpack(bytes, format, &parent, "pkg").unwrap();
                let staging = result.root.parent().unwrap();
                assert_eq!(staging.parent(), Some(parent.as_path()));
                assert!(staging
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with(".unpack-"));
                assert_eq!(
                    fs::read(result.root.join("bin/pilot")).unwrap(),
                    b"candidate"
                );
                assert_eq!(fs::read(&current).unwrap(), b"existing-version");
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    assert_eq!(
                        fs::metadata(staging).unwrap().permissions().mode() & 0o777,
                        0o700
                    );
                }
                drop(result);
                assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
                assert!(unpack(&bytes[..bytes.len() / 2], format, &parent, "pkg").is_err());
                assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
                assert_eq!(fs::read(&current).unwrap(), b"existing-version");
                // 解包失败后不残留目标目录，原位置可立即重试。
                drop(unpack(bytes, format, &parent, "pkg").unwrap());
                assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
            }
        }
    }

    #[test]
    fn rejects_unsafe_names_and_links_without_leaving_partial_directories() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "../outside",
            "/absolute",
            "C:/evil",
            "pkg/../evil",
            "pkg\\evil",
            "pkg/file:stream",
            "pkg/CON.txt",
            "pkg/name.",
            "pkg/LPT1",
            "pkg//file",
        ] {
            let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"evil").unwrap();
            let zip = zip.finish().unwrap().into_inner();
            assert!(
                unpack(&zip, ArchiveFormat::Zip, dir.path(), "pkg").is_err(),
                "{name}"
            );
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        }
        for kind in [
            tar::EntryType::Symlink,
            tar::EntryType::Link,
            tar::EntryType::Fifo,
            tar::EntryType::GNULongName,
        ] {
            let bytes = tar_bytes(&[("pkg/link", b"", kind)]);
            assert!(unpack(&bytes, ArchiveFormat::TarGz, dir.path(), "pkg").is_err());
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn limits_are_checked_before_reading_or_creating_files() {
        let root = tempfile::tempdir().unwrap();
        let mut state = ExtractState {
            root: root.path(),
            seen: HashSet::new(),
            components: HashMap::new(),
            total: 0,
        };
        assert!(state
            .write(
                "pkg/huge",
                false,
                MAX_FILE_BYTES + 1,
                0o644,
                &mut std::io::empty()
            )
            .is_err());
        state.total = MAX_EXPANDED_BYTES;
        assert!(state
            .write("pkg/overflow", false, 1, 0o644, &mut std::io::empty())
            .is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn rejects_duplicate_case_paths_wrong_root_legacy_and_corrupt_gzip() {
        let dir = tempfile::tempdir().unwrap();
        for entries in [
            vec![
                ("pkg/file", b"a".as_slice(), tar::EntryType::Regular),
                ("pkg/FILE", b"b".as_slice(), tar::EntryType::Regular),
            ],
            vec![
                ("pkg/Bin/a", b"a".as_slice(), tar::EntryType::Regular),
                ("pkg/bin/b", b"b".as_slice(), tar::EntryType::Regular),
            ],
            vec![
                ("pkg/bin/a", b"a".as_slice(), tar::EntryType::Regular),
                ("pkg/bin", b"b".as_slice(), tar::EntryType::Regular),
            ],
            vec![(
                "other/runtime-manifest.json",
                b"{}".as_slice(),
                tar::EntryType::Regular,
            )],
            vec![(
                "pkg/package.json",
                b"{}".as_slice(),
                tar::EntryType::Regular,
            )],
        ] {
            let bytes = tar_bytes(&entries);
            assert!(unpack(&bytes, ArchiveFormat::TarGz, dir.path(), "pkg").is_err());
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        }
        let mut corrupt =
            tar_bytes(&[("pkg/runtime-manifest.json", b"{}", tar::EntryType::Regular)]);
        let index = corrupt.len() - 8;
        corrupt[index] ^= 1;
        assert!(unpack(&corrupt, ArchiveFormat::TarGz, dir.path(), "pkg").is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
