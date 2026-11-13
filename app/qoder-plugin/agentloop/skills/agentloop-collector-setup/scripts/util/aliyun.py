"""调用阿里云 CLI。安装和查询共用。插件共用原插件目录的 aliyun/；独立 Skill 使用 Setup Skill 的 aliyun/，不写入 ~/.aliyun。"""

import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

from util.config_record import (
    DEFAULT_LOGSTORE,
    EXIT_CHOOSE_AGENT_SPACE,
    atomic_private_file,
    fail,
    saved_space,
)

CMS_VERSION = "2024-03-30"
SLS_VERSION = "2020-12-30"
API_KEY_NAME = "loongsuite-pilot-log"
OBSERVABILITY_RETRIES = 5
COMMAND_TIMEOUT_SECONDS = 60
LONG_OPERATION_TIMEOUT_SECONDS = 600
_ALIYUN_BIN = ""
_CDN = "https://aliyuncli.alicdn.com"
_SETUP_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_PLUGIN_ROOT = os.path.abspath(os.path.join(_SETUP_ROOT, "..", ".."))
_IS_PLUGIN = os.path.isfile(os.path.join(_PLUGIN_ROOT, ".qoder-plugin", "plugin.json"))
if not _IS_PLUGIN:
    _PLUGIN_ROOT = _SETUP_ROOT
_ALIYUN_HOME = os.path.join(_PLUGIN_ROOT, "aliyun")
if not _IS_PLUGIN:
    _LEGACY_ALIYUN_HOME = os.path.join(os.path.dirname(_SETUP_ROOT), "agentloop-audit-query", "aliyun")
    if not os.path.isfile(os.path.join(_ALIYUN_HOME, "config.json")) and os.path.isfile(
        os.path.join(_LEGACY_ALIYUN_HOME, "config.json")
    ):
        _ALIYUN_HOME = _LEGACY_ALIYUN_HOME
_PLUGIN_ALIYUN_BIN = os.path.join(_ALIYUN_HOME, "bin", "aliyun")
_PLUGIN_CONFIG = os.path.join(_ALIYUN_HOME, "config.json")
_PLUGINS_DIR = os.path.join(_ALIYUN_HOME, "plugins")
_PLUGINS_ENV = "ALIBABA_CLOUD_CLI_PLUGINS_DIR"


def aliyun_config_path():
    return _PLUGIN_CONFIG


def download_file(url, dest):
    deadline = time.monotonic() + LONG_OPERATION_TIMEOUT_SECONDS
    with urllib.request.urlopen(url, timeout=COMMAND_TIMEOUT_SECONDS) as source:
        with open(dest, "wb") as output:
            while True:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Download timed out (%d seconds)" % LONG_OPERATION_TIMEOUT_SECONDS)
                chunk = source.read1(64 * 1024)
                if not chunk:
                    break
                output.write(chunk)


def cli_version(binary):
    try:
        result = subprocess.run(
            [binary, "version"],
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, ""
    line = (result.stdout or "").splitlines()
    raw = "".join(line[0].split()) if line else ""
    if result.returncode != 0:
        return False, raw
    parts = []
    for piece in raw.split(".")[:3]:
        digits = ""
        for char in piece:
            if not char.isdigit():
                break
            digits += char
        parts.append(int(digits or "0"))
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts) >= (3, 3, 0), raw


def _install_plugin_cli(system):
    if system == "Darwin":
        url = _CDN + "/aliyun-cli-macosx-latest-universal.tgz"
    else:
        machine = platform.machine().lower()
        arch = "arm64" if machine in ("arm64", "aarch64") else "amd64"
        url = _CDN + "/aliyun-cli-linux-latest-" + arch + ".tgz"
    os.makedirs(os.path.dirname(_PLUGIN_ALIYUN_BIN), exist_ok=True)
    staging = tempfile.mkdtemp(prefix="aliyun-cli-")
    try:
        archive = os.path.join(staging, "aliyun.tgz")
        try:
            download_file(url, archive)
        except Exception as exc:
            fail("Aliyun CLI download failed (%s). Download %s and place aliyun at %s" % (exc, url, _PLUGIN_ALIYUN_BIN))
        with tarfile.open(archive, "r:gz") as tar:
            chosen = None
            for item in tar.getmembers():
                name = item.name.replace("\\", "/")
                parts = name.split("/")
                if name.startswith("/") or ".." in parts:
                    continue
                if item.isfile() and os.path.basename(name) == "aliyun":
                    chosen = item
                    break
            if chosen is None:
                fail("The package does not contain aliyun. Download %s" % url)
            extracted = tar.extractfile(chosen)
            if extracted is None:
                fail("The package does not contain aliyun. Download %s" % url)
            with atomic_private_file(_PLUGIN_ALIYUN_BIN, prefix=".aliyun-", mode=0o755) as temp_dest:
                with extracted, open(temp_dest, "wb") as out:
                    shutil.copyfileobj(extracted, out)
                if platform.system() == "Darwin":
                    try:
                        subprocess.run(
                            ["xattr", "-d", "com.apple.quarantine", temp_dest],
                            capture_output=True,
                        )
                    except OSError:
                        pass
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return _PLUGIN_ALIYUN_BIN


def _install_agentloop_plugin(binary):
    # Keep the plugin next to this CLI. The default location is ~/.aliyun/plugins.
    os.environ[_PLUGINS_ENV] = _PLUGINS_DIR
    manifest = os.path.join(_PLUGINS_DIR, "manifest.json")
    try:
        with open(manifest, encoding="utf-8") as handle:
            if "aliyun-cli-agentloop" in handle.read():
                return
    except OSError:
        pass
    print("Downloading AgentLoop CLI plugin ...", file=sys.stderr)
    try:
        result = subprocess.run(
            [binary, "plugin", "install", "--name", "agentloop"],
            capture_output=True,
            text=True,
            timeout=LONG_OPERATION_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        fail("AgentLoop CLI plugin download timed out (%d seconds)" % LONG_OPERATION_TIMEOUT_SECONDS)
    except OSError as exc:
        fail("AgentLoop CLI plugin download failed (%s)" % exc)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        fail("AgentLoop CLI plugin download failed (%s)" % (detail or "unknown error"))


def aliyun_bin():
    global _ALIYUN_BIN
    os.environ[_PLUGINS_ENV] = _PLUGINS_DIR
    if _ALIYUN_BIN:
        _install_agentloop_plugin(_ALIYUN_BIN)
        return _ALIYUN_BIN
    ok, _raw = cli_version(_PLUGIN_ALIYUN_BIN) if os.path.isfile(_PLUGIN_ALIYUN_BIN) else (False, "")
    if ok:
        _ALIYUN_BIN = _PLUGIN_ALIYUN_BIN
        _install_agentloop_plugin(_ALIYUN_BIN)
        return _PLUGIN_ALIYUN_BIN

    system = platform.system()
    if system not in ("Darwin", "Linux"):
        fail("Cannot download aliyun automatically. Place 3.3.0 or newer at %s" % _PLUGIN_ALIYUN_BIN)
    print("Downloading Aliyun CLI ...", file=sys.stderr)
    installed = _install_plugin_cli(system)
    ok, raw = cli_version(installed)
    if not ok:
        fail("aliyun version %s is older than 3.3.0" % (raw or "unknown"))
    _ALIYUN_BIN = installed
    _install_agentloop_plugin(installed)
    return installed


def aliyun_command_hint():
    if _ALIYUN_BIN:
        return _ALIYUN_BIN
    if os.path.isfile(_PLUGIN_ALIYUN_BIN):
        return _PLUGIN_ALIYUN_BIN
    return _PLUGIN_ALIYUN_BIN


def explain_api_error(detail):
    lowered = detail.lower()
    markers = (
        "forbidden",
        "nopermission",
        "no permission",
        "not authorized",
        "unauthorized",
        "invalidaction",
        "accessdenied",
    )
    if any(marker in lowered for marker in markers):
        return detail + "\nOAuth login finished, but the official-cli scope or this user's RAM permission does not include this API."
    return detail


def aliyun(profile, region, args):
    command = [aliyun_bin(), *args, "--profile", profile, "--config-path", aliyun_config_path()]
    if region:
        command.extend(["--region", region])
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return None, "aliyun call timed out (%d seconds)" % COMMAND_TIMEOUT_SECONDS
    except OSError as exc:
        return None, "aliyun call failed (%s)" % exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        return None, explain_api_error(detail or "aliyun call failed")
    text = result.stdout.strip()
    if not text:
        return {}, ""
    try:
        return json.loads(text), ""
    except json.JSONDecodeError:
        return None, text


def paginate(profile, region, base_args, list_key):
    items = []
    token = ""
    seen_tokens = set()
    while len(seen_tokens) < 20:
        args = list(base_args)
        if token:
            if token in seen_tokens:
                break
            seen_tokens.add(token)
            args.extend(["--next-token", token])
        data, err = aliyun(profile, region, args)
        if data is None:
            return None, err
        batch = data.get(list_key) or []
        if isinstance(batch, list):
            items.extend(batch)
        token = str(data.get("nextToken") or "")
        if not token:
            break
    return items, ""


def list_region_ids(profile):
    # describe-regions 必须带一个调用入口。这里的 cn-hangzhou 只用来拉取地域列表，不是 AgentSpace 的地域。
    regions, err = paginate(
        profile,
        "cn-hangzhou",
        ["agentloop", "describe-regions", "--language", "zh", "--biz-language", "zh", "--max-results", "50"],
        "regions",
    )
    if regions is None:
        fail(err)
    ids = []
    for item in regions:
        if isinstance(item, dict) and item.get("regionId"):
            ids.append(str(item["regionId"]))
    if not ids:
        fail("describe-regions returned no regions")
    return ids


def list_spaces(profile, region):
    region_ids = [region] if region else list_region_ids(profile)
    found = []
    seen = set()
    errors = []
    for region_id in region_ids:
        spaces, err = paginate(
            profile,
            region_id,
            ["agentloop", "list-agent-spaces", "--max-results", "50"],
            "agentSpaces",
        )
        if spaces is None:
            if "RAM permission" in err:
                fail(err)
            errors.append(err)
            continue
        for item in spaces:
            if not isinstance(item, dict) or not item.get("agentSpace"):
                continue
            item["regionId"] = item.get("regionId") or region_id
            key = (item["agentSpace"], item["regionId"])
            if key in seen:
                continue
            seen.add(key)
            found.append(item)
    if not found and errors:
        fail(errors[0])
    return found, errors


def choose_space(spaces, region):
    # Qoder 对话框里执行时 stdin 不是终端。stdout 每行只有 agentSpace 和 regionId。
    previous_name, previous_region = saved_space()
    if not sys.stdin.isatty():
        if previous_name:
            print("previous %s %s" % (previous_name, previous_region))
        for item in spaces:
            print("%s %s" % (item.get("agentSpace", ""), item.get("regionId", region)))
        sys.exit(EXIT_CHOOSE_AGENT_SPACE)
    if len(spaces) > 1:
        print("Multiple AgentSpaces found. Enter a number:", file=sys.stderr)
    else:
        print("One AgentSpace found. Enter 1 to confirm.", file=sys.stderr)
    if previous_name:
        print("Previous choice %s %s" % (previous_name, previous_region), file=sys.stderr)
    for index, item in enumerate(spaces, 1):
        print("%d. %s %s" % (index, item.get("agentSpace", ""), item.get("regionId", region)), file=sys.stderr)
    line = input("> ").strip()
    if not line.isdigit() or not 1 <= int(line) <= len(spaces):
        fail("Invalid AgentSpace number")
    return spaces[int(line) - 1]


def get_space(profile, agent_space, region):
    if agent_space:
        if not region:
            fail("Pass --region. Choosing an AgentSpace requires its region. Do not use a default region.")
        data, err = aliyun(profile, region, ["agentloop", "get-agent-space", "--agent-space", agent_space])
        if data is None:
            fail(err)
        if not data.get("agentSpace"):
            fail("get-agent-space did not return agentSpace")
        return data
    spaces, errors = list_spaces(profile, region)
    if not spaces:
        fail("No AgentSpace found")
    # A failed region may hide the user's real space. Do not keep the only survivor.
    if errors or len(spaces) > 1:
        for err in errors:
            print(err, file=sys.stderr)
        return choose_space(spaces, region)
    return spaces[0]


def get_observability(profile, region, workspace):
    # CLI 3.5.1 的本地元数据不认 Get/CreateServiceObservability 这个名字，
    # 命名调用会报 not a valid api。按 2024-03-30 的路径发，并加 --force。
    path = "/workspace/%s/service-observability/apm" % workspace
    get_args = ["cms", "GET", path, "--version", CMS_VERSION, "--force"]
    data, err = aliyun(profile, region, get_args)
    info = (data or {}).get("entryPointInfo") if isinstance(data, dict) else None
    if isinstance(info, dict) and info.get("authToken"):
        return info
    created, create_err = aliyun(profile, region, [
        "cms", "POST", path, "--version", CMS_VERSION, "--force",
    ])
    if created is None and data is None:
        fail(create_err or err)
    for _ in range(OBSERVABILITY_RETRIES):
        time.sleep(2)
        data, err = aliyun(profile, region, get_args)
        info = (data or {}).get("entryPointInfo") if isinstance(data, dict) else None
        if isinstance(info, dict) and info.get("authToken"):
            return info
    fail(err or "GetServiceObservability has not returned authToken")


def get_api_key(profile, region, project):
    get_args = ["sls", "GetApiKey", "--project", project, "--apiKeyName", API_KEY_NAME]
    data, err = aliyun(profile, region, get_args)
    if isinstance(data, dict) and data.get("apiKey"):
        return data["apiKey"]
    if data is None and "ApiKeyNotExist" not in err:
        fail(err)
    body = json.dumps({
        "apiKeyName": API_KEY_NAME,
        "description": "loongsuite-pilot log ingestion",
        "allowedStores": [DEFAULT_LOGSTORE],
    }, ensure_ascii=False)
    created, create_err = aliyun(profile, region, [
        "sls", "CreateApiKey",
        "--project", project,
        "--body", body,
    ])
    if created is None:
        fail(create_err)
    data, get_err = aliyun(profile, region, get_args)
    if isinstance(data, dict) and data.get("apiKey"):
        return data["apiKey"]
    fail(get_err or "CreateApiKey did not return the secret")


def get_logs(profile, context, query, start, end, line, offset):
    # CLI 3.5.1 里 GetLogs 已废弃，--from 不是它的参数。GetLogsV2 把时间范围和查询语句放在 body。
    region = context.get("regionId") or ""
    body = json.dumps({
        "from": start,
        "to": end,
        "query": query,
        "line": line,
        "offset": offset,
        "reverse": True,
    }, ensure_ascii=False)
    data, err = aliyun(profile, region, [
        "sls", "GetLogsV2",
        "--version", SLS_VERSION,
        "--project", context["slsProject"],
        "--logstore", context["slsLogstore"],
        "--body", body,
    ])
    if data is None:
        fail(err)
    return data
