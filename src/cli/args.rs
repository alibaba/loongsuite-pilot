//! 在访问配置、创建日志或启动服务之前统一解析 CLI 参数。

use clap::{builder::NonEmptyStringValueParser, Arg, ArgAction, ArgMatches, Command};

fn flag(name: &'static str) -> Arg {
    Arg::new(name).long(name).action(ArgAction::SetTrue)
}

fn value(name: &'static str) -> Arg {
    Arg::new(name)
        .long(name)
        .value_parser(NonEmptyStringValueParser::new())
}

fn id(required: bool) -> Arg {
    Arg::new("id")
        .required(required)
        .value_parser(NonEmptyStringValueParser::new())
}

fn hook_action(name: &'static str) -> Command {
    Command::new(name)
        .arg(value("agents"))
        .arg(value("home").action(ArgAction::Append))
        .arg(value("config-dir"))
        .arg(value("pilot-dir"))
        .arg(flag("json"))
}

pub(crate) fn command() -> Command {
    Command::new("loongsuite-pilot")
        .version(env!("CARGO_PKG_VERSION"))
        .about("LoongSuite Pilot 原生采集与部署工具；无参数时启动 collector")
        .subcommand(Command::new("run").about("启动 collector"))
        .subcommand(Command::new("run-updater").about("启动原生更新服务"))
        .subcommands(super::service::COMMANDS.iter().map(|&name| {
            let command = Command::new(name).about("调用本安装的平台服务入口");
            if name == "restart-collector" {
                command.arg(flag("defer-updater-restart"))
            } else {
                command
            }
        }))
        .subcommand(crate::deployment::installer_helper::command())
        .subcommand(
            Command::new("service-helper")
                .hide(true)
                .subcommand_required(true)
                .subcommand(
                    Command::new("process-alive")
                        .arg(
                            value("pid")
                                .required(true)
                                .value_parser(clap::value_parser!(u32).range(1..)),
                        )
                        .arg(
                            value("role")
                                .required(true)
                                .value_parser(["collector", "updater"]),
                        )
                        .arg(value("cache-dir").required(true))
                        .arg(value("data-dir").required(true)),
                ),
        )
        .subcommand(
            Command::new("check")
                .about("只读检查配置、版本与运行资源")
                .arg(flag("json"))
                .arg(value("resource-root")),
        )
        .subcommand(
            Command::new("probe")
                .about("发现 Agent 或查询构建版本类型")
                .arg(flag("installer").conflicts_with("build-edition"))
                .arg(flag("list").conflicts_with("build-edition"))
                .arg(flag("build-edition")),
        )
        .subcommand(
            Command::new("hook")
                .about("部署或检查 Agent Hook")
                .subcommand(hook_action("install"))
                .subcommand(hook_action("status")),
        )
        .subcommand(
            Command::new("hook-process")
                .about("处理独立 Hook 的原始 stdin")
                .arg(Arg::new("agent").required(true).value_parser([
                    "cursor",
                    "claude-code",
                    "codex",
                    "qwen-code-cli",
                    "qwen-work-cn",
                    "grok-build",
                    "qoder",
                    "qoder-cn",
                    "kiro-cli",
                    "qoderwork",
                    "qoder-work",
                    "qoder-work-cn",
                    "workbuddy",
                ]))
                .arg(Arg::new("event"))
                .arg(Arg::new("payload-path").requires("event"))
                .arg(value("agent-id"))
                .arg(value("log-prefix"))
                .arg(flag("wakeup-only"))
                .arg(value("data-dir").requires("wakeup-only"))
                .arg(flag("retry"))
                .arg(value("transcript"))
                .arg(value("session"))
                .arg(value("cwd"))
                .arg(value("trigger-end-line"))
                .arg(flag("allow-fallback")),
        )
        .subcommand(
            Command::new("deploy")
                .about("按配置部署全部已发现 Agent")
                .arg(value("require").action(ArgAction::Append))
                .arg(flag("json")),
        )
        .subcommand(
            Command::new("inject-hooks")
                .about("在 Agent 启动前仅同步部署安全的 Hook/Plugin")
                .arg(Arg::new("raw-args").num_args(0..).allow_hyphen_values(true)),
        )
        .subcommand(
            Command::new("inject")
                .about("在指定 Claude Code 目录注入 Hook")
                .arg(value("agents").required(true).value_parser(["claude-code"]))
                .arg(value("config-dir"))
                .arg(flag("json")),
        )
        .subcommand(
            Command::new("menubar")
                .about("管理 macOS 菜单栏应用")
                .subcommand(Command::new("start"))
                .subcommand(Command::new("stop")),
        )
        .subcommand(
            Command::new("tokens")
                .disable_help_subcommand(true)
                .visible_alias("token-usage")
                .about("显示 token 使用量")
                .arg(flag("once"))
                .arg(flag("no-color"))
                .arg(flag("today"))
                .arg(flag("7d").visible_alias("seven-days"))
                .arg(flag("30d").visible_alias("thirty-days"))
                .arg(value("range"))
                .arg(value("data-dir"))
                .subcommand(Command::new("help")),
        )
        .subcommand(
            Command::new("interceptor")
                .about("拦截器协议入口")
                .version(env!("CARGO_PKG_VERSION"))
                .subcommand(Command::new("version"))
                .subcommand(Command::new("status"))
                .subcommand(
                    Command::new("hook")
                        .arg(value("agent").required(true))
                        .arg(value("event")),
                ),
        )
        .subcommand(
            Command::new("dashboard")
                .about("本地 Dashboard 管理")
                .subcommand_required(true)
                .subcommand(
                    Command::new("shortcut")
                        .about("显式管理 macOS Dashboard 快捷方式")
                        .subcommand_required(true)
                        .subcommands(["install", "status", "uninstall"].map(Command::new)),
                )
                .subcommand(
                    Command::new("probe")
                        .about("只读查询端口或检查本安装的 HTTP 服务")
                        .arg(flag("port").conflicts_with_all(["data-dir", "available"]))
                        .arg(flag("data-dir").conflicts_with("available"))
                        .arg(flag("available")),
                ),
        )
        .subcommand(
            Command::new("span-attr")
                .about("管理自定义 Trace 属性，不重启 collector")
                .subcommand_required(true)
                .subcommand(
                    Command::new("set")
                        .arg(
                            Arg::new("key")
                                .required(true)
                                .value_parser(NonEmptyStringValueParser::new()),
                        )
                        .arg(Arg::new("value").required(true)),
                )
                .subcommand(
                    Command::new("unset").arg(
                        Arg::new("key")
                            .required(true)
                            .value_parser(NonEmptyStringValueParser::new()),
                    ),
                )
                .subcommand(Command::new("list"))
                .subcommand(Command::new("clear")),
        )
        .subcommand(worker())
        .subcommand(agent())
}

fn worker() -> Command {
    Command::new("worker")
        .about("管理本地 worker")
        .subcommand(
            Command::new("connect")
                .arg(id(false))
                .arg(value("runtime"))
                .arg(value("bootstrap-token"))
                .arg(value("work-dir"))
                .arg(flag("json"))
                // 只在显式 -- 后透传，不能把拼错的 Pilot 参数交给宿主。
                .arg(
                    Arg::new("runtime-args")
                        .last(true)
                        .num_args(0..)
                        .allow_hyphen_values(true),
                ),
        )
        .subcommand(Command::new("list").arg(flag("json")))
        .subcommand(Command::new("status").arg(id(false)).arg(flag("json")))
        .subcommand(Command::new("disconnect").arg(id(true)).arg(flag("json")))
        .subcommand(Command::new("delete").arg(id(true)).arg(flag("json")))
}

fn agent() -> Command {
    Command::new("agent")
        .about("管理 PI SDK Agent")
        .subcommand(
            Command::new("register")
                .subcommand_required(true)
                .subcommand(
                    Command::new("pi-sdk")
                        .arg(value("id").required(true))
                        .arg(value("name").required(true))
                        .arg(value("agent-dir").required(true))
                        .arg(value("detect-path").action(ArgAction::Append))
                        .arg(value("detect-command").action(ArgAction::Append))
                        .arg(flag("json")),
                ),
        )
        .subcommand(Command::new("list").arg(flag("json")))
        .subcommand(Command::new("doctor").arg(id(true)).arg(flag("json")))
        .subcommand(Command::new("status").arg(id(true)).arg(flag("json")))
        .subcommand(Command::new("unregister").arg(id(true)).arg(flag("json")))
}

pub(crate) fn parse(argv: &[String]) -> Result<ArgMatches, clap::Error> {
    command().try_get_matches_from(
        std::iter::once("loongsuite-pilot").chain(argv.iter().map(String::as_str)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::error::ErrorKind;

    fn parse_words(words: &[&str]) -> Result<ArgMatches, clap::Error> {
        parse(
            &words
                .iter()
                .map(|word| (*word).to_owned())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn schema_is_consistent_and_invalid_commands_never_become_collectors() {
        command().debug_assert();
        assert!(parse_words(&[]).unwrap().subcommand_name().is_none());
        assert_eq!(
            parse_words(&["run"]).unwrap().subcommand_name(),
            Some("run")
        );
        for args in [
            vec!["typo"],
            vec!["--typo"],
            vec!["run", "--typo"],
            vec!["run-updater", "extra"],
            vec!["installer-helper"],
            vec!["installer-helper", "typo"],
            vec!["installer-helper", "write-config", "--api-key", "secret"],
            vec![
                "installer-helper",
                "write-config",
                "--input-env",
                "--from-env",
            ],
            vec!["start", "extra"],
            vec!["status", "--typo"],
            vec!["restart-collector", "--typo"],
            vec!["hook-process"],
            vec!["hook-process", "unknown"],
            vec!["hook", "instal"],
            vec!["probe", "--installer", "--build-edition"],
            vec!["deploy", "--require"],
            vec!["worker", "connect", "--typo"],
            vec!["agent", "unregister"],
            vec!["interceptor", "status", "extra"],
            vec!["span-attr", "set", "key"],
            vec!["span-attr", "unset"],
            vec!["span-attr", "clear", "extra"],
            vec!["dashboard", "probe", "--port", "--available"],
        ] {
            assert!(parse_words(&args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn help_and_version_finish_during_parsing() {
        for args in [
            vec!["--help"],
            vec!["hook", "--help"],
            vec!["hook", "install", "--help"],
            vec!["worker", "connect", "--help"],
            vec!["menubar", "help"],
            vec!["installer-helper", "write-config", "--help"],
            vec!["start", "--help"],
            vec!["restart-collector", "--help"],
        ] {
            assert_eq!(
                parse_words(&args).unwrap_err().kind(),
                ErrorKind::DisplayHelp
            );
        }
        assert_eq!(
            parse_words(&["--version"]).unwrap_err().kind(),
            ErrorKind::DisplayVersion
        );
    }

    #[test]
    fn delayed_hook_keeps_the_pending_file_argument() {
        let parsed = parse_words(&[
            "hook-process",
            "kiro-cli",
            "delayedCollect",
            "待处理 空格🚀.json",
            "--allow-fallback",
        ])
        .unwrap();
        let hook = parsed.subcommand_matches("hook-process").unwrap();
        assert_eq!(
            hook.get_one::<String>("payload-path").unwrap(),
            "待处理 空格🚀.json"
        );
        assert!(hook.get_flag("allow-fallback"));
    }

    #[test]
    fn worker_separator_preserves_host_flags_and_unicode() {
        let parsed = parse_words(&[
            "worker",
            "connect",
            "--runtime",
            "pi",
            "--work-dir",
            "目录 空格🚀",
            "--",
            "--help",
            "--model=x",
        ])
        .unwrap();
        let connect = parsed
            .subcommand_matches("worker")
            .unwrap()
            .subcommand_matches("connect")
            .unwrap();
        assert_eq!(
            connect.get_one::<String>("work-dir").unwrap(),
            "目录 空格🚀"
        );
        assert_eq!(
            connect
                .get_many::<String>("runtime-args")
                .unwrap()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["--help", "--model=x"]
        );
    }
}
