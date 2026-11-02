//! Remove the reserved v1 CLI shadow only after native service publication.
//! Exact source SHA-256 provenance is in fixtures/legacy_windows_cli_provenance.json.
//! Unknown/modified scripts and links remain untouched. This does not execute Node.

use anyhow::{ensure, Result};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;

use crate::utils::runtime_paths::runtime_metadata;

const MAX_LEGACY_BYTES: usize = 1024 * 1024;
const OFFICIAL_V1_HASHES: &[&str] = &[
    "00cd262262c9a10cd57381e2b9bafc4be23f412f0955355f972017ac12d812ce",
    "02505a4a1c2ea9239ff49d796ba2867d0d3c03a3ea491e21ff56ea7847021819",
    "041641ab275c8709d999317caa30889f8b41678be479d879c0585eaa234ad3de",
    "0b1113398cbbd4a73f22569f78e9fa4c78633f65166e2b29eabc3ec4436a645a",
    "0bbec447e670e894335e4ef5fa31c499009e409f827e1486740a498c110cc077",
    "0c693f1a77cbc17024a6758d3ce4b96e7658e49bb362a3c440f628acc2b3bdda",
    "0ece0bbf51997a8460ee69a74a6c094de98503817a929c70c44e7afda7738a4f",
    "0fa12616cab8995feacfd3b6624c95da034c8c5efc5c406f1334f39cbbf5661d",
    "0fe3d4d3852432f0f182d8bdd8febf022901fe35232390088df22ada669ea752",
    "1242c213afbbf95d13f6b3312f95003a67b8be45ce21b2e59c6c461983e2e0f8",
    "1490ddbd56d10d1801c46bf4f48564d1c71ecd82f320727c7388fddc66372cfa",
    "15b92a5c656e8bb17b1bb91abe746f2ce0c562155b5eef170ac479454cf528e5",
    "15ea7522c3273f4c40ff78afeea14f47c7f10be073cc21a50b7c9fd875905a41",
    "1df93a812b1a96c884ccd657e1b45a1b4f98ce91f8be58febcfce03baf05f9e6",
    "25a7771b1df973c5fc61541e1ffa99c3b7f65ae70320f169994aa5edf644258b",
    "297d550447e2e01b375aa4a0dd4656c1abb6a16f224abedf1b02786d6ce5a649",
    "2b46dd7b905de1c9665288d1fe1c16314d31adf48d4af40d189a28b1defcbf41",
    "2c347326531a6c9421f86a45d6f27fcdc600024d35006e1b4f43b8e201ebf42b",
    "3048125e00d17a182fbedec6e4dd4e1aba6fb6b8b4e8e3f51d30932558752ed6",
    "337be504d3b266cc0899444dded683ed64608c067d56ef19c9af6493fd15dae3",
    "338961384614724990b14b3f4e8c6ee4939df87ed421f007a639bdfb4e702a22",
    "33dda1280e2e84506cbec372e487a6da9e92719eee66e339a85e45cb1f7f53fc",
    "3a0e0e6b262107debe6f09a1d605c0bbe4eb964a5e33fba25adcc119069b8709",
    "3ad7c9a0aa30f8695b41b9ab29fc3a363059d8c92348b994e687274de7667b35",
    "3cab484480ab03c16258a69010eb897aedbb3fd106dbc6422398153cc0af72a5",
    "42ed300566b7aee3df252f2b8a4713030d1207db4f3034bde3edaa5efa413f4c",
    "44de46a8a235a61d38fd4abb35fdcfa63c3b30872c5b210f4a0046d338e3bc2b",
    "469648de54d155ec1366a897d38ed85ce36169d90d8d6a8a2a8799ec95180433",
    "484920f80f5e56e29c717ce8f0c4298daf593459538d88851de496f64b2e8002",
    "48b53234e24f7ad2e9d37b43123e23aad8df1737af2d56ddedfdf7366ee19b14",
    "4968110296443b927e0f8358e7f2889855a9845f9232fef8a14710a4f6ab09b7",
    "4a5365bef1950e32d0ec4306646783de47af88072d69dad7913ef577e71c0929",
    "4a863a4db65bc54c470998bb7a3e299323e2f21b16b7006747c5c4ae23cd15d1",
    "4ccb051f92513c83b5400c0c88da9a7b7ecc29015810163e9a2f67d01f8d20d7",
    "4fba4e559440d5102c73408f8ba194f04e1ccd3b25951e9599b3f661f0a63552",
    "5b228ba8919b8b88d07ef69558a0873bdfaf1792d42daeb8f9c030a533c375b7",
    "5f2539816e224661ea696b74d868b166e66801e5212c786c06481c546f6cd035",
    "634e2960aeb5bc2e69f85b83f4690043d0204691bbbfac4720d6d0a42cf0e629",
    "656b4ae8b40ab800918aa1c0516f2ceec24b8f9718d549655b8f7442c5e23087",
    "685330130f1ef5de59864d61577d00b12c8e877b1dadd34965ac7ae18f08b47a",
    "68d5d5649af8cc8407c028457e5a7cecc37eb07a00f01eae7d1846a3677b61b4",
    "6b79c96500717ba4c76cbf5895dbd8b305c2572a3a02ed8d0e84f9243145e04c",
    "700d2f8fb8c7ae81e0f8fc802a222298e769dda0829064212ab1e967350c2c2d",
    "71e79bd5b69c7ceee5ad5f5167362fc9fce7d9d0758cdc6d5ed7f8b8efb036b9",
    "7323216c71a86bc0a996189d9bdf32ea89b88bfe6ccf3ab84fb6c7d59ca3cc3b",
    "7a05070cbbadcc30fb3686e6fd25b532915ccaa3c8351f53adbcbf9872cd47f8",
    "7db6a6c63e639e0f167063ba7ed5d66f1c92c03c1a55b1f480ef01d904c17597",
    "7dd0982378fe13ff033268e7809fcfff3a56699ab2e4987537126f3ee0652ed7",
    "856bde65bad2ee97ac61e58e05c7ca155c5c081079f5ecfa60b1a022f396e13d",
    "8782673bb4b171bd00e7f7c79a239f3bd03a16a5a9869634ef2912b63c032969",
    "8828736465988034b401b057128ee91b55dbf24b89978f1153f1707e7cec1af0",
    "8b640151b934cbffd1603187d102ea265527085ade28c9e947182bf735eb9693",
    "8ba103820ccbe57e7fcdbc5fa630ad90b01e0eb151d4c5abe81eaab555d7b80c",
    "91742e96740c9fa9035beb1d2797c6d31f3caec9578d1d119dda90784d5a87ef",
    "935a9ba51e012cad2e95db8cda50902f7d5e1bc1bfacf56fc5cf33cabe28622d",
    "93866484ef73a48258e79473bed3b1f267872220e61df970acc33cd7c6e6b7bd",
    "95a183fd264fdca0e3741cb6abadf1bd999c662bed8bd52b4e8c10079c100d17",
    "98081c73227e7b0d41db58d737381b84d94652fad124ae6161b7f83c81f8e6eb",
    "a05024bc2c8573e9998b5726b53fd4a1b397fd2e34673f2b3cc2e41655952343",
    "a15ddf74b70bebf1b22fa7930ee11258fd26505ae7c331a2383a67c7316185b5",
    "a7ef0192e147d13991fc05b8abe588177e22bbb843ee1146aae40b2de9831074",
    "abd5bca30dc693f19ae98c59bc081523ff7255f4808759015c7698777a5e8ae9",
    "ae006065323be277722cbc70d675612256a765345319bbe6a68018d6d71e52e8",
    "aee6cb793d246d91d55bbf9fa9cbeac8be5d98c04c5c7e0bc4b5bab40dd7cce5",
    "b043d2088c7018181ca227661b5562ee4789d5bea47e44d49a1d17c7b808b0a4",
    "b1bf932cc1f1cdae740662a50d04651475b27efcce445aaa14630eb029dde2ef",
    "b340ff83a720e79321e937238aa32e4989badf029625e572fd9dc3f991230822",
    "b55e9e93926746cba53c57e8b4146c430c72c5b7891ac28633cc985cd73968b0",
    "b704b22926ec7f19a21460c6dcdf4cab1609de58f076184e33df335576163b57",
    "bd3dd0bec5c286685df2a0e33736806318de5a4c0b64cb2bb3559480c1eae4f4",
    "c1ef58816bce54d15b3c558f6f549921357ef5d783eee6af230e4c105652e426",
    "c336a9999cf27ee93fc21c0ea09a02c352f8b9e38db611cdcd948978b23f0694",
    "c410a6daf4e3f1fdce94e6fdd1d851e99e71d776d55e6b94bd5b735454609e2b",
    "c6296fe6bfb534ea32ce4bb6ca5a7bf4d8f56fd8a14015c138289842ca033105",
    "c6672dd877c0e9964643aae74123054670e3cba64955843147501e0e268dbe58",
    "c7ca178aec978a823d7b3144928c1635400d1eda3f9861a3f44daca8ddf7e7f6",
    "cc11147a8858ae132bac4d8ebbc67e5662b72dc2a5d20167b41c50dc0c0d5b88",
    "cd1084951577c7db25236aaf3d803a141d9aa8cf4de1303dc77709553e95aa66",
    "cfe9539cfd1209a246848fe58664366a96b31eaad7d211872a67a3c93751ab2c",
    "d2b21cadf27d860843bfac57b99ba52ec816c471590e92d9565eacbf454b1120",
    "d3aad5ab7dacfc1f6b426c2ae0c95fb01a786c5479775da5edf71f9e5414c0f7",
    "d82d77befa082b5e938eb7a312c375a91d37c44077e8d287f8f70d983d872162",
    "d9145b6946e0a698bb78a0a8f476a11fd29ea086b41e659fb173cc96d5a14976",
    "db4ee840a0f9f01a8cb97da9038140438c623f13da1b4dd3a93e9ad801d12ae5",
    "dba32774efda363a1a8db5fab34199e43ee59095b41727d96a5d25177f0c22bc",
    "dfb3281288df2065710af9942ccfdd4ef8f7d32fa4619c55d83c9c60b1873830",
    "e53359f9fb8baf84ce6d8ca2d1c796595292b2b8fb1b902fe08587804984e9a8",
    "e7464c2fcc4c934cb4f5fa5d50d328d945a263504ae324bcfb010afa9cfbce3d",
    "eb8d153559ca08bacc34cc949fdc8a28c1ee6bc7b8367ed5960c2c0bfce41790",
    "ee1acdf69942fe67b6a556c58891a212f4a0297392684324129fb7860e014654",
    "ef49f2f27924716cdbf2b0f7e15794cb63fc2dd15af6480573563ac5140aceef",
    "f4ea7108c255a81ae179e4c2a17894f28b8a6a106ac1c196c91bd3cecd952bc8",
    "f5c005e0f97a58517c1f954f92e7eeffc640bc05c8f9931bb1389bb13b8e0f9b",
    "f60142da32ee55dd1a2b955f938a277efe6b8faabae17fa6d4c16cbbf54f27ce",
    "f8e44d8c705af741635f7012aa4a1237ce80aed1f813cf712c902ef3467b8314",
    "fa47632a34638ceb885c6c3ba96fb291b92ae8d24a8c5e3fc73f6be48ef14126",
];

fn candidate_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(meta) if meta.file_type().is_symlink() => return Ok(None),
        Ok(_) => {}
    }
    // runtime_metadata additionally rejects Windows reparse points.
    let metadata = match runtime_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(None),
    };
    if !metadata.is_file() || metadata.len() > MAX_LEGACY_BYTES as u64 {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() {
        return Ok(None);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.file_attributes() & 0x400 != 0 {
            return Ok(None);
        }
    }
    file.take(MAX_LEGACY_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_LEGACY_BYTES {
        return Ok(None);
    }
    Ok(Some(bytes))
}

/// Caller holds update.lock and the service-directory lock. Only invoke after
/// the service/layout/.cmd transaction has committed, including native installs.
/// A failed cleanup is retryable on the next healthy, already-current check.
pub(crate) fn cleanup(destination: &Path, cache: &Path, data: &Path) -> Result<bool> {
    if destination.file_name().and_then(|value| value.to_str())
        != Some("loongsuite-pilot-service.ps1")
    {
        return Ok(false);
    }
    let parent = destination.parent().expect("file name has parent");
    ensure!(runtime_metadata(parent)?.is_dir(), "旧CLI目录不是普通目录");
    let layout = parent.join("loongsuite-pilot-layout.json");
    // check_service_owner alone deliberately allows missing legacy layouts.
    // Cleanup requires an explicitly published native ownership record.
    if !layout.try_exists()? {
        return Ok(false);
    }
    super::native_install::check_service_owner(destination, cache, data)?;
    ensure!(
        runtime_metadata(destination)?.is_file(),
        "原生服务入口尚未发布"
    );
    ensure!(
        runtime_metadata(&parent.join("loongsuite-pilot.cmd"))?.is_file(),
        "原生命令入口尚未发布"
    );
    let legacy = parent.join("loongsuite-pilot.ps1");
    let Some(bytes) = candidate_bytes(&legacy)? else {
        return Ok(false);
    };
    let hash = hex::encode(Sha256::digest(&bytes));
    if !OFFICIAL_V1_HASHES.contains(&hash.as_str()) {
        return Ok(false);
    }
    // Detect edits/replacement during ownership inspection; never force-remove.
    let Some(current) = candidate_bytes(&legacy)? else {
        return Ok(false);
    };
    ensure!(current == bytes, "旧CLI在归属检查期间被修改；保留原文件");
    ensure!(
        !runtime_metadata(&legacy)?.permissions().readonly(),
        "旧CLI只读；保留原文件"
    );
    fs::remove_file(&legacy)?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::ActivationTransaction;
    use serde_json::json;
    use std::path::PathBuf;

    fn official() -> Vec<u8> {
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(
            &include_bytes!("../../tests/fixtures/updater/official-v1-windows-cli.ps1.gz")[..],
        )
        .read_to_end(&mut decoded)
        .unwrap();
        decoded
    }
    fn published(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let cache = root.join("cache");
        let data = root.join("data");
        let package = root.join("package");
        let bin = root.join("bin");
        for dir in [&cache, &data, &package.join("scripts"), &bin] {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(
            package.join("scripts/loongsuite-pilot.ps1"),
            include_bytes!("../../scripts/loongsuite-pilot.ps1"),
        )
        .unwrap();
        let service = bin.join("loongsuite-pilot-service.ps1");
        let files = super::super::native_install::service_files(
            &package,
            &service,
            &cache,
            &data,
            &data.join("config.json"),
            true,
        )
        .unwrap();
        let targets = super::super::native_install::activation_targets(
            &cache,
            &service,
            &data.join("config.json"),
        );
        let mut transaction = ActivationTransaction::begin(&cache, targets).unwrap();
        transaction.write("current", b"v2\n", 0o600).unwrap();
        for (key, (bytes, mode)) in files {
            transaction.write(&key, &bytes, mode).unwrap();
        }
        transaction.commit().unwrap();
        (service, cache, data)
    }
    #[test]
    fn committed_native_publication_removes_exact_official_shadow_and_keeps_bom_cmd_and_pointers() {
        for crlf in [false, true] {
            for bom in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let (service, cache, data) = published(root.path());
                let bin = service.parent().unwrap();
                let lf = String::from_utf8(official())
                    .unwrap()
                    .trim_start_matches('\u{feff}')
                    .replace("\r\n", "\n");
                let raw = if crlf { lf.replace('\n', "\r\n") } else { lf };
                let mut raw = raw.into_bytes();
                if bom {
                    raw.splice(0..0, [0xef, 0xbb, 0xbf]);
                }
                let legacy = bin.join("loongsuite-pilot.ps1");
                fs::write(&legacy, raw).unwrap();
                // Before removal PowerShell's exact .ps1 match shadows the .cmd.
                assert!(legacy.is_file());
                assert!(bin.join("loongsuite-pilot.cmd").is_file());
                let original = fs::read(&service).unwrap();
                assert!(cleanup(&service, &cache, &data).unwrap());
                assert!(!legacy.exists());
                assert_eq!(fs::read(&service).unwrap(), original);
                assert!(original.starts_with(b"\xef\xbb\xbf"));
                let cmd = fs::read_to_string(bin.join("loongsuite-pilot.cmd")).unwrap();
                assert!(cmd.contains("-File \"%~dp0loongsuite-pilot-service.ps1\" %*"));
                assert_eq!(fs::read(cache.join("current")).unwrap(), b"v2\n");
                assert!(!cleanup(&service, &cache, &data).unwrap());
            }
        }
    }
    #[test]
    fn foreign_modified_oversize_directory_and_missing_layout_are_preserved() {
        for mode in [
            "foreign",
            "modified",
            "oversize",
            "directory",
            "no-layout",
            "wrong-owner",
        ] {
            let root = tempfile::tempdir().unwrap();
            let (service, cache, data) = published(root.path());
            let legacy = service.with_file_name("loongsuite-pilot.ps1");
            let bytes = match mode {
                "modified" => [official(), b"\n# user customization\n".to_vec()].concat(),
                "oversize" => vec![b'x'; MAX_LEGACY_BYTES + 1],
                "no-layout" | "wrong-owner" | "directory" => official(),
                _ => b"Write-Output 'my script'\n".to_vec(),
            };
            if mode == "directory" {
                fs::create_dir(&legacy).unwrap();
            } else {
                fs::write(&legacy, &bytes).unwrap();
            }
            if mode == "no-layout" {
                fs::remove_file(service.with_file_name("loongsuite-pilot-layout.json")).unwrap();
            }
            if mode == "wrong-owner" {
                fs::write(
                    service.with_file_name("loongsuite-pilot-layout.json"),
                    serde_json::to_vec(
                        &json!({"cacheDir":cache,"dataDir":root.path().join("foreign")}),
                    )
                    .unwrap(),
                )
                .unwrap();
            }
            let result = cleanup(&service, &cache, &data);
            if mode == "wrong-owner" {
                assert!(result.is_err());
            } else {
                assert!(!result.unwrap(), "{mode}");
            }
            if mode == "directory" {
                assert!(legacy.is_dir());
            } else {
                assert_eq!(fs::read(&legacy).unwrap(), bytes, "{mode}");
            }
            assert!(service.is_file());
        }
    }
    #[cfg(unix)]
    #[test]
    fn symlink_shadow_never_causes_target_deletion_or_content_reads() {
        let root = tempfile::tempdir().unwrap();
        let (service, cache, data) = published(root.path());
        let foreign = root.path().join("foreign.ps1");
        let bytes = official();
        fs::write(&foreign, &bytes).unwrap();
        let link = service.with_file_name("loongsuite-pilot.ps1");
        std::os::unix::fs::symlink(&foreign, &link).unwrap();
        assert!(!cleanup(&service, &cache, &data).unwrap());
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(foreign).unwrap(), bytes);
    }
    #[test]
    fn rollback_before_native_commit_keeps_legacy_command_and_retry_does_not_touch_other_install() {
        let root = tempfile::tempdir().unwrap();
        let (service, cache, data) = published(root.path());
        let legacy = service.with_file_name("loongsuite-pilot.ps1");
        fs::write(&legacy, official()).unwrap();
        let before = fs::read(&service).unwrap();
        {
            let mut transaction = ActivationTransaction::begin(
                &cache,
                super::super::native_install::service_targets(&service),
            )
            .unwrap();
            transaction
                .write("service", b"not committed", 0o755)
                .unwrap();
            // Installer/updater do not call cleanup while activation can roll back.
            assert!(legacy.is_file());
        }
        assert_eq!(fs::read(&service).unwrap(), before);
        assert!(legacy.is_file());
        let foreign_data = root.path().join("other-install");
        assert!(cleanup(&service, &cache, &foreign_data).is_err());
        assert!(legacy.is_file());
        assert!(cleanup(&service, &cache, &data).unwrap());
    }
    #[test]
    fn readonly_official_shadow_is_reported_and_preserved_without_harming_native_install() {
        let root = tempfile::tempdir().unwrap();
        let (service, cache, data) = published(root.path());
        let legacy = service.with_file_name("loongsuite-pilot.ps1");
        let bytes = official();
        fs::write(&legacy, &bytes).unwrap();
        let original = fs::metadata(&legacy).unwrap().permissions();
        let mut permissions = original.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&legacy, permissions).unwrap();
        assert!(cleanup(&service, &cache, &data).is_err());
        assert_eq!(fs::read(&legacy).unwrap(), bytes);
        fs::set_permissions(&legacy, original).unwrap();
        assert!(service.is_file());
    }
    #[cfg(windows)]
    #[test]
    fn actual_powershell_command_resolution_switches_from_owned_v1_ps1_to_native_cmd() {
        fn resolve(bin: &Path, home: &Path) -> PathBuf {
            let system_root = std::env::var_os("SystemRoot").expect("Windows SystemRoot");
            let shell =
                PathBuf::from(&system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let quoted = bin.to_str().unwrap().replace('\'', "''");
            let command = format!("$env:PATH='{quoted}'; $c=Get-Command loongsuite-pilot -CommandType Application,ExternalScript -ErrorAction Stop; [Console]::Write($c.Path)");
            let output = std::process::Command::new(shell)
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    &command,
                ])
                .env_clear()
                .env("SystemRoot", system_root)
                .env("PATHEXT", ".COM;.EXE;.BAT;.CMD")
                .env("HOME", home)
                .env("USERPROFILE", home)
                .env("APPDATA", home.join("AppData/Roaming"))
                .env("LOCALAPPDATA", home.join("AppData/Local"))
                .env("TEMP", home)
                .env("TMP", home)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
        }
        let root = tempfile::tempdir().unwrap();
        let (service, cache, data) = published(root.path());
        let bin = service.parent().unwrap();
        let legacy = bin.join("loongsuite-pilot.ps1");
        fs::write(&legacy, official()).unwrap();
        assert_eq!(resolve(bin, root.path()), legacy);
        assert!(cleanup(&service, &cache, &data).unwrap());
        assert_eq!(resolve(bin, root.path()), bin.join("loongsuite-pilot.cmd"));
        fs::write(&legacy, b"Write-Output 'user customization'\n").unwrap();
        assert!(!cleanup(&service, &cache, &data).unwrap());
        assert_eq!(resolve(bin, root.path()), legacy);
    }
}
