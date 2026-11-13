#!/usr/bin/env python3
"""准备名为 loongsuite-pilot 的阿里云 CLI Profile。凭证写入插件或独立 Query Skill 的 aliyun/config.json。"""

import argparse
import json
import os
import shlex
import subprocess
import sys

from util.aliyun import aliyun_bin, aliyun_command_hint, aliyun_config_path
from util.config_record import fail, read_record, save_profile, write_private_text

# Unfinished browser login is rolled back when this limit is reached.
OAUTH_WAIT_SECONDS = 600


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="ensure_oauth", add_help=False, allow_abbrev=False)
    parser.add_argument(
        "--profile",
        default=os.environ.get("LOONGSUITE_PILOT_ALIYUN_PROFILE", "loongsuite-pilot"),
    )
    parser.add_argument("--oauth-site-type", dest="site_type", default="", choices=("CN", "INTL"))
    parser.add_argument("--auth-mode", default="", choices=("OAuth", "AK"))
    args = parser.parse_args(argv)
    return args.profile, args.site_type, args.auth_mode


def profile_summaries():
    """只返回名称、模式，以及 AK 字段是否非空。不返回密钥。"""
    path = aliyun_config_path()
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []
    profiles = data.get("profiles") if isinstance(data, dict) else None
    if not isinstance(profiles, list):
        return []
    summaries = []
    for item in profiles:
        if not isinstance(item, dict) or not item.get("name"):
            continue
        oauth_site_type = item.get("oauth_site_type") or ""
        summaries.append({
            "name": item["name"],
            "mode": item.get("mode") or "",
            "ak_ready": bool(item.get("access_key_id") and item.get("access_key_secret")),
            "oauth_ready": bool(
                item.get("oauth_refresh_token") and oauth_site_type in ("CN", "INTL")
            ),
            "oauth_site_type": oauth_site_type,
        })
    return summaries


def guide_ak(profile):
    command = "%s configure --mode AK --profile %s --config-path %s" % (
        shlex.quote(aliyun_command_hint()),
        shlex.quote(profile),
        shlex.quote(aliyun_config_path()),
    )
    print(
        "AK is not configured. Ask the user to run this command in a local terminal and fill in the prompts.\n"
        "%s\n"
        "Do not run it for them, and do not ask them to paste the AccessKey into the chat. After they confirm it is configured, retry the original Skill auth entry with --auth-mode AK."
        % command,
        file=sys.stderr,
    )
    sys.exit(1)


def profile_usable(item):
    if item["mode"] == "OAuth":
        return item["oauth_ready"]
    return item["mode"] == "AK" and item["ak_ready"]


def resolve_identity(profile, auth_mode, site_type):
    """返回可用的 profile 名称。需要走 OAuth 登录时返回空字符串。"""
    summaries = profile_summaries()
    named = next((item for item in summaries if item["name"] == profile), None)
    ready = named if named and profile_usable(named) else None
    mode_matches = ready and (not auth_mode or ready["mode"] == auth_mode)
    site_matches = auth_mode == "AK" or not site_type or (
        ready and ready["mode"] == "OAuth" and ready["oauth_site_type"] == site_type
    )
    if mode_matches and site_matches:
        return profile
    # Default is browser OAuth. Ask for AK only when the caller asked for it.
    if auth_mode == "AK":
        guide_ak(profile)
    return ""


def load_aliyun_config(path):
    """Read the CLI config. A missing file starts empty. A file that exists but cannot be parsed is left untouched."""
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        fail("Cannot read %s (%s). The file was not changed." % (path, exc))
    if not isinstance(data, dict):
        fail("Cannot read %s: the content is not a JSON object. The file was not changed." % path)
    return data


def seed_oauth_profile(name, site):
    path = aliyun_config_path()
    existed = os.path.isfile(path)
    backup = None
    if existed:
        with open(path, encoding="utf-8") as handle:
            backup = handle.read()
    data = load_aliyun_config(path)
    profiles = data.get("profiles")
    if not isinstance(profiles, list):
        profiles = []
    found = next((item for item in profiles if isinstance(item, dict) and item.get("name") == name), None)
    if found is None:
        found = {"name": name}
        profiles.append(found)
    found["mode"] = "OAuth"
    found["oauth_site_type"] = site
    found.pop("region_id", None)
    found.pop("language", None)
    data["profiles"] = profiles
    if not data.get("current"):
        data["current"] = name
    write_private_text(path, json.dumps(data, indent=2) + "\n")
    return backup, existed


def restore_oauth_config(backup, existed):
    path = aliyun_config_path()
    if not existed:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        return
    write_private_text(path, backup if backup is not None else "")


def configure_oauth(binary, profile, site_type):
    # Domestic site unless the caller already knows this account is international.
    if not site_type:
        site_type = "CN"
    backup, existed = seed_oauth_profile(profile, site_type)
    print(
        "Opening a browser to authorize Aliyun. Site: %s, profile: %s. For the international site, retry with --oauth-site-type INTL."
        % (site_type, profile),
        file=sys.stderr,
    )
    print(
        "Authorization waits up to %d seconds. If it does not finish, this profile is removed."
        % OAUTH_WAIT_SECONDS,
        file=sys.stderr,
    )
    # 站点已写入 profile，configure 不再询问。后面两行空输入只跳过地域和语言提问：
    # 地域保持为空，语言交给 CLI 自己的默认值。
    # 1 表示还没拿到 CLI 退出码；超时改成 124；成功则是 0。非 0 都删掉这次没完成的 profile。
    rc = 1
    try:
        result = subprocess.run(
            [
                binary,
                "configure",
                "--mode",
                "OAuth",
                "--profile",
                profile,
                "--config-path",
                aliyun_config_path(),
            ],
            input="\n\n",
            text=True,
            stdout=sys.stderr,
            stderr=subprocess.STDOUT,
            timeout=OAUTH_WAIT_SECONDS,
        )
        rc = result.returncode
    except subprocess.TimeoutExpired:
        rc = 124
    finally:
        if rc != 0:
            try:
                restore_oauth_config(backup, existed)
            except BaseException as exc:
                print("Failed to restore the original profile: %s." % exc, file=sys.stderr)
    if rc != 0:
        command = "%s configure --mode AK --profile %s --config-path %s" % (
            shlex.quote(aliyun_command_hint()),
            shlex.quote(profile),
            shlex.quote(aliyun_config_path()),
        )
        print(
            "OAuth login did not finish. For the international site, retry with --oauth-site-type INTL. "
            "To use an AccessKey instead, run %s and then auth --auth-mode AK."
            % command,
            file=sys.stderr,
        )
        sys.exit(rc)


def saved_profile():
    profile = str(read_record().get("profile") or "")
    if not profile:
        return ""
    named = next((item for item in profile_summaries() if item["name"] == profile), None)
    if named and profile_usable(named):
        return profile
    return ""


def run(argv):
    profile, site_type, auth_mode = parse_args(argv)
    binary = aliyun_bin()
    existing = resolve_identity(profile, auth_mode, site_type)
    if not existing:
        configure_oauth(binary, profile, site_type)
        existing = profile
    save_profile(existing)
    return existing


if __name__ == "__main__":
    print("oauth_profile=%s" % run(sys.argv[1:]))
