//! Native development-policy counterparts of the original PowerShell source guards.
//! These are source-policy tests, not Windows execution. Runtime UTF8/CLM acceptance
//! remains in hooks_native, installer_native and windows_services.
use regex::Regex;
use std::{collections::BTreeSet, fs, path::PathBuf, process::Command};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned()
}
fn tracked() -> Vec<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root())
        .args(["ls-files", "--", "*.ps1"])
        .output()
        .unwrap();
    assert!(out.status.success());
    String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}
fn source(path: &str) -> String {
    fs::read_to_string(root().join(path)).unwrap()
}
fn lines(text: &str) -> Vec<(usize, &str)> {
    text.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim_start().starts_with('#'))
        .map(|(n, line)| (n + 1, line))
        .collect()
}
fn code(text: &str) -> String {
    lines(text)
        .iter()
        .map(|(_, l)| *l)
        .collect::<Vec<_>>()
        .join("\n")
}
fn rx(s: &str) -> Regex {
    Regex::new(s).unwrap()
}

fn json_sites(text: &str) -> Vec<(usize, String)> {
    let rows = lines(text);
    let declarations = rx(r#"\$(?:script:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^=].*\.jsonl?["']"#);
    let vars = rows
        .iter()
        .filter_map(|(_, l)| declarations.captures(l).map(|c| c[1].to_owned()))
        .collect::<BTreeSet<_>>();
    let vars = vars
        .iter()
        .map(|v| rx(&format!(r"\$(?:script:)?{}\b", regex::escape(v))))
        .collect::<Vec<_>>();
    let read = rx(r"\bGet-Content\b");
    let from = rx(r"\bConvertFrom-Json\b");
    let to = rx(r"\bConvertTo-Json\b");
    let write = rx(r"\b(?:Set-Content|Add-Content|Out-File)\b");
    let touch = rx(r"\b(?:Get-Content|Set-Content|Add-Content|Out-File)\b");
    rows.into_iter()
        .filter(|(_, line)| {
            (read.is_match(line) && from.is_match(line))
                || (to.is_match(line) && write.is_match(line))
                || (touch.is_match(line) && vars.iter().any(|v| v.is_match(line)))
        })
        .map(|(n, l)| (n, l.to_owned()))
        .collect()
}
fn parse_reads(text: &str) -> Vec<(usize, String)> {
    let parse = rx(r"\bJSON\.parse\b");
    let read = rx(r"\breadFileSync\b");
    lines(text)
        .into_iter()
        .filter(|(_, l)| parse.is_match(l) && read.is_match(l))
        .map(|(n, l)| (n, l.to_owned()))
        .collect()
}
fn piped_json(text: &str) -> Vec<(usize, String)> {
    let rows = lines(text);
    let declare = rx(r"\$(?:script:)?([A-Za-z_][A-Za-z0-9_]*)\s*=.*\|\s*ConvertTo-Json\b");
    let vars = rows
        .iter()
        .filter_map(|(_, l)| declare.captures(l).map(|c| c[1].to_owned()))
        .collect::<BTreeSet<_>>();
    let vars = vars
        .iter()
        .map(|v| rx(&format!(r"\$(?:script:)?{}\s*\|", regex::escape(v))))
        .collect::<Vec<_>>();
    let pipe = rx(r"\|\s*&\s*\$(?:script:)?NODE_BIN\b");
    rows.into_iter()
        .filter(|(_, l)| pipe.is_match(l) && vars.iter().any(|v| v.is_match(l)))
        .map(|(n, l)| (n, l.to_owned()))
        .collect()
}

#[test]
fn source_json_l127_l138_every_interchange_site_stays_explicit_utf8_with_no_new_exemptions() {
    let mut total = 0;
    for path in tracked() {
        let sites = json_sites(&source(&path));
        total += sites.len();
        if sites.is_empty() {
            continue;
        }
        let bare = sites
            .into_iter()
            .filter(|(_, line)| !rx(r"-Encoding\s+UTF8\b").is_match(line))
            .collect::<Vec<_>>();
        if path == "deploy/installer-opensource.ps1" {
            assert!(
                !bare.is_empty(),
                "cleaned historical exception must be audited and removed: {path}"
            );
        } else {
            assert!(bare.is_empty(), "{path}: {bare:?}");
        }
    }
    assert!(total >= 6, "original nonvacuity floor must remain: {total}");
}
#[test]
fn source_json_l150_actual_common_handwritten_jsonl_is_seen_without_converter_tokens() {
    let common = source("assets/hooks/shared/common.ps1");
    assert!(!rx(r"\bConvertTo-Json\b").is_match(&common));
    assert!(json_sites(&common)
        .iter()
        .any(|(_, l)| rx(r"\bAdd-Content\b").is_match(l)));
}
#[test]
fn source_json_l160_remaining_embedded_json_reads_strip_only_leading_bom() {
    // The old total>=1 named the CLI's embedded Node span-attr parser. That
    // production entry is now Rust and is exercised by
    // cli_native::native_span_attributes_preserve_types_strings_and_never_launch_a_runtime,
    // including its BOM file and interior U+FEFF. Keep every remaining embedded
    // parser guarded and keep the matcher independently nonvacuous below.
    let bom = rx(r"\.replace\(/\^\\uFEFF/");
    for path in tracked() {
        if path == "deploy/installer-opensource.ps1" {
            continue;
        }
        for (n, l) in parse_reads(&source(&path)) {
            assert!(bom.is_match(&l), "{path}:{n}: {l}");
        }
    }
    let json = "const value = JSON.parse(fs.readFileSync(file, 'utf8'));";
    let safe = r"const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));";
    let toml = "const lines = fs.readFileSync(file, 'utf8').split('\\n');";
    assert_eq!(
        parse_reads(&format!("{json}\n{safe}\n{toml}\n# {json}")),
        vec![(1, json.into()), (2, safe.into())]
    );
    assert!(bom.is_match(safe));
    assert!(!bom.is_match(json));
}
#[test]
fn source_json_l189_l199_pipe_detector_bans_json_to_node_and_retains_original_counterexamples() {
    let sample="    $cfgJson = $cfgArgs | ConvertTo-Json -Compress\n    $cfgJson | & $script:NODE_BIN -e @'";
    assert_eq!(piped_json(sample).len(), 1);
    assert!(piped_json("    $other | & $script:NODE_BIN -e @'").is_empty());
    for path in tracked() {
        assert!(
            piped_json(&source(&path)).is_empty(),
            "{path} still pipes JSON through native ASCII stdin"
        );
    }
}

const ALLOWED: &[&str] = &[
    "[Console]::IsInputRedirected",
    "[Console]::IsOutputRedirected",
    "[Environment]::UserInteractive",
    "[Net.ServicePointManager]::SecurityProtocol",
    "[Net.SecurityProtocolType]::Tls12",
    "[Environment]::SetEnvironmentVariable",
    "[datetime]::MinValue",
    "[TimeSpan]::Zero",
    "[Console]::OutputEncoding",
    "[System.Text.Encoding]::UTF8",
    "[Security.Principal.WindowsIdentity]::GetCurrent",
    "[Security.Principal.WindowsBuiltInRole]::Administrator",
];
fn violations(text: &str) -> Vec<String> {
    let text = code(text);
    let mut result = Vec::new();
    for pattern in [
        r"(?i)\[pscustomobject\]",
        r"\[ordered\]",
        r"\bNew-Object\b",
        r"\bAdd-Type\b",
        r"\bInvoke-Expression\b",
        r"\.PSObject\b",
        r"\bContainsKey\b",
        r"(?m)^\s*(?:class|enum)\s+\w+",
    ] {
        if rx(pattern).is_match(&text) {
            result.push(pattern.to_owned());
        }
    }
    for member in rx(r"\[[A-Za-z_][A-Za-z0-9_.]*\]::[A-Za-z_][A-Za-z0-9_]*").find_iter(&text) {
        if !ALLOWED.contains(&member.as_str()) {
            result.push(member.as_str().to_owned());
        }
    }
    result.sort();
    result.dedup();
    result
}
#[test]
fn source_clm_l106_l115_every_tracked_file_keeps_original_safe_or_explicit_unsafe_ratchet() {
    let files = tracked();
    assert!(files.len() > 10);
    assert!(files.contains(&"scripts/loongsuite-pilot.ps1".to_owned()));
    assert!(
        files
            .iter()
            .filter(|p| p.starts_with("assets/hooks/"))
            .count()
            > 5
    );
    for path in files {
        let found = violations(&source(&path));
        let known = [
            "deploy/installer-opensource.ps1",
            ".specify/extensions/git/scripts/powershell/create-new-feature.ps1",
            ".specify/extensions/git/scripts/powershell/git-common.ps1",
        ]
        .contains(&path.as_str());
        if known {
            assert!(
                !found.is_empty(),
                "cleaned original unsafe exception requires explicit audit: {path}"
            );
        } else {
            assert!(found.is_empty(), "{path}: {found:?}");
        }
    }
}
#[test]
fn source_clm_l135_hook_extension_guards_keep_the_clm_safe_match_operator() {
    for path in tracked().iter().filter(|p| p.starts_with("assets/hooks/")) {
        let text = code(&source(path));
        if !rx(r"function Convert-NodePath").is_match(&text) {
            continue;
        }
        assert!(!text.contains("HasExtension"), "{path}");
        assert!(text.contains("-match '\\.[^\\\\/\\.]+$'"), "{path}");
    }
}

#[test]
fn source_clm_l153_public_confirm_keeps_credentials_out_of_environment_methods() {
    let installer = code(&source("deploy/installer-opensource.ps1"));
    let confirm = installer
        .split_once("function Confirm-ConfigOverwrite {")
        .unwrap()
        .1
        .split_once("function Write-Config {")
        .unwrap()
        .0;
    assert!(!confirm.contains("LP_SLS_API_KEY"));
    assert!(!rx(r"\[Environment\]::GetEnvironmentVariable\(").is_match(confirm));
    assert!(!rx(r"\[Environment\]::SetEnvironmentVariable\(").is_match(confirm));
}
#[test]
fn source_clm_l164_public_bound_parameters_use_core_safe_keys_membership() {
    let installer = code(&source("deploy/installer-opensource.ps1"));
    assert!(installer.contains("$PSBoundParameters.Keys -contains 'DashboardPort'"));
    assert!(!rx(r"\$PSBoundParameters\.ContainsKey\(").is_match(&installer));
}

fn marked_block<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let head = format!("# >>> {tag} >>>");
    let tail = format!("# <<< {tag} <<<");
    let start = text.find(&head)?;
    if start != 0 && !text[..start].ends_with('\n') {
        return None;
    }
    let end = start + text[start..].find(&tail)? + tail.len();
    let end = text[end..].find('\n').map_or(end, |n| end + n + 1);
    Some(&text[start..end])
}
fn functions(text: &str) -> Vec<(&str, &str)> {
    let starts = rx(r"(?m)^function ([A-Za-z][\w-]*) \{\r?$");
    let found = starts.captures_iter(text).collect::<Vec<_>>();
    found
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let end = found
                .get(i + 1)
                .map_or(text.len(), |next| next.get(0).unwrap().start());
            (
                c.get(1).unwrap().as_str(),
                &text[c.get(0).unwrap().start()..end],
            )
        })
        .collect()
}
#[test]
fn source_nonascii_l116_l122_l134_identity_scope_is_nonempty_whoami_free_and_byte_identical() {
    let tracked = tracked();
    assert!(tracked.len() > 5);
    assert!(tracked.contains(&"scripts/loongsuite-pilot.ps1".to_owned()));
    for path in &tracked {
        assert!(
            !rx(r"\bwhoami\b").is_match(&code(&source(path))),
            "{path} derives identity from codepage-decoded native stdout"
        );
    }
    let service = source("scripts/loongsuite-pilot.ps1");
    let expected =
        marked_block(&service, "pilot-account-identity").expect("service account identity block");
    for path in [
        "scripts/loongsuite-pilot.ps1",
        "deploy/installer.ps1",
        "deploy/installer-inner.ps1",
        "deploy/installer-opensource.ps1",
    ] {
        if !root().join(path).is_file() {
            continue;
        }
        let text = source(path);
        assert_eq!(
            marked_block(&text, "pilot-account-identity"),
            Some(expected),
            "{path}"
        );
    }
}

struct PinSite {
    line: String,
    after: Vec<String>,
}
fn pin_sites(text: &str) -> Vec<PinSite> {
    let rows = lines(text);
    let assignment = rx(r"\$(?:script:)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|\+=)\s*(.*)$");
    let loop_binding = rx(r"foreach \(\$([A-Za-z_][A-Za-z0-9_]*) in (.*)$");
    let mut bindings = Vec::new();
    for (i, (_, line)) in rows.iter().enumerate() {
        if let Some(c) = assignment.captures(line) {
            bindings.push((c[1].to_owned(), c[2].to_owned()));
        }
        if let Some(c) = loop_binding.captures(line) {
            bindings.push((c[1].to_owned(), c[2].to_owned()));
            bindings.push((
                c[1].to_owned(),
                rows.iter()
                    .skip(i + 1)
                    .take(4)
                    .map(|(_, l)| *l)
                    .collect::<Vec<_>>()
                    .join("\n"),
            ));
        }
    }
    let mut vars = bindings
        .iter()
        .filter(|(_, rhs)| rhs.contains("node-bin"))
        .map(|(name, _)| name.clone())
        .collect::<BTreeSet<_>>();
    let alias = rx(r"^\$(?:script:)?([A-Za-z_][A-Za-z0-9_]*)\s*\)?\s*\{?\s*$");
    for (name, rhs) in &bindings {
        if alias.captures(rhs).is_some_and(|c| vars.contains(&c[1])) {
            vars.insert(name.clone());
        }
    }
    let vars = vars
        .iter()
        .map(|v| rx(&format!(r"\$(?:script:)?{}\b", regex::escape(v))))
        .collect::<Vec<_>>();
    let cmdlet = rx(r"\b(?:Get-Content|Set-Content|Add-Content|Out-File)\b");
    rows.iter()
        .enumerate()
        .filter(|(_, (_, line))| {
            cmdlet.is_match(line)
                && (line.contains("node-bin") || vars.iter().any(|v| v.is_match(line)))
        })
        .map(|(i, (_, line))| PinSite {
            line: (*line).to_owned(),
            after: rows
                .iter()
                .skip(i + 1)
                .take(5)
                .map(|(_, l)| (*l).to_owned())
                .collect(),
        })
        .collect()
}
fn pin_read_strips_bom(site: &PinSite) -> bool {
    let strip = rx(r"Trim\(\[char\]0xFEFF\)");
    if strip.is_match(&site.line) {
        return true;
    }
    let target = rx(r"\$(?:script:)?([A-Za-z0-9_]+)\s*=");
    let Some(target) = target.captures(&site.line) else {
        return false;
    };
    let variable = rx(&format!(r"\${}\b", regex::escape(&target[1])));
    site.after
        .iter()
        .any(|line| strip.is_match(line) && variable.is_match(line))
}
#[test]
fn source_nonascii_l194_l210_remaining_legacy_pin_sites_keep_utf8_bom_and_matcher_boundaries() {
    // Original15/12 floors named the old Node wrappers. Their production binding
    // is now tested through real native current-pointer/legacy-pin adversaries;
    // keep all remaining optional legacy sites guarded and make the source
    // matcher independently nonempty without lowering a historical count.
    let sample = r#"
$pinFiles = @(Join-Path $root 'node-bin')
foreach ($pinFile in $pinFiles) {
    $candidate = Get-Content -LiteralPath $pinFile -Raw -Encoding UTF8
    $candidate = $candidate.Trim([char]0xFEFF).Trim()
    Set-Content -LiteralPath $pinFile -Value $candidate -Encoding UTF8
}
$runtime = Join-Path (Split-Path $pinFile) 'runtime'
Get-Content -LiteralPath $runtime
"#;
    let sites = pin_sites(sample);
    assert_eq!(sites.len(), 2);
    assert!(pin_read_strips_bom(&sites[0]));
    let unsafe_sites =
        pin_sites("$pin = Join-Path $root 'node-bin'\n$candidate = Get-Content $pin");
    assert_eq!(unsafe_sites.len(), 1);
    assert!(!rx(r"-Encoding\s+UTF8\b").is_match(&unsafe_sites[0].line));
    assert!(!pin_read_strips_bom(&unsafe_sites[0]));
    for path in tracked() {
        for site in pin_sites(&source(&path)) {
            assert!(
                rx(r"-Encoding\s+UTF8\b").is_match(&site.line),
                "{path}: {}",
                site.line
            );
            if rx(r"\bGet-Content\b").is_match(&site.line) {
                assert!(pin_read_strips_bom(&site), "{path}: {}", site.line);
            }
        }
    }
}

#[test]
fn source_nonascii_l233_l259_remaining_legacy_tar_helpers_keep_ascii_and_secret_boundaries() {
    let invokes_tar = rx(r"Expand-PilotTarGz \$");
    let unsafe_temp = rx(r"Get-PilotTempRoot|GetTempPath|Join-Path \$env:(?:TEMP|TMP)\b");
    let seed="function Ensure-Fixture {\n$tmp = Join-Path (Get-PilotAsciiTempRoot) 'fixture'\nExpand-PilotTarGz $archive $tmp\n}\nfunction Expand-PilotTarGz {\n}\n";
    assert_eq!(
        functions(seed)
            .iter()
            .filter(|(name, body)| *name != "Expand-PilotTarGz" && invokes_tar.is_match(body))
            .count(),
        1
    );
    // The old >=1 tar caller was Ensure-NodeModules. The native default instead
    // extracts ZIP through Expand-Archive, exercised by the actual Windows
    // local ZIP/Unicode TEMP test. Retained optional legacy callers keep the old
    // rule; removing them does not reintroduce a machine-wide secret staging dir.
    for path in tracked() {
        let text = source(&path);
        for (name, body) in functions(&text) {
            if name == "Expand-PilotTarGz" || !invokes_tar.is_match(body) {
                continue;
            }
            for (_, line) in lines(body) {
                if line.contains("Join-Path") {
                    assert!(!unsafe_temp.is_match(line), "{path} {name}: {line}");
                }
            }
        }
    }
    let mut expanded = Vec::new();
    let mut blocks = Vec::new();
    for path in [
        "deploy/installer.ps1",
        "deploy/installer-inner.ps1",
        "deploy/installer-opensource.ps1",
    ] {
        if !root().join(path).is_file() {
            continue;
        }
        let text = source(path);
        let Some(block) = marked_block(&text, "pilot-ascii-temp") else {
            assert!(
                !functions(&text)
                    .iter()
                    .any(|(name, body)| *name != "Expand-PilotTarGz" && invokes_tar.is_match(body)),
                "legacy tar caller lost ASCII root: {path}"
            );
            continue;
        };
        let code = code(block);
        assert!(!code.contains("GetTempPath"), "{path}");
        assert!(code.contains("Set-Content -LiteralPath $probe"), "{path}");
        assert!(code.contains(r"[^\x20-\x7E]"), "{path}");
        assert!(
            !rx(r"\$cfgTmp = Join-Path \(Get-PilotAsciiTempRoot\)").is_match(&text),
            "{path} stages a secret under shared ASCII root"
        );
        if code.contains("$expanded = Get-PilotLongPath $root") {
            assert!(code.contains("$expanded -notmatch"), "{path}");
            expanded.push(path);
            blocks.push(block.to_owned());
        }
    }
    if root().join("deploy/installer-opensource.ps1").is_file()
        && !root().join("deploy/installer.ps1").is_file()
        && marked_block(
            &source("deploy/installer-opensource.ps1"),
            "pilot-ascii-temp",
        )
        .is_some()
    {
        assert!(expanded.contains(&"deploy/installer-opensource.ps1"));
    }
    for block in &blocks {
        assert_eq!(block, &blocks[0]);
    }
}

#[test]
fn source_nonascii_l165_all_present_task_tag_assignments_use_the_shared_identity_helper() {
    let assignment = rx(r"\$(?:USER_TAG|userTag)\s*=");
    let manual = rx(r"-replace '\[\^A-Za-z0-9\._-\]', '_'");
    for path in [
        "scripts/loongsuite-pilot.ps1",
        "deploy/installer.ps1",
        "deploy/installer-inner.ps1",
        "deploy/installer-opensource.ps1",
    ] {
        if !root().join(path).is_file() {
            continue;
        }
        let text = source(path);
        let block = marked_block(&text, "pilot-account-identity").unwrap();
        let outside = text.replacen(block, "", 1);
        let rows = lines(&outside);
        let assignments = rows
            .iter()
            .filter(|(_, line)| assignment.is_match(line))
            .collect::<Vec<_>>();
        assert!(!assignments.is_empty(), "{path} has no task tag consumers");
        for (_, line) in assignments {
            assert!(line.contains("Get-PilotUserTag"), "{path}: {line}");
        }
        for (_, line) in rows {
            assert!(
                !manual.is_match(line),
                "{path}: manually rebuilt task identity: {line}"
            );
        }
    }
}

fn ps_lines_without_here_strings(text: &str) -> Vec<String> {
    let opener = rx(r#"@(["'])\s*$"#);
    let mut closer: Option<String> = None;
    text.split('\n')
        .map(|line| {
            if let Some(close) = &closer {
                if line.starts_with(close) {
                    closer = None;
                }
                return String::new();
            }
            if let Some(c) = opener.captures(line) {
                closer = Some(if &c[1] == "\"" { "\"@" } else { "'@" }.to_owned());
                return String::new();
            }
            if line.trim_start().starts_with('#') {
                String::new()
            } else {
                line.to_owned()
            }
        })
        .collect()
}
fn finally_bodies(text: &str) -> Vec<String> {
    let src = ps_lines_without_here_strings(text).join("\n");
    let bytes = src.as_bytes();
    rx(r"\bfinally\s*\{")
        .find_iter(&src)
        .map(|m| {
            let mut depth = 1;
            let mut end = m.end();
            while end < bytes.len() && depth > 0 {
                if bytes[end] == b'{' {
                    depth += 1;
                } else if bytes[end] == b'}' {
                    depth -= 1;
                }
                end += 1;
            }
            assert_eq!(depth, 0, "unclosed finally block");
            src[m.end()..end - 1].to_owned()
        })
        .collect()
}
fn temp_hazard_sites(text: &str) -> Vec<String> {
    let rows = ps_lines_without_here_strings(text);
    let assignment = rx(r"\$(?:script:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$");
    let bindings = rows
        .iter()
        .filter_map(|l| {
            assignment
                .captures(l)
                .map(|c| (c[1].to_owned(), c[2].to_owned()))
        })
        .collect::<Vec<_>>();
    let seed = rx(r"Get-PilotTempRoot|Get-PilotAsciiTempRoot|\$env:TEMP\b|\$env:TMP\b|GetTempPath");
    let mut vars = bindings
        .iter()
        .filter(|(_, rhs)| seed.is_match(rhs))
        .map(|(name, _)| name.clone())
        .collect::<BTreeSet<_>>();
    let derived = rx(r"\b(?:Join-Path|Split-Path|Get-ChildItem)\b");
    let alias = rx(r"^\$(?:script:)?[A-Za-z_][A-Za-z0-9_]*\s*$");
    let names = bindings
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<BTreeSet<_>>();
    let patterns = names
        .into_iter()
        .map(|name| {
            let pattern = rx(&format!(r"\$(?:script:)?{}\b", regex::escape(&name)));
            (name, pattern)
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    for _ in 0..8 {
        let before = vars.len();
        for (name, rhs) in &bindings {
            if !derived.is_match(rhs) && !alias.is_match(rhs) {
                continue;
            }
            if vars.iter().any(|v| patterns[v].is_match(rhs)) {
                vars.insert(name.clone());
            }
        }
        if vars.len() == before {
            break;
        }
    }
    let vars = vars.iter().map(|v| &patterns[v]).collect::<Vec<_>>();
    let hazardous = rx(
        r"\b(?:Remove-Item|Move-Item|Rename-Item|Set-Location|Push-Location|Remove-PilotPathQuietly)\b",
    );
    rows.into_iter()
        .filter(|line| hazardous.is_match(line) && vars.iter().any(|v| v.is_match(line)))
        .collect()
}
#[test]
fn source_short_l157_l168_l175_l182_present_installers_keep_one_shared_short_path_block() {
    let present = [
        "deploy/installer.ps1",
        "deploy/installer-inner.ps1",
        "deploy/installer-opensource.ps1",
    ]
    .into_iter()
    .filter(|p| root().join(p).is_file())
    .collect::<Vec<_>>();
    assert!(!present.is_empty());
    assert!(
        present.contains(&"deploy/installer.ps1")
            || present.contains(&"deploy/installer-opensource.ps1")
    );
    let mut blocks = Vec::new();
    for path in present {
        let text = source(path);
        if path != "deploy/installer-opensource.ps1"
            || !root().join("deploy/installer.ps1").is_file()
        {
            assert!(marked_block(&text, "pilot-short-path").is_some(), "{path}");
        }
        if let Some(block) = marked_block(&text, "pilot-short-path") {
            blocks.push(block.to_owned());
        }
    }
    assert!(!blocks.is_empty());
    for block in &blocks {
        assert_eq!(block, &blocks[0]);
    }
}
#[test]
fn source_short_l193_l208_actual_helpers_keep_clm_safe_fullname_and_catch_binding_failures() {
    for path in [
        "deploy/installer.ps1",
        "deploy/installer-inner.ps1",
        "deploy/installer-opensource.ps1",
    ] {
        if !root().join(path).is_file() {
            continue;
        }
        let text = source(path);
        if marked_block(&text, "pilot-short-path").is_none() {
            continue;
        }
        let fns = functions(&text);
        let long = fns
            .iter()
            .find(|(name, _)| *name == "Get-PilotLongPath")
            .unwrap()
            .1;
        for expected in [
            "Get-Item -LiteralPath $Path -Force -ErrorAction Stop",
            "$item.FullName",
            "Split-Path -Parent $Path",
            "$parentItem.FullName",
        ] {
            assert!(long.contains(expected), "{path}: {expected}");
        }
        assert!(
            !rx(r"Convert-Path|Resolve-Path|\[(?:System\.)?IO\.|New-Object|Add-Type")
                .is_match(long),
            "{path}"
        );
        let quiet = fns
            .iter()
            .find(|(name, _)| *name == "Remove-PilotPathQuietly")
            .unwrap()
            .1;
        assert!(quiet.contains("Remove-Item -LiteralPath (Get-PilotLongPath $Path) -Recurse -Force -ErrorAction SilentlyContinue"),"{path}");
        assert!(rx(r"(?s)try \{.*\} catch \{").is_match(quiet), "{path}");
    }
}
#[test]
fn source_short_l217_l232_l244_finally_and_temp_taint_keep_original_cleanup_boundaries() {
    let sample="$tmp = Join-Path $env:TEMP 'fixture'\n$stage = Join-Path $tmp 'stage'\n$alias = $stage\nRemove-Item $alias -Recurse -Force -ErrorAction SilentlyContinue";
    assert_eq!(temp_hazard_sites(sample).len(), 1);
    assert_eq!(
        finally_bodies("try { } finally { Remove-Item $path }").len(),
        1
    );
    let embedded="$payload = @'\ntry {} finally { Remove-Item $tmp }\n'@\n# finally { Move-Item $tmp $dest }\n";
    assert!(finally_bodies(embedded).is_empty());
    assert!(temp_hazard_sites(embedded).is_empty());
    let cmdlet = rx(r"\b(?:Remove-Item|Move-Item)\b");
    for path in [
        "deploy/installer.ps1",
        "deploy/installer-inner.ps1",
        "deploy/installer-opensource.ps1",
    ] {
        if !root().join(path).is_file() {
            continue;
        }
        let text = source(path);
        if marked_block(&text, "pilot-short-path").is_none() {
            continue;
        }
        for body in finally_bodies(&text) {
            for line in body.lines() {
                assert!(
                    !cmdlet.is_match(line) || rx(r"\bEnv:").is_match(line),
                    "{path}: direct disk cleanup inside finally: {line}"
                );
            }
        }
        let sites = temp_hazard_sites(&text);
        // The original >=4 floor named two Node staging dirs, node_modules move
        // and npm log. Preserve it while that optional legacy implementation
        // exists; retired default Node paths instead have real native ZIP and
        // cleanup contracts, not a weakened legacy floor.
        if functions(&text)
            .iter()
            .any(|(name, _)| *name == "Ensure-NodeModules")
        {
            assert!(sites.len() >= 4, "{path}: original legacy floor4");
        }
        for line in sites {
            assert!(
                line.contains("Get-PilotLongPath") || line.contains("Remove-PilotPathQuietly"),
                "{path}: raw possibly-short cleanup: {line}"
            );
        }
        for line in ps_lines_without_here_strings(&text) {
            assert!(
                !(rx(r"Remove-Item\s+[^-\n]").is_match(&line)
                    && line.contains("-Recurse")
                    && line.contains("SilentlyContinue")),
                "{path}: bare recursive delete: {line}"
            );
        }
    }
}
#[test]
fn source_short_retired_ascii_and_seven_zip_mechanisms_have_no_public_native_bootstrap_path() {
    let text = source("deploy/installer-opensource.ps1");
    let fns = functions(&text);
    let body = code(
        fns.iter()
            .find(|(name, _)| *name == "Download-AndExtract")
            .unwrap()
            .1,
    );
    assert!(
        body.contains("Expand-Archive"),
        "native ZIP extraction entry disappeared"
    );
    for retired in [
        "Ensure-NodeModules",
        "Ensure-ManagedNode",
        "Expand-PilotTarGz",
        "Get-PilotAsciiTempRoot",
        "$tarFile",
        "$tarPath",
        "7z.exe",
        "7za.exe",
    ] {
        assert!(
            !body.contains(retired),
            "native bootstrap restored retired runtime mechanism: {retired}"
        );
    }
}
