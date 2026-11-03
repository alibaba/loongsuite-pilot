//! Whole public uninstall entry: global defaults, current/native candidate
//! selection and real Native cleanup. OS/service/network APIs stay private.
use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
enum CandidateMode {
    Current,
    Cli,
    Environment,
    NonNative,
}
struct Entry {
    f: Fixture,
    cache: PathBuf,
    installed: PathBuf,
    settings: PathBuf,
    archive: PathBuf,
    before_config: Vec<u8>,
    before_settings: Vec<u8>,
}
fn copy_tree(source: &Path, target: &Path) {
    for entry in walkdir::WalkDir::new(source) {
        let entry = entry.unwrap();
        assert!(!entry.file_type().is_symlink());
        let dest = target.join(entry.path().strip_prefix(source).unwrap());
        if entry.file_type().is_dir() {
            fs::create_dir_all(dest).unwrap();
        } else {
            fs::copy(entry.path(), dest).unwrap();
        }
    }
}
fn write_archive(source: &Path, path: &Path) {
    #[cfg(unix)]
    {
        let encoder = flate2::write::GzEncoder::new(
            fs::File::create(path).unwrap(),
            flate2::Compression::none(),
        );
        let mut archive = tar::Builder::new(encoder);
        archive.append_dir_all("bootstrap", source).unwrap();
        archive.into_inner().unwrap().finish().unwrap();
    }
    #[cfg(windows)]
    {
        use std::io::Write;
        let mut writer = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for entry in walkdir::WalkDir::new(source) {
            let entry = entry.unwrap();
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(source)
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/");
            writer
                .start_file(format!("bootstrap/{relative}"), options)
                .unwrap();
            writer.write_all(&fs::read(entry.path()).unwrap()).unwrap();
        }
        writer.finish().unwrap();
    }
}
impl Entry {
    fn new(mode: CandidateMode) -> Self {
        let f = Fixture::new();
        f.package_with(&[(
            "agents.d/cursor.json",
            include_str!("../../agents.d/cursor.json"),
        )]);
        let cache = f.root.path().join("cache");
        let installed = cache.join("versions/1.2.0_installed");
        copy_tree(&f.candidate, &installed);
        fs::write(cache.join("current"), "1.2.0_installed\n").unwrap();
        let explicit = mode != CandidateMode::Current;
        let settings = f.root.path().join(if explicit {
            ".cursor/explicit-hooks.json"
        } else {
            ".cursor/hooks.json"
        });
        if explicit {
            let resource = f.candidate.join("agents.d/cursor.json");
            let mut value: Value = serde_json::from_slice(&fs::read(&resource).unwrap()).unwrap();
            value["hook"]["settingsPath"] = json!(settings);
            fs::write(&resource, value.to_string()).unwrap();
            let path = f.candidate.join("runtime-manifest.json");
            let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            let entry = manifest["resources"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|entry| entry["path"] == "agents.d/cursor.json")
                .unwrap();
            entry["sha256"] =
                json!(loongsuite_pilot::utils::runtime_paths::sha256_file(&resource).unwrap());
            fs::write(path, manifest.to_string()).unwrap();
        }
        let hook = f.data.join(if cfg!(windows) {
            "hooks/cursor-loongsuite-pilot-hook.ps1"
        } else {
            "hooks/cursor-loongsuite-pilot-hook.sh"
        });
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(&hook, "keep runtime until external cleanup completes").unwrap();
        let command = if cfg!(windows) {
            format!(
                "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"",
                hook.display()
            )
        } else {
            loongsuite_pilot::hooks::quote_claude_hook_path(&hook.to_string_lossy())
        };
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(
            &settings,
            json!({"private":"user-fields","hooks":{"afterAgentResponse":[
                {"command":command},{"command":"keep-third-party","timeout":17}
            ]}})
            .to_string(),
        )
        .unwrap();
        fs::write(f.data.join("config.json"),"\u{feff}{\"private\":\"preserve-config\",\"cmsLicenseKey\":\"synthetic-fixture-secret\"}\n").unwrap();
        let foreign = f
            .root
            .path()
            .join(".loongsuite-pilot/versions/other-install");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("asset"), "other-install exact bytes").unwrap();
        let archive = f.root.path().join(if cfg!(windows) {
            "explicit native 用户.zip"
        } else {
            "explicit native 用户.tar.gz"
        });
        if explicit {
            if mode == CandidateMode::NonNative {
                let legacy = f.root.path().join("legacy-only-package");
                fs::create_dir_all(legacy.join("dist")).unwrap();
                fs::write(legacy.join("package.json"), "{\"name\":\"legacy-js-only\"}").unwrap();
                fs::write(legacy.join("dist/index.js"), "must never execute legacy JS").unwrap();
                write_archive(&legacy, &archive);
            } else {
                write_archive(&f.candidate, &archive);
            }
        }
        let before_config = fs::read(f.data.join("config.json")).unwrap();
        let before_settings = fs::read(&settings).unwrap();
        Self {
            f,
            cache,
            installed,
            settings,
            archive,
            before_config,
            before_settings,
        }
    }
    fn url(&self) -> String {
        format!("file://{}", self.archive.display())
    }
    fn assert_success(&self) {
        assert!(
            !self.installed.exists(),
            "actual installed cache assets must be removed"
        );
        for relative in [
            "versions", "bin", "package", "current", "previous", "node-bin",
        ] {
            assert!(
                !self.cache.join(relative).exists(),
                "managed cache entry survived: {relative}"
            );
        }
        assert_eq!(
            fs::read(self.f.data.join("config.json")).unwrap(),
            self.before_config
        );
        let value: Value = serde_json::from_slice(&fs::read(&self.settings).unwrap()).unwrap();
        assert_eq!(
            value,
            json!({"private":"user-fields","hooks":{"afterAgentResponse":[{"command":"keep-third-party","timeout":17}]}})
        );
        assert_eq!(
            fs::read(
                self.f
                    .root
                    .path()
                    .join(".loongsuite-pilot/versions/other-install/asset")
            )
            .unwrap(),
            b"other-install exact bytes"
        );
        if cfg!(windows) {
            assert!(!self.f.data.join("hooks").exists());
        }
    }
    fn assert_refusal(&self) {
        assert!(self.installed.join("runtime-manifest.json").is_file());
        assert_eq!(
            fs::read(self.cache.join("current")).unwrap(),
            b"1.2.0_installed\n"
        );
        assert_eq!(
            fs::read(self.f.data.join("config.json")).unwrap(),
            self.before_config
        );
        assert_eq!(fs::read(&self.settings).unwrap(), self.before_settings);
        assert!(self.f.data.join("hooks").is_dir());
        assert!(!self.f.root.path().join("stop-marker").exists());
    }
}
#[cfg(unix)]
fn shell(entry: &Entry, mode: CandidateMode) -> Output {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let bin = entry.f.root.path().join("private-bin");
    fs::create_dir(&bin).unwrap();
    for name in [
        "uname", "id", "whoami", "date", "mkdir", "cat", "dirname", "basename", "readlink", "grep",
        "sed", "awk", "find", "tr", "head", "tail", "cut", "wc", "stat", "chmod", "mv", "cp",
        "xargs", "which", "sleep", "getconf", "sort", "tee", "mktemp", "touch", "locale", "ls",
        "ln", "env", "df", "du", "bash", "sh", "tar", "gzip",
    ] {
        let source = [
            Path::new("/usr/bin").join(name),
            Path::new("/bin").join(name),
        ]
        .into_iter()
        .find(|p| p.is_file());
        if let Some(source) = source {
            symlink(source, bin.join(name)).unwrap();
        }
    }
    let rm = r#"#!/bin/bash
args=()
files=0
for item in "$@"; do
 case "$item" in
  -*) args+=("$item");;
  "$HOME"/*) args+=("$item"); files=1;;
  /usr/local/bin/loongsuite-pilot|/usr/bin/loongsuite-pilot) ;;
  *) printf 'refused non-private deletion\n' >&2; exit 88;;
 esac
done
if test "$files" -eq 0; then exit 0; fi
exec /bin/rm "${args[@]}"
"#;
    for (name, body) in [
        ("rm", rm),
        (
            "loongsuite-pilot",
            "#!/bin/bash\nif test \"$1\" != stop; then exit 88; fi\nprintf stopped > \"$HOME/stop-marker\"\n",
        ),
        ("ps", "#!/bin/bash\nexit 0\n"),
    ] {
        fs::write(bin.join(name), body).unwrap();
        fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o755)).unwrap();
    }
    // curl/wget/Node/Python are deliberately absent from this entire process PATH.
    for name in ["curl", "wget", "node", "python", "python3"] {
        assert!(!bin.join(name).exists());
    }
    let mut cmd = entry.f.command(Path::new("/bin/bash"));
    cmd.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("deploy/installer-opensource.sh"))
        .args(["uninstall", "--data-dir"])
        .arg(&entry.f.data)
        .args(["--lang", "en"])
        .env("PATH", &bin)
        .env("TMPDIR", entry.f.root.path());
    if matches!(mode, CandidateMode::Cli | CandidateMode::NonNative) {
        cmd.arg("--package-url").arg(entry.url());
    }
    if mode == CandidateMode::Environment {
        cmd.env("LOONGSUITE_PILOT_PACKAGE_URL", entry.url());
    }
    bounded_for(cmd, Duration::from_secs(15))
}
#[cfg(unix)]
#[test]
fn uninstall_default_url_whole_public_shell_uses_current_without_network_or_external_runtimes() {
    let entry = Entry::new(CandidateMode::Current);
    success(&shell(&entry, CandidateMode::Current));
    entry.assert_success();
    assert!(entry.f.root.path().join("stop-marker").is_file());
}
#[cfg(unix)]
#[test]
fn uninstall_explicit_candidate_whole_public_shell_keeps_cli_and_environment_bootstrap_and_rejects_legacy(
) {
    for mode in [
        CandidateMode::Cli,
        CandidateMode::Environment,
        CandidateMode::NonNative,
    ] {
        let entry = Entry::new(mode);
        let out = shell(&entry, mode);
        if mode == CandidateMode::NonNative {
            assert!(!out.status.success());
            entry.assert_refusal();
        } else {
            success(&out);
            entry.assert_success();
            assert!(entry.f.root.path().join("stop-marker").is_file());
        }
    }
}

#[cfg(windows)]
fn shells() -> Vec<PathBuf> {
    let legacy = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    assert!(legacy.is_file());
    let pwsh = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|p| p.join("pwsh.exe"))
        .find(|p| p.is_file())
        .expect("both shells required; no skip");
    vec![legacy, pwsh]
}
#[cfg(windows)]
fn powershell(entry: &Entry, shell: &Path, constrained: bool, mode: CandidateMode) -> Output {
    // The product's service command remains in its real call path, but its
    // operating-system action is an isolated callback, never a live daemon.
    let private_service = entry
        .f
        .root
        .path()
        .join(".local/bin/loongsuite-pilot-service.ps1");
    fs::create_dir_all(private_service.parent().unwrap()).unwrap();
    fs::write(
        &private_service,
        "# private service boundary; must never execute",
    )
    .unwrap();
    let wrapper = entry.f.root.path().join("whole-public-uninstall.ps1");
    let mut body = String::from(
        "\u{feff}$ErrorActionPreference='Stop'\n$env:PSModulePath=$PSHOME+'\\Modules'\n",
    );
    for module in ["Utility", "Management", "Archive"] {
        body.push_str(&format!("Import-Module -Name ($PSHOME+'\\Modules\\Microsoft.PowerShell.{module}\\Microsoft.PowerShell.{module}.psd1') -ErrorAction Stop\n"));
    }
    body.push_str(r#"
# Use the actual compiler for both whole shipped files, without executing them.
foreach ($path in @($env:TEST_INSTALLER,$env:TEST_SERVICE)) {
 $tokens=$null; $parseErrors=$null
 $null=[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$parseErrors)
 if ($parseErrors.Count -ne 0) { throw 'real whole-file PowerShell compiler rejected shipped source' }
}
function global:Invoke-WebRequest {
 param($Uri,$OutFile,[switch]$UseBasicParsing,$TimeoutSec)
 Set-Content -LiteralPath $env:TEST_NETWORK_MARKER -Value forbidden -Encoding UTF8
 throw 'whole uninstall must not use an implicit network package'
}
function global:Get-ScheduledTask {
 param($TaskName,$TaskPath,$ErrorAction)
 Add-Content -LiteralPath $env:TEST_TASK_MARKER -Value queried -Encoding UTF8
 return $null
}
function global:powershell.exe {
 if ($args.Count -lt 2 -or $args[-1] -ne 'stop' -or -not ($args -contains '-File')) { throw 'unexpected service command' }
 $index=[array]::IndexOf($args,'-File')
 if ($args[$index+1] -ne (Join-Path $env:USERPROFILE '.local\bin\loongsuite-pilot-service.ps1')) { throw 'service command escaped private path' }
 Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'stop-marker') -Value stopped -Encoding UTF8
 $global:LASTEXITCODE=0
}
function global:Unregister-ScheduledTask { throw 'test must never mutate real scheduled tasks' }
function global:Stop-ScheduledTask { throw 'test must never stop real scheduled tasks' }
function global:Stop-Process { throw 'test must never stop an actual process' }
"#);
    if constrained {
        body.push_str("$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'\nif ($ExecutionContext.SessionState.LanguageMode -ne 'ConstrainedLanguage') { throw 'product must be constrained' }\n$blocked=$false\ntry {$null=[System.IO.File]::Exists('WHOLE_UNINSTALL_CLM_CANARY')} catch {if ($_.FullyQualifiedErrorId -notmatch 'ConstrainedLanguage') {throw};$blocked=$true}\nif (-not $blocked) {throw 'forbidden static IO unexpectedly allowed'}\n");
    }
    body.push_str("$global:LASTEXITCODE=0\n");
    body.push_str(if matches!(mode,CandidateMode::Cli|CandidateMode::NonNative){
        "& $env:TEST_INSTALLER uninstall -DataDir $env:TEST_DATA -Lang en -PackageUrl $env:TEST_PACKAGE\n"
    }else{
        "& $env:TEST_INSTALLER uninstall -DataDir $env:TEST_DATA -Lang en\n"
    });
    body.push_str("$code=$global:LASTEXITCODE\nexit $code\n");
    fs::write(&wrapper, body).unwrap();
    let mut cmd = entry.f.command(shell);
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ])
    .arg(&wrapper)
    .env(
        "TEST_INSTALLER",
        Path::new(env!("CARGO_MANIFEST_DIR")).join("deploy/installer-opensource.ps1"),
    )
    .env(
        "TEST_SERVICE",
        Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/loongsuite-pilot.ps1"),
    )
    .env("TEST_DATA", &entry.f.data)
    .env("TEST_PACKAGE", entry.url())
    .env(
        "TEST_NETWORK_MARKER",
        entry.f.root.path().join("network-marker"),
    )
    .env("TEST_TASK_MARKER", entry.f.root.path().join("task-marker"))
    .env("TEMP", entry.f.root.path())
    .env("TMP", entry.f.root.path())
    .env("PATH", shell.parent().unwrap())
    .env("USERNAME", "pilot-private-fixture")
    .env("USERDOMAIN", "TEST");
    if mode == CandidateMode::Environment {
        cmd.env("LOONGSUITE_PILOT_PACKAGE_URL", entry.url());
    }
    bounded_for(cmd, Duration::from_secs(15))
}
#[cfg(windows)]
#[test]
fn uninstall_default_url_and_explicit_candidates_use_the_whole_public_powershell_entry_in_both_shells_and_clm(
) {
    for shell in shells() {
        for constrained in [false, true] {
            for mode in [
                CandidateMode::Current,
                CandidateMode::Cli,
                CandidateMode::Environment,
                CandidateMode::NonNative,
            ] {
                let entry = Entry::new(mode);
                let out = powershell(&entry, &shell, constrained, mode);
                assert!(
                    !entry.f.root.path().join("network-marker").exists(),
                    "implicit network path was used"
                );
                if mode == CandidateMode::NonNative {
                    assert!(!out.status.success());
                    entry.assert_refusal();
                    assert!(!entry.f.root.path().join("task-marker").exists());
                } else {
                    success(&out);
                    entry.assert_success();
                    assert!(
                        entry.f.root.path().join("stop-marker").is_file(),
                        "whole public stop branch must execute its isolated callback"
                    );
                    assert!(
                        entry.f.root.path().join("task-marker").is_file(),
                        "actual scheduled-task removal branch must be reached"
                    );
                }
            }
        }
    }
}
