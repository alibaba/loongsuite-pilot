//! Frozen intercept limits and real temporary shell-profile lifecycle.
use super::retirement::{Backend, Command, Context, Host};
use super::*;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
fn config() -> HookWatchdogConfig {
    HookWatchdogConfig {
        enabled: true,
        interval_ms: 60_000,
        repair_cooldown_ms: 600_000,
    }
}
#[derive(Clone, Default)]
struct Calls {
    pre: Arc<AtomicUsize>,
    check: Arc<AtomicUsize>,
    repair: Arc<AtomicUsize>,
}
impl Calls {
    fn values(&self) -> [usize; 3] {
        [
            self.pre.load(Ordering::SeqCst),
            self.check.load(Ordering::SeqCst),
            self.repair.load(Ordering::SeqCst),
        ]
    }
}
fn physical(
    root: &Path,
    id: &str,
    precondition: bool,
    force_unhealthy: bool,
) -> (InterceptCheckTarget, Calls, PathBuf) {
    let marker = root.join(id);
    let calls = Calls::default();
    let pre = calls.pre.clone();
    let check = calls.check.clone();
    let repair = calls.repair.clone();
    let checked = marker.clone();
    let repaired = marker.clone();
    (
        InterceptCheckTarget {
            id: id.into(),
            enabled: Arc::new(|| true),
            precondition: Arc::new(move || {
                pre.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move { precondition })
            }),
            check: Arc::new(move || {
                check.fetch_add(1, Ordering::SeqCst);
                let healthy = !force_unhealthy && checked.is_file();
                Box::pin(async move { healthy })
            }),
            repair: Arc::new(move || {
                repair.fetch_add(1, Ordering::SeqCst);
                let marker = repaired.clone();
                Box::pin(async move {
                    std::fs::write(marker, "physically installed").map_err(|e| e.to_string())
                })
            }),
            cleanup: None,
        },
        calls,
        marker,
    )
}
fn wd(config: HookWatchdogConfig, targets: Vec<InterceptCheckTarget>) -> HookWatchdog {
    HookWatchdog::new(config, Vec::new(), targets)
}
#[tokio::test]
async fn intercept_l58_failed_precondition_prevents_check_repair_and_file_creation() {
    let root = tempfile::tempdir().unwrap();
    let (t, c, path) = physical(root.path(), "target", false, false);
    assert_eq!(
        wd(config(), vec![t]).run_check().await,
        CheckResult {
            checked: 0,
            repaired: 0,
            skipped: 1
        }
    );
    assert_eq!(c.values(), [1, 0, 0]);
    assert!(!path.exists());
}
#[tokio::test]
async fn intercept_l69_actual_healthy_marker_does_not_trigger_repair() {
    let root = tempfile::tempdir().unwrap();
    let (t, c, path) = physical(root.path(), "target", true, false);
    std::fs::write(&path, "healthy existing").unwrap();
    assert_eq!(
        wd(config(), vec![t]).run_check().await,
        CheckResult {
            checked: 1,
            repaired: 0,
            skipped: 0
        }
    );
    assert_eq!(c.values(), [1, 1, 0]);
    assert_eq!(std::fs::read_to_string(path).unwrap(), "healthy existing");
}
#[tokio::test]
async fn intercept_l79_unhealthy_target_is_physically_repaired_once() {
    let root = tempfile::tempdir().unwrap();
    let (t, c, path) = physical(root.path(), "target", true, false);
    assert_eq!(
        wd(config(), vec![t]).run_check().await,
        CheckResult {
            checked: 0,
            repaired: 1,
            skipped: 0
        }
    );
    assert_eq!(c.values(), [1, 1, 1]);
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "physically installed"
    );
}
#[tokio::test]
async fn intercept_l88_cooldown_prevents_repeat_after_external_marker_removal() {
    let root = tempfile::tempdir().unwrap();
    let (t, c, path) = physical(root.path(), "target", true, false);
    let watchdog = wd(config(), vec![t]);
    assert_eq!(watchdog.run_check().await.repaired, 1);
    std::fs::remove_file(&path).unwrap();
    assert_eq!(watchdog.run_check().await.repaired, 0);
    assert_eq!(c.values(), [2, 2, 1]);
    assert!(!path.exists());
}
#[tokio::test]
async fn intercept_l99_five_failed_health_observations_allow_only_three_repairs() {
    let root = tempfile::tempdir().unwrap();
    let (t, c, path) = physical(root.path(), "target", true, true);
    let mut cfg = config();
    cfg.repair_cooldown_ms = 0;
    let watchdog = wd(cfg, vec![t]);
    for _ in 0..5 {
        watchdog.run_check().await;
    }
    assert_eq!(c.values(), [5, 5, 3]);
    assert!(path.is_file());
    assert_eq!(
        watchdog.daily_repair_count.lock().unwrap().get("target"),
        Some(&3)
    );
}
#[tokio::test]
async fn intercept_l112_real_repair_write_error_is_contained() {
    let root = tempfile::tempdir().unwrap();
    let (t, c, path) = physical(root.path(), "target", true, false);
    std::fs::create_dir(&path).unwrap();
    assert_eq!(
        wd(config(), vec![t]).run_check().await,
        CheckResult::default()
    );
    assert_eq!(c.values(), [1, 1, 1]);
    assert!(path.is_dir());
}
#[tokio::test]
async fn intercept_l125_real_io_error_consumes_neither_cooldown_nor_daily_budget() {
    let root = tempfile::tempdir().unwrap();
    let (t, c, path) = physical(root.path(), "target", true, false);
    std::fs::create_dir(&path).unwrap();
    let watchdog = wd(config(), vec![t]);
    assert_eq!(watchdog.run_check().await, CheckResult::default());
    assert_eq!(watchdog.run_check().await, CheckResult::default());
    assert_eq!(c.values(), [2, 2, 2]);
    assert!(watchdog.last_repair_at.lock().unwrap().is_empty());
    assert!(watchdog.daily_repair_count.lock().unwrap().is_empty());
    std::fs::remove_dir(&path).unwrap();
    assert_eq!(watchdog.run_check().await.repaired, 1);
    assert_eq!(c.values(), [3, 3, 3]);
    assert!(path.is_file());
}
#[tokio::test]
async fn intercept_l141_healthy_broken_and_unavailable_targets_are_independent() {
    let root = tempfile::tempdir().unwrap();
    let (a, ac, ap) = physical(root.path(), "healthy", true, false);
    std::fs::write(&ap, "healthy existing").unwrap();
    let (b, bc, bp) = physical(root.path(), "broken", true, false);
    let (c, cc, cp) = physical(root.path(), "off", false, false);
    assert_eq!(
        wd(config(), vec![a, b, c]).run_check().await,
        CheckResult {
            checked: 1,
            repaired: 1,
            skipped: 1
        }
    );
    assert_eq!(ac.values(), [1, 1, 0]);
    assert_eq!(bc.values(), [1, 1, 1]);
    assert_eq!(cc.values(), [1, 0, 0]);
    assert!(bp.is_file());
    assert!(!cp.exists());
}
#[tokio::test]
async fn intercept_l157_repair_creates_health_and_next_check_does_not_repeat() {
    let root = tempfile::tempdir().unwrap();
    let (t, c, path) = physical(root.path(), "target", true, false);
    let mut cfg = config();
    cfg.repair_cooldown_ms = 0;
    let watchdog = wd(cfg, vec![t]);
    assert_eq!(watchdog.run_check().await.repaired, 1);
    assert_eq!(watchdog.run_check().await.checked, 1);
    assert_eq!(c.values(), [2, 2, 1]);
    assert!(path.is_file());
}
#[tokio::test]
async fn intercept_l175_old_date_resets_the_exhausted_daily_budget() {
    let root = tempfile::tempdir().unwrap();
    let (t, c, path) = physical(root.path(), "target", true, true);
    let mut cfg = config();
    cfg.repair_cooldown_ms = 0;
    let watchdog = wd(cfg, vec![t]);
    for _ in 0..3 {
        assert_eq!(watchdog.run_check().await.repaired, 1);
    }
    assert_eq!(c.values(), [3, 3, 3]);
    // Exact source seam: mark the internal reset date old, without faking time.
    *watchdog.daily_repair_reset_date.lock().unwrap() = "1970-01-01".into();
    assert_eq!(watchdog.run_check().await.repaired, 1);
    assert_eq!(c.values(), [4, 4, 4]);
    assert!(path.is_file());
    assert_eq!(
        watchdog.daily_repair_count.lock().unwrap().get("target"),
        Some(&1)
    );
}
struct NoOs;
impl Backend for NoOs {
    fn run(&self, command: Command) -> BoxFut<Result<String, String>> {
        panic!("RC-only tests must not call the OS: {command:?}")
    }
    fn warn(&self, message: &str, _fields: Value) {
        panic!("unexpected retired-runtime operation: {message}")
    }
}
struct RcFixture {
    root: tempfile::TempDir,
}
impl RcFixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("hooks")).unwrap();
        for script in [
            "claude-code-fetch-intercept.mjs",
            "qodercli-runtime-wrapper.sh",
        ] {
            std::fs::write(root.path().join("hooks").join(script), "// inert fixture\n").unwrap();
        }
        Self { root }
    }
    fn zsh(&self) -> PathBuf {
        self.root.path().join(".zshrc")
    }
    fn bash(&self) -> PathBuf {
        self.root.path().join(".bashrc")
    }
    fn read(&self) -> String {
        std::fs::read_to_string(self.zsh()).unwrap()
    }
    fn target(&self, id: &str, enabled: bool) -> InterceptCheckTarget {
        let agent = match id {
            "qodercli-rc" => "qoder",
            "qoderclicn-rc" => "qoder-cn",
            _ => "claude-code",
        }
        .to_string();
        HookWatchdog::default_intercept_targets_in(
            &self.root.path().to_string_lossy(),
            move |actual| actual != agent || enabled,
            Context {
                host: Host::Other,
                home: self.root.path().into(),
                backend: Arc::new(NoOs),
            },
        )
        .into_iter()
        .find(|t| t.id == id)
        .unwrap()
    }
}
const SIG: &str = "if ! alias claude >/dev/null 2>&1";
const OLD_BARE:&str="# loongsuite-pilot BEGIN claude-code-intercept\nclaude() { BUN_OPTIONS=\"--preload=/old ${BUN_OPTIONS}\" command claude \"$@\"; }\n# loongsuite-pilot END claude-code-intercept";
#[tokio::test]
async fn rc_l672_real_closure_appends_guarded_eval_block_to_both_existing_profiles() {
    let f = RcFixture::new();
    for p in [f.zsh(), f.bash()] {
        std::fs::write(p, "# pre-existing\n").unwrap();
    }
    let t = f.target("claude-code-rc", true);
    assert!((t.precondition)().await);
    assert!(!(t.check)().await);
    (t.repair)().await.unwrap();
    for p in [f.zsh(), f.bash()] {
        let body = std::fs::read_to_string(p).unwrap();
        assert!(body.contains("# pre-existing"));
        assert!(body.contains(SIG));
        assert!(body.contains("eval 'claude() { BUN_OPTIONS=\"--preload="));
        assert!(body.contains("${BUN_OPTIONS}"));
        assert!(!body.lines().any(|l| l.trim_start().starts_with("claude()")));
    }
    assert!((t.check)().await);
}
#[tokio::test]
async fn rc_l689_old_bare_block_is_migrated_without_creating_absent_profile() {
    let f = RcFixture::new();
    std::fs::write(f.zsh(), format!("# top\n\n{OLD_BARE}\n")).unwrap();
    let t = f.target("claude-code-rc", true);
    assert!(!(t.check)().await);
    (t.repair)().await.unwrap();
    let body = f.read();
    assert!(!body.contains("claude() { BUN_OPTIONS=\"--preload=/old"));
    assert!(!body.lines().any(|l| l.trim_start().starts_with("claude()")));
    assert!(body.contains(SIG));
    assert_eq!(body.matches("BEGIN claude-code-intercept").count(), 1);
    assert!(body.contains("# top"));
    assert!((t.check)().await);
    assert!(!f.bash().exists());
}
#[tokio::test]
async fn rc_l704_current_block_is_not_duplicated_by_repeat_repair() {
    let f = RcFixture::new();
    std::fs::write(f.zsh(), "").unwrap();
    let t = f.target("claude-code-rc", true);
    (t.repair)().await.unwrap();
    let before = f.read();
    (t.repair)().await.unwrap();
    assert_eq!(f.read(), before);
    assert_eq!(before.matches("BEGIN claude-code-intercept").count(), 1);
}
#[tokio::test]
async fn rc_l713_disabled_cleanup_removes_installed_block_and_keeps_user_content() {
    let f = RcFixture::new();
    std::fs::write(f.zsh(), "# keep-me\n").unwrap();
    (f.target("claude-code-rc", true).repair)().await.unwrap();
    assert!(f.read().contains(SIG));
    (f.target("claude-code-rc", false).cleanup.unwrap())()
        .await
        .unwrap();
    let body = f.read();
    assert!(!body.contains("loongsuite-pilot BEGIN claude-code-intercept"));
    assert!(!body.contains(SIG));
    assert!(body.contains("# keep-me"));
}
#[tokio::test]
async fn rc_l727_disabled_cleanup_also_removes_the_old_bare_block() {
    let f = RcFixture::new();
    std::fs::write(f.zsh(), format!("# keep\n{OLD_BARE}\n")).unwrap();
    (f.target("claude-code-rc", false).cleanup.unwrap())()
        .await
        .unwrap();
    assert!(!f
        .read()
        .contains("loongsuite-pilot BEGIN claude-code-intercept"));
    assert!(f.read().contains("# keep"));
}
#[tokio::test]
async fn rc_l735_current_cn_block_cannot_mask_a_stale_cli_block() {
    let f = RcFixture::new();
    std::fs::write(f.zsh(), "").unwrap();
    let cn = f.target("qoderclicn-rc", true);
    let cli = f.target("qodercli-rc", true);
    (cn.repair)().await.unwrap();
    let cn_before = f.read();
    assert!((cn.check)().await);
    std::fs::write(f.zsh(),format!("{cn_before}# loongsuite-pilot BEGIN qodercli-intercept\nqodercli() {{ BUN_OPTIONS=\"--preload=/old ${{BUN_OPTIONS}}\" command qodercli \"$@\"; }}\n# loongsuite-pilot END qodercli-intercept\n")).unwrap();
    assert!(!(cli.check)().await);
    (cli.repair)().await.unwrap();
    let body = f.read();
    assert!(!body.contains("--preload=/old"));
    assert_eq!(body.matches("BEGIN qodercli-intercept").count(), 1);
    assert_eq!(body.matches("BEGIN qoderclicn-intercept").count(), 1);
    assert!(body.contains(cn_before.trim()));
    assert!((cli.check)().await);
    assert!((cn.check)().await);
}
#[tokio::test]
async fn rc_l763_unterminated_cli_repair_preserves_sibling_cn_and_user_tail() {
    let f = RcFixture::new();
    std::fs::write(f.zsh(), "").unwrap();
    let cn = f.target("qoderclicn-rc", true);
    let cli = f.target("qodercli-rc", true);
    (cn.repair)().await.unwrap();
    let cn_block = f.read();
    std::fs::write(f.zsh(),format!("# user-top\n# loongsuite-pilot BEGIN qodercli-intercept\n  eval 'qodercli() {{ \"/tmp/pilot/hooks/qodercli-runtime-wrapper.sh\" \"$@\"; }}'\n{}\nexport PATH=/user/bin:$PATH\n",cn_block.trim())).unwrap();
    assert!(!(cli.check)().await);
    assert!((cn.check)().await);
    (cli.repair)().await.unwrap();
    let body = f.read();
    assert_eq!(body.matches("BEGIN qodercli-intercept").count(), 1);
    assert_eq!(body.matches("END qodercli-intercept").count(), 1);
    assert_eq!(body.matches("BEGIN qoderclicn-intercept").count(), 1);
    assert!(body.contains("LOONGSUITE_QODERCLI_FLAVOR=qoderclicn"));
    assert!(body.contains("# user-top"));
    assert!(body.contains("export PATH=/user/bin:$PATH"));
    assert!(body.contains(cn_block.trim()));
    assert!((cli.check)().await);
    assert!((cn.check)().await);
}
#[tokio::test]
async fn rc_l802_two_flavors_are_independent_and_disabling_cn_keeps_cli() {
    let f = RcFixture::new();
    std::fs::write(f.zsh(), "").unwrap();
    let cn = f.target("qoderclicn-rc", true);
    let cli = f.target("qodercli-rc", true);
    (cli.repair)().await.unwrap();
    assert!(!(cn.check)().await);
    (cn.repair)().await.unwrap();
    let body = f.read();
    assert!(body.contains("eval 'qodercli() { \""));
    assert!(body.contains("LOONGSUITE_QODERCLI_FLAVOR=qoderclicn"));
    assert_eq!(body.matches("BEGIN qodercli-intercept").count(), 1);
    assert_eq!(body.matches("BEGIN qoderclicn-intercept").count(), 1);
    (f.target("qoderclicn-rc", false).cleanup.unwrap())()
        .await
        .unwrap();
    let after = f.read();
    assert!(!after.contains("qoderclicn-intercept"));
    assert!(after.contains("BEGIN qodercli-intercept"));
    assert!((cli.check)().await);
}
#[tokio::test]
async fn rc_l829_watchdog_disabled_target_cleans_without_reinjection() {
    let f = RcFixture::new();
    std::fs::write(f.zsh(), "").unwrap();
    (f.target("claude-code-rc", true).repair)().await.unwrap();
    assert!(f.read().contains(SIG));
    assert_eq!(
        wd(config(), vec![f.target("claude-code-rc", false)])
            .run_check()
            .await,
        CheckResult {
            checked: 0,
            repaired: 0,
            skipped: 1
        }
    );
    assert!(!f.read().contains(SIG));
    assert!(!f.read().contains("BEGIN claude-code-intercept"));
}
#[test]
fn metadata_l958_each_real_render_contains_its_signature_and_delimiters() {
    for definition in intercept_rc_blocks() {
        let body = (definition.render)(&format!("/tmp/hooks/{}", definition.script_name));
        assert!(body.contains(definition.marker));
        assert!(body.contains(definition.end_marker));
        assert!(body.contains(definition.signature));
    }
}

const BEGIN: &str = "loongsuite-pilot BEGIN claude-code-intercept";
const END: &str = "loongsuite-pilot END claude-code-intercept";
#[test]
fn strip_l845_inclusive_marker_removal_preserves_user_prefix_and_suffix() {
    let body =
        format!("export PATH=/x:$PATH\n# {BEGIN}\nclaude() {{ echo old; }}\n# {END}\nalias ll=ls");
    assert_eq!(
        strip_marker_block(&body, BEGIN, END),
        "export PATH=/x:$PATH\nalias ll=ls"
    );
}
#[test]
fn strip_l861_absent_markers_are_a_byte_preserving_noop() {
    let body = "export A=1\nalias ll=ls\n";
    assert_eq!(strip_marker_block(body, BEGIN, END), body);
}
#[test]
fn strip_l866_multiline_guarded_block_is_removed_as_one_region() {
    let body=format!("before\n# {BEGIN}\nif ! alias claude >/dev/null 2>&1 && ! typeset -f claude >/dev/null 2>&1; then\n  eval 'claude() {{ :; }}'\nfi\n# {END}\nafter");
    assert_eq!(
        strip_marker_block(&body, BEGIN, END)
            .split('\n')
            .collect::<Vec<_>>(),
        ["before", "after"]
    );
}
#[test]
fn strip_l880_unterminated_block_preserves_the_next_block_and_user_lines() {
    let sibling="# loongsuite-pilot BEGIN qodercli-intercept\n  eval 'qodercli() { :; }'\n# loongsuite-pilot END qodercli-intercept\nalias ll=ls";
    let body = format!("export PATH=/x:$PATH\n# {BEGIN}\nclaude() {{ echo old; }}\n{sibling}");
    assert_eq!(
        strip_marker_block(&body, BEGIN, END),
        format!("export PATH=/x:$PATH\n{sibling}")
    );
}
#[test]
fn strip_l901_repeated_same_begin_stays_inside_one_removed_region() {
    let body = format!("before\n# {BEGIN}\nfirst\n# {BEGIN}\nsecond\n# {END}\nafter");
    assert_eq!(
        strip_marker_block(&body, BEGIN, END)
            .split('\n')
            .collect::<Vec<_>>(),
        ["before", "after"]
    );
}
#[test]
fn extract_l919_absent_begin_returns_none() {
    assert_eq!(extract_marker_block("a\nb\n", BEGIN, END), None);
}
#[test]
fn extract_l923_returns_only_the_inclusive_block() {
    let body = format!("before\n{BEGIN}\nbody\n{END}\nafter");
    assert_eq!(
        extract_marker_block(&body, BEGIN, END),
        Some(MarkerBlock {
            text: format!("{BEGIN}\nbody\n{END}"),
            terminated: true
        })
    );
}
#[test]
fn extract_l931_unterminated_block_returns_tail_and_false() {
    let body = format!("before\n{BEGIN}\nbody");
    assert_eq!(
        extract_marker_block(&body, BEGIN, END),
        Some(MarkerBlock {
            text: format!("{BEGIN}\nbody"),
            terminated: false
        })
    );
}
#[test]
fn extract_l939_unterminated_block_stops_before_the_next_begin() {
    let body=format!("before\n{BEGIN}\nbody\n# loongsuite-pilot BEGIN qoderclicn-intercept\ncn body\n# loongsuite-pilot END qoderclicn-intercept");
    assert_eq!(
        extract_marker_block(&body, BEGIN, END),
        Some(MarkerBlock {
            text: format!("{BEGIN}\nbody"),
            terminated: false
        })
    );
}
#[test]
fn metadata_l967_each_pair_has_nonoverlapping_begin_and_end_markers() {
    let defs = intercept_rc_blocks();
    assert_eq!(defs.len(), 3);
    for a in &defs {
        for b in &defs {
            if a.id == b.id {
                continue;
            }
            assert!(!a.marker.contains(b.marker), "{} vs {}", a.id, b.id);
            assert!(!a.end_marker.contains(b.end_marker), "{} vs {}", a.id, b.id);
        }
    }
}
#[test]
fn metadata_l980_no_sibling_render_can_satisfy_another_blocks_signature() {
    let defs = intercept_rc_blocks();
    for a in &defs {
        for b in &defs {
            if a.id == b.id {
                continue;
            }
            let body = (b.render)(&format!("/tmp/hooks/{}", b.script_name));
            assert!(
                !body.contains(a.signature),
                "{} can vouch for {}",
                b.id,
                a.id
            );
        }
    }
}
#[test]
fn metadata_l993_shared_wrapper_name_does_not_appear_in_either_flavor_signature() {
    let defs = intercept_rc_blocks();
    let cli = defs.iter().find(|d| d.id == "qodercli-rc").unwrap();
    let cn = defs.iter().find(|d| d.id == "qoderclicn-rc").unwrap();
    assert_eq!(cn.script_name, cli.script_name);
    assert!(!cli.signature.contains(cli.script_name));
    assert!(!cn.signature.contains(cn.script_name));
}
