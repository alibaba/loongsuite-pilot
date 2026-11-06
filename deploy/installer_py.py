#!/usr/bin/env python3
"""JSON helpers for the open-source installer. Replaces the former node -e blocks."""

import json
import os
import re
import shutil
import sys
from pathlib import Path


def _read_text(path):
    raw = Path(path).read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    return raw.decode("utf-8")


def _load_json(path):
    return json.loads(_read_text(path))


def _dump(path, data, mode=None):
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    target = Path(path)
    tmp = target.with_name(target.name + f".{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    if mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, target)


def _stdin_json():
    raw = sys.stdin.read()
    if not raw.strip():
        return []
    return json.loads(raw)


def _csv(value):
    if value is None:
        return []
    if isinstance(value, list):
        parts = value
    else:
        parts = str(value).split(",")
    return [str(item).strip() for item in parts if str(item).strip()]


def _unique(items):
    seen = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen


INTERCEPTOR_TYPES = ["cloudAccessKey", "apiKey", "privateKey", "databaseUrl"]
# 这里只保存环境变量名称，实际凭据由安装环境提供。
CMS_AUTH_ENV = "LP_CMS_LICENSE_KEY"


def cmd_probe_count():
    data = _stdin_json()
    sys.stdout.write(str(len(data) if isinstance(data, list) else 0))


def cmd_probe_detected():
    data = _stdin_json()
    ids = [item.get("id", "") for item in data if item.get("detected") and item.get("id")]
    sys.stdout.write(",".join(ids))


def cmd_probe_menu():
    data = _stdin_json()
    lang = sys.argv[2] if len(sys.argv) > 2 else "en"
    defaults = []
    for index, agent in enumerate(data):
        reason = agent.get("reason") or ""
        if lang == "zh":
            status = ("已检测到: " + reason) if agent.get("detected") else ("未检测到" + (": " + reason if reason else ""))
        else:
            status = ("detected: " + reason) if agent.get("detected") else ("not detected" + (": " + reason if reason else ""))
        name = str(agent.get("displayName") or "")
        print(f"    [{index + 1}] {name.ljust(16)}({status})")
        if agent.get("detected"):
            defaults.append(str(index + 1))
    print("")
    if lang == "zh":
        print("    默认选择已检测到的 Agent: " + ",".join(defaults))
        print("    输入要启用的编号 (逗号分隔)，直接回车使用默认:")
    else:
        print("    Default selection (detected): " + ",".join(defaults))
        print("    Enter numbers to enable (comma-separated), press Enter for default:")


def cmd_probe_select():
    data = _stdin_json()
    raw = sys.argv[2] if len(sys.argv) > 2 else ""
    raw = re.sub(r"[，、；]", ",", raw)
    if not raw.strip():
        indices = [index for index, agent in enumerate(data) if agent.get("detected")]
    else:
        numbers = []
        for part in re.split(r"[\s,]+", raw.strip()):
            if not part:
                continue
            try:
                number = int(part)
            except ValueError:
                continue
            if 1 <= number <= len(data) and number not in numbers:
                numbers.append(number)
        indices = sorted(number - 1 for number in numbers)
    sys.stdout.write(",".join(str(data[index].get("id") or "") for index in indices))


def cmd_read_user_id():
    try:
        config = _load_json(sys.argv[2])
    except (OSError, json.JSONDecodeError):
        return
    value = config.get("userId") or ""
    sys.stdout.write(str(value))


def cmd_json_argv():
    args = sys.argv[2:]
    if args and args[0] == "--":
        args = args[1:]
    print(json.dumps(args, ensure_ascii=False))


def _sls_mode(sls):
    if not isinstance(sls, dict):
        return ""
    if sls.get("mode"):
        return sls["mode"]
    if sls.get("apiKey"):
        return "apiKey"
    if sls.get("accessKeyId") or sls.get("accessKeySecret"):
        return "ak"
    return ""


def cmd_config_diffs():
    try:
        old = _load_json(sys.argv[2])
    except (OSError, json.JSONDecodeError):
        return
    new = json.loads(sys.argv[3])
    interceptor_mode = new.get("interceptorMode") or (old.get("interceptor") or {}).get("mode") or ""
    if interceptor_mode == "all":
        interceptor_types = list(INTERCEPTOR_TYPES)
    elif interceptor_mode == "custom":
        source = new.get("interceptorTypes") if new.get("interceptorMode") else ",".join((old.get("interceptor") or {}).get("types") or [])
        interceptor_types = [item for item in _csv(source) if item in INTERCEPTOR_TYPES]
    else:
        interceptor_types = []
    mask_mode = new.get("maskMode") or (old.get("mask") or {}).get("mode") or ""
    if mask_mode == "custom":
        source = new.get("maskTypes") if new.get("maskMode") else ",".join((old.get("mask") or {}).get("types") or [])
        mask_types = _csv(source)
    else:
        mask_types = []
    covered_mode = "custom" if interceptor_types and mask_mode != "all" else mask_mode
    covered_types = _unique(mask_types + interceptor_types) if covered_mode == "custom" else []
    old_mask = old.get("mask") or {}
    checks = [
        ("sls.endpoint", (old.get("sls") or {}).get("endpoint") or "", new.get("slsEndpoint")),
        ("sls.project", (old.get("sls") or {}).get("project") or "", new.get("slsProject")),
        ("sls.logstore", (old.get("sls") or {}).get("logstore") or "", new.get("slsLogstore")),
        ("sls.mode", _sls_mode(old.get("sls")), new.get("slsMode")),
        ("cms.licenseKey", (old.get("cms") or {}).get("licenseKey") or "", new.get("cmsLicenseKey")),
        ("cms.endpoint", (old.get("cms") or {}).get("endpoint") or "", new.get("cmsEndpoint")),
        ("cms.workspace", (old.get("cms") or {}).get("workspace") or "", new.get("cmsWorkspace")),
        ("serviceNamePrefix", old.get("serviceNamePrefix") or "", new.get("serviceNamePrefix")),
        ("dashboard.port", (old.get("dashboard") or {}).get("port") or "", int(new["dashboardPort"]) if new.get("dashboardPort") else ""),
        ("mask.mode", old_mask.get("mode") or "", covered_mode),
        ("mask.types", ",".join(_csv(old_mask.get("types"))) if old_mask.get("mode") == "custom" and isinstance(old_mask.get("types"), list) else "", ",".join(covered_types)),
        ("mask.replacementMode", old_mask.get("replacementMode") or "", new.get("maskReplacementMode")),
        ("interceptor.mode", (old.get("interceptor") or {}).get("mode") or "", new.get("interceptorMode")),
        ("interceptor.types", ",".join(_csv((old.get("interceptor") or {}).get("types"))) if isinstance((old.get("interceptor") or {}).get("types"), list) else "", ",".join(_csv(new.get("interceptorTypes")))),
        ("multimodal.storage.type", ((old.get("multimodal") or {}).get("storage") or {}).get("type") or "", "sls" if new.get("multimodalMode") and new.get("multimodalMode") != "none" and new.get("slsEndpoint") and new.get("slsProject") and new.get("slsLogstore") and new.get("slsMode") == "apiKey" else ""),
    ]
    for label, old_val, new_val in checks:
        if new_val and old_val and new_val != old_val:
            print(f"{label}: {old_val} -> {new_val}")


def _env(name):
    return os.environ.get(name, "")


def cmd_write_config_opts():
    raw = Path(sys.argv[2]).read_text(encoding="utf-8-sig")
    opts = json.loads(raw)
    mapping = {
        "configPath": "LP_CONFIG_PATH",
        "dataDir": "LP_DATA_DIR",
        "dashboardPort": "LP_DASHBOARD_PORT",
        "slsEndpoint": "LP_SLS_ENDPOINT",
        "slsProject": "LP_SLS_PROJECT",
        "slsLogstore": "LP_SLS_LOGSTORE",
        "slsAkId": "LP_SLS_AK_ID",
        "slsAkSecret": "LP_SLS_AK_SECRET",
        "slsApiKey": "LP_SLS_API_KEY",
        "logLevel": "LP_LOG_LEVEL",
        "userId": "LP_USER_ID",
        "collectLog": "LP_COLLECT_LOG",
        "collectTrace": "LP_COLLECT_TRACE",
        "enableStatusBarApp": "LP_ENABLE_STATUS_BAR_APP",
        "cmsLicenseKey": CMS_AUTH_ENV,
        "cmsEndpoint": "LP_CMS_ENDPOINT",
        "cmsWorkspace": "LP_CMS_WORKSPACE",
        "serviceNamePrefix": "LP_SERVICE_NAME_PREFIX",
        "selectedAgents": "LP_SELECTED_AGENTS",
        "allAgentsMode": "LP_ALL_AGENTS",
        "multimodalMode": "LP_MULTIMODAL_MODE",
        "multimodalSupportedAgents": "LP_MULTIMODAL_SUPPORTED_AGENTS",
        "agentSelectionExplicit": "LP_AGENT_SELECTION_EXPLICIT",
        "maskMode": "LP_MASK_MODE",
        "maskTypes": "LP_MASK_TYPES",
        "maskReplacementMode": "LP_MASK_REPLACEMENT_MODE",
        "interceptorMode": "LP_INTERCEPTOR_MODE",
        "interceptorTypes": "LP_INTERCEPTOR_TYPES",
    }
    for key, env_name in mapping.items():
        value = opts.get(key)
        os.environ[env_name] = "" if value is None else str(value)
    exclude = opts.get("excludeWorkspaces") or []
    if isinstance(exclude, list) and exclude:
        for value in exclude:
            if not isinstance(value, str) or not os.path.isabs(value):
                sys.stderr.write("-ExcludeWorkspace requires absolute local directories\n")
                sys.exit(1)
        os.environ["LP_EXCLUDE_WORKSPACES"] = json.dumps(exclude)
    else:
        os.environ["LP_EXCLUDE_WORKSPACES"] = ""
    probe = opts.get("probeResult") or "[]"
    if not isinstance(probe, str):
        probe = json.dumps(probe)
    import io
    saved = sys.stdin
    sys.stdin = io.StringIO(probe)
    try:
        cmd_write_config()
    finally:
        sys.stdin = saved


def cmd_write_config():
    path = _env("LP_CONFIG_PATH")
    try:
        existing = _load_json(path)
        if not isinstance(existing, dict):
            existing = {}
    except (OSError, json.JSONDecodeError):
        existing = {}
    config = dict(existing)
    config["enabled"] = True
    config["dataDir"] = _env("LP_DATA_DIR")
    dashboard = config.get("dashboard")
    if not isinstance(dashboard, dict):
        config["dashboard"] = {}
    exclude = _env("LP_EXCLUDE_WORKSPACES")
    if exclude:
        privacy = config.get("privacy") if isinstance(config.get("privacy"), dict) else {}
        privacy = dict(privacy)
        privacy["excludeWorkspaces"] = json.loads(exclude)
        config["privacy"] = privacy
    dashboard_port = _env("LP_DASHBOARD_PORT")
    status_bar = _env("LP_ENABLE_STATUS_BAR_APP")
    if status_bar:
        config["enableStatusBarApp"] = status_bar == "true"
    if dashboard_port:
        config["dashboard"]["port"] = int(dashboard_port)
    if "port" not in config["dashboard"]:
        config["dashboard"]["port"] = 8765
    config.pop("internal", None)
    if "userId" not in config and "user.id" in config:
        config["userId"] = config["user.id"]
    config.pop("user.id", None)

    sls_endpoint = _env("LP_SLS_ENDPOINT")
    sls_project = _env("LP_SLS_PROJECT")
    sls_logstore = _env("LP_SLS_LOGSTORE")
    sls_ak_id = _env("LP_SLS_AK_ID")
    sls_ak_secret = _env("LP_SLS_AK_SECRET")
    sls_api_key = _env("LP_SLS_API_KEY")
    if sls_endpoint or sls_project or sls_logstore or sls_api_key:
        sls = dict(config.get("sls") or {}) if isinstance(config.get("sls"), dict) else {}
        sls.pop("destinationOverride", None)
        if sls_endpoint:
            sls["endpoint"] = sls_endpoint
        if sls_api_key:
            sls["mode"] = "apiKey"
            sls["apiKey"] = sls_api_key
            sls.pop("accessKeyId", None)
            sls.pop("accessKeySecret", None)
        elif sls_ak_id and sls_ak_secret:
            sls["mode"] = "ak"
            sls["accessKeyId"] = sls_ak_id
            sls["accessKeySecret"] = sls_ak_secret
            sls.pop("apiKey", None)
        elif sls_endpoint or sls_project or sls_logstore:
            sls["mode"] = "webtracking"
            sls.pop("apiKey", None)
            sls.pop("accessKeyId", None)
            sls.pop("accessKeySecret", None)
        if sls_project and sls_logstore:
            sls["project"] = sls_project
            sls["logstore"] = sls_logstore
            sls.pop("endpoints", None)
        config["sls"] = sls
    if _env("LP_LOG_LEVEL"):
        config["logLevel"] = _env("LP_LOG_LEVEL")
    if _env("LP_USER_ID"):
        config["userId"] = _env("LP_USER_ID")
        config.pop("identity", None)
    if _env("LP_COLLECT_LOG"):
        config["collectLog"] = _env("LP_COLLECT_LOG") == "true"
    if _env("LP_COLLECT_TRACE"):
        config["collectTrace"] = _env("LP_COLLECT_TRACE") == "true"
    if _env("LP_CMS_LICENSE_KEY") or _env("LP_CMS_ENDPOINT") or _env("LP_CMS_WORKSPACE"):
        cms = dict(config.get("cms") or {}) if isinstance(config.get("cms"), dict) else {}
        if _env("LP_CMS_LICENSE_KEY"):
            cms["licenseKey"] = _env("LP_CMS_LICENSE_KEY")
        if _env("LP_CMS_ENDPOINT"):
            cms["endpoint"] = _env("LP_CMS_ENDPOINT")
        if _env("LP_CMS_WORKSPACE"):
            cms["workspace"] = _env("LP_CMS_WORKSPACE")
        config["cms"] = cms
    if _env("LP_SERVICE_NAME_PREFIX"):
        config["serviceNamePrefix"] = _env("LP_SERVICE_NAME_PREFIX")
    mask_mode = _env("LP_MASK_MODE")
    if mask_mode:
        mask = dict(config.get("mask") or {}) if isinstance(config.get("mask"), dict) else {}
        mask["mode"] = mask_mode
        if mask_mode == "custom":
            mask["types"] = _csv(_env("LP_MASK_TYPES"))
        else:
            mask.pop("types", None)
        config["mask"] = mask
    if _env("LP_MASK_REPLACEMENT_MODE"):
        mask = dict(config.get("mask") or {}) if isinstance(config.get("mask"), dict) else {}
        mask["replacementMode"] = _env("LP_MASK_REPLACEMENT_MODE")
        config["mask"] = mask
    interceptor_mode = _env("LP_INTERCEPTOR_MODE")
    if interceptor_mode:
        interceptor = dict(config.get("interceptor") or {}) if isinstance(config.get("interceptor"), dict) else {}
        interceptor["mode"] = interceptor_mode
        if interceptor_mode == "custom":
            interceptor["types"] = _csv(_env("LP_INTERCEPTOR_TYPES"))
        else:
            interceptor.pop("types", None)
        config["interceptor"] = interceptor
    interceptor = config.get("interceptor") or {}
    extra = list(INTERCEPTOR_TYPES) if interceptor.get("mode") == "all" else []
    if interceptor.get("mode") == "custom" and isinstance(interceptor.get("types"), list):
        extra = [item for item in interceptor["types"] if item in INTERCEPTOR_TYPES]
    if extra and (config.get("mask") or {}).get("mode") != "all":
        current = []
        mask = config.get("mask") if isinstance(config.get("mask"), dict) else {}
        if mask.get("mode") == "custom" and isinstance(mask.get("types"), list):
            current = [item for item in mask["types"] if isinstance(item, str) and item.strip()]
        mask = dict(mask)
        mask["mode"] = "custom"
        mask["types"] = _unique(current + extra)
        config["mask"] = mask

    try:
        agents = _stdin_json()
    except json.JSONDecodeError:
        agents = []
    if not isinstance(agents, list):
        agents = []
    selected = _csv(_env("LP_SELECTED_AGENTS"))
    if _env("LP_ALL_AGENTS") == "1":
        for agent in (config.get("agents") or {}).values():
            if isinstance(agent, dict):
                agent.pop("enabled", None)
    elif selected:
        config["agents"] = config.get("agents") if isinstance(config.get("agents"), dict) else {}
        previous_openclaw = config["agents"].get("openclaw")
        for agent in agents:
            agent_id = agent.get("id")
            if not agent_id:
                continue
            config["agents"][agent_id] = config["agents"].get(agent_id) if isinstance(config["agents"].get(agent_id), dict) else {}
            if agent_id == "openclaw" and not agent.get("detected") and _env("LP_AGENT_SELECTION_EXPLICIT") != "1" and previous_openclaw is not None:
                print("OpenClaw: detection unavailable; preserving previous enabled state and entry")
                continue
            config["agents"][agent_id]["enabled"] = agent_id in selected
    openclaw = next((agent for agent in agents if agent.get("id") == "openclaw"), None)
    if openclaw and openclaw.get("detected") and openclaw.get("openclawCliPath") and (
        _env("LP_ALL_AGENTS") == "1" or ((config.get("agents") or {}).get("openclaw") or {}).get("enabled") is not False
    ):
        config["agents"] = config.get("agents") if isinstance(config.get("agents"), dict) else {}
        slot = config["agents"].get("openclaw") if isinstance(config["agents"].get("openclaw"), dict) else {}
        previous = slot.get("cliPath")
        if isinstance(previous, str) and previous != openclaw["openclawCliPath"]:
            print("OpenClaw: updating launch entry " + json.dumps(previous) + " -> " + json.dumps(openclaw["openclawCliPath"]))
        slot["cliPath"] = openclaw["openclawCliPath"]
        config["agents"]["openclaw"] = slot
    multimodal = _env("LP_MULTIMODAL_MODE")
    if multimodal:
        config["agents"] = config.get("agents") if isinstance(config.get("agents"), dict) else {}
        supported = _csv(_env("LP_MULTIMODAL_SUPPORTED_AGENTS"))
        selected_set = set(selected)
        all_supported = _env("LP_ALL_AGENTS") == "1" and multimodal != "none"
        for agent_id in supported:
            if all_supported:
                config["agents"][agent_id] = config["agents"].get(agent_id) if isinstance(config["agents"].get(agent_id), dict) else {}
            elif agent_id not in config["agents"]:
                continue
            if multimodal == "none":
                config["agents"][agent_id].pop("multimodal", None)
                continue
            prev = config["agents"][agent_id].get("multimodal")
            prev = dict(prev) if isinstance(prev, dict) else {}
            prev["uploadMode"] = multimodal if all_supported or agent_id in selected_set else "none"
            config["agents"][agent_id]["multimodal"] = prev
    if multimodal and multimodal != "none" and sls_endpoint and sls_project and sls_logstore and sls_api_key:
        config["multimodal"] = {"storage": {"type": "sls", "target": {"endpoint": sls_endpoint, "project": sls_project, "logstore": sls_logstore}}}
    _dump(path, config)


def cmd_strip_otel_hooks():
    path = sys.argv[2]
    try:
        data = _load_json(path)
    except (OSError, json.JSONDecodeError):
        return
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        return

    def ours(command):
        return isinstance(command, str) and ("otel-claude-hook" in command or "hook-entry.sh" in command)

    for event in list(hooks):
        entries = hooks.get(event)
        if not isinstance(entries, list):
            continue
        kept = []
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
                kept.append(entry)
                continue
            entry["hooks"] = [hook for hook in entry["hooks"] if not (isinstance(hook, dict) and ours(hook.get("command")))]
            if entry["hooks"]:
                kept.append(entry)
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    if not hooks:
        data.pop("hooks", None)
    _dump(path, data)


def cmd_strip_otel_config():
    path = sys.argv[2]
    try:
        data = _load_json(path)
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(data, dict):
        return
    for key in ("log_enabled", "log_dir", "log_filename_format"):
        data.pop(key, None)
    _dump(path, data)


def cmd_reject_multi_sls():
    try:
        config = _load_json(sys.argv[2])
    except (OSError, json.JSONDecodeError):
        sys.exit(13)
    sys.exit(12 if isinstance(config.get("sls"), list) else 0)


def _pilot_codex(command, marker):
    if not isinstance(command, str) or marker not in command:
        return False
    return re.search(r"(^|[ /])codex-loongsuite-pilot-hook[.](sh|mjs|ps1)([^A-Za-z0-9_.-]|$)", command, re.I) is not None


def cmd_clean_hooks():
    path, marker = sys.argv[2], sys.argv[3]
    data = _load_json(path)
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        return
    changed = False
    is_codex = path.endswith("/.codex/hooks.json") or path.endswith("\\.codex\\hooks.json")
    for event, entries in list(hooks.items()):
        if not isinstance(entries, list):
            continue
        if is_codex:
            kept = []
            for entry in entries:
                if not isinstance(entry, dict):
                    kept.append(entry)
                    continue
                if _pilot_codex(entry.get("command"), marker):
                    changed = True
                    continue
                nested = entry.get("hooks")
                if not isinstance(nested, list):
                    kept.append(entry)
                    continue
                filtered = [hook for hook in nested if not _pilot_codex((hook or {}).get("command") if isinstance(hook, dict) else None, marker)]
                if len(filtered) == len(nested):
                    kept.append(entry)
                    continue
                changed = True
                if filtered:
                    clone = dict(entry)
                    clone["hooks"] = filtered
                    kept.append(clone)
        else:
            kept = []
            for entry in entries:
                command = entry.get("command") if isinstance(entry, dict) else ""
                nested = entry.get("hooks") if isinstance(entry, dict) and isinstance(entry.get("hooks"), list) else []
                marked = (isinstance(command, str) and marker in command) or any(isinstance(hook, dict) and marker in str(hook.get("command") or "") for hook in nested)
                if marked:
                    changed = True
                    continue
                kept.append(entry)
        if not kept:
            del hooks[event]
            changed = True
        else:
            hooks[event] = kept
    if changed:
        _dump(path, data)
        sys.stdout.write("cleaned")
    else:
        sys.stdout.write("skip")


def cmd_state_abs():
    state_path, key_path = sys.argv[2], sys.argv[3]
    try:
        state = _load_json(state_path)
    except (OSError, json.JSONDecodeError):
        return
    cursor = state
    for part in key_path.split("."):
        if not isinstance(cursor, dict):
            return
        cursor = cursor.get(part)
    if isinstance(cursor, str) and os.path.isabs(cursor):
        sys.stdout.write(cursor)


def _owned_grok(value):
    return isinstance(value, str) and re.search(r"(?:^|[\\/])grok-build-loongsuite-pilot-hook\.(?:sh|ps1)(?:\"|\s|$)", value, re.I) is not None


def cmd_clean_grok():
    path = sys.argv[2]
    try:
        data = _load_json(path)
    except (OSError, json.JSONDecodeError) as error:
        sys.stderr.write(str(error))
        sys.exit(1)
    hooks = data.get("hooks") if isinstance(data, dict) else None
    if not isinstance(hooks, dict):
        sys.stdout.write("nochange")
        return
    changed = False
    for event, entries in list(hooks.items()):
        if not isinstance(entries, list):
            continue
        kept = []
        for entry in entries:
            if _owned_grok(entry.get("command") if isinstance(entry, dict) else None):
                changed = True
                continue
            if isinstance(entry, dict) and isinstance(entry.get("hooks"), list):
                nested = [hook for hook in entry["hooks"] if not _owned_grok(hook.get("command") if isinstance(hook, dict) else None)]
                if len(nested) != len(entry["hooks"]):
                    changed = True
                if entry["hooks"] and not nested:
                    continue
                clone = dict(entry)
                clone["hooks"] = nested
                kept.append(clone)
            else:
                kept.append(entry)
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    if not changed:
        sys.stdout.write("nochange")
        return
    if not hooks:
        data.pop("hooks", None)
    if not data:
        os.remove(path)
    else:
        _dump(path, data, 0o600)
    sys.stdout.write("cleaned")


def _strip_jsonc(text):
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    text = re.sub(r"^\s*//.*$", "", text, flags=re.M)
    text = re.sub(r"[ \t]+//.*$", "", text, flags=re.M)
    return text


def cmd_clean_plugin_array():
    path, needle_a, needle_b = sys.argv[2], sys.argv[3], sys.argv[4]

    def ours(value):
        return isinstance(value, str) and (needle_a in value or needle_b in value)

    def entry_str(entry):
        if isinstance(entry, str):
            return entry
        if isinstance(entry, list) and entry:
            return str(entry[0])
        return ""

    try:
        raw = _read_text(path)
        had_comments = False
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = json.loads(_strip_jsonc(raw))
            had_comments = True
        key = "plugins" if isinstance(data.get("plugins"), list) else ("plugin" if isinstance(data.get("plugin"), list) else None)
        if key is None:
            sys.stdout.write("nochange")
            return
        before = len(data[key])
        data[key] = [entry for entry in data[key] if not ours(entry_str(entry))]
        if len(data[key]) == before:
            sys.stdout.write("nochange")
            return
        if had_comments:
            Path(path + ".bak").write_text(raw, encoding="utf-8")
        _dump(path, data)
        sys.stdout.write("cleaned-bak" if had_comments else "cleaned")
    except (OSError, json.JSONDecodeError) as error:
        sys.stderr.write(str(error))
        sys.exit(1)


def cmd_hermes_target():
    state_file, default = sys.argv[2], sys.argv[3]
    target = default
    try:
        state = _load_json(state_file)
        recorded = (state.get("hermes-agent") or {}).get("targetDir")
        if isinstance(recorded, str) and os.path.isabs(recorded):
            target = recorded
    except (OSError, json.JSONDecodeError):
        pass
    sys.stdout.write(target)


def cmd_hermes_ownership():
    marker = Path(sys.argv[2]) / ".loongsuite-pilot-managed.json"
    try:
        meta = _load_json(marker)
    except (OSError, json.JSONDecodeError) as error:
        sys.stderr.write(str(error))
        sys.exit(1)
    if meta.get("owner") == "loongsuite-pilot" and meta.get("agentId") == "hermes-agent":
        sys.stdout.write("owned")
    else:
        sys.stdout.write("unmanaged")


def cmd_hermes_remove():
    directory = Path(sys.argv[2])
    marker = directory / ".loongsuite-pilot-managed.json"
    try:
        meta = _load_json(marker)
    except (OSError, json.JSONDecodeError) as error:
        sys.stderr.write(str(error))
        sys.exit(1)
    if meta.get("owner") != "loongsuite-pilot" or meta.get("agentId") != "hermes-agent":
        sys.stdout.write("unmanaged")
        return
    shutil.rmtree(directory, ignore_errors=False)
    sys.stdout.write("cleaned")


def _strip_jsonc_strings(text):
    result = []
    index = 0
    in_string = False
    escape = False
    while index < len(text):
        ch = text[index]
        if in_string:
            result.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            index += 1
            continue
        if ch == '"':
            in_string = True
            result.append(ch)
            index += 1
            continue
        if ch == "/" and index + 1 < len(text) and text[index + 1] == "/":
            index += 2
            while index < len(text) and text[index] != "\n":
                index += 1
            continue
        if ch == "/" and index + 1 < len(text) and text[index + 1] == "*":
            index += 2
            while index + 1 < len(text) and not (text[index] == "*" and text[index + 1] == "/"):
                index += 1
            index += 2
            continue
        result.append(ch)
        index += 1
    return "".join(result)


def _resolve_value(value, data_dir):
    if not isinstance(value, str):
        return value
    home = os.environ.get("HOME", "")
    value = re.sub(r"^~(?=[\\/])", home, value)
    return value.replace("$PILOT_DATA", data_dir)


def cmd_clean_pi():
    default_config, data_dir = sys.argv[2], sys.argv[3]
    targets = [{"configPath": default_config, "markers": ["loongsuite-pilot-pi-coding-agent", "plugins/pi-coding-agent/index.mjs"]}]
    local_dir = Path(data_dir) / "agents.d.local"
    try:
        if local_dir.is_dir():
            for name in local_dir.iterdir():
                if name.suffix != ".json":
                    continue
                try:
                    definition = _load_json(name)
                except (OSError, json.JSONDecodeError):
                    continue
                pi_sdk = definition.get("piSdk") or {}
                inject = definition.get("pluginInject") or {}
                plugin_id = inject.get("pluginId") or ""
                if pi_sdk.get("schemaVersion") != 1 or not str(plugin_id).startswith("loongsuite-pilot-pi-sdk-"):
                    continue
                spec = _resolve_value(inject.get("pluginSpec"), data_dir)
                markers = [item for item in (plugin_id, spec, "plugins/pi-coding-agent/agents/") if item]
                for config_path in inject.get("configPaths") or []:
                    targets.append({"configPath": _resolve_value(config_path, data_dir), "markers": markers})
        cleaned = 0
        skipped = 0
        for target in targets:
            config_path = target["configPath"]
            if not config_path or not os.path.exists(config_path):
                continue
            try:
                raw = _read_text(config_path)
                data = json.loads(_strip_jsonc_strings(raw))
                if not isinstance(data.get("extensions"), list):
                    continue
                before = len(data["extensions"])

                def keep(entry, markers=target["markers"]):
                    value = entry.replace("\\", "/") if isinstance(entry, str) else ""
                    return not any(value == str(marker).replace("\\", "/") or str(marker).replace("\\", "/") in value for marker in markers)

                data["extensions"] = [entry for entry in data["extensions"] if keep(entry)]
                if len(data["extensions"]) == before:
                    continue
                rendered = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
                if raw != rendered:
                    backup = config_path + ".bak"
                    if not os.path.exists(backup):
                        shutil.copyfile(config_path, backup)
                Path(config_path).write_text(rendered, encoding="utf-8")
                cleaned += 1
            except (OSError, json.JSONDecodeError):
                skipped += 1
        if cleaned and skipped:
            sys.stdout.write("partial")
        elif cleaned:
            sys.stdout.write("cleaned")
        elif skipped:
            sys.stdout.write("skipped")
        else:
            sys.stdout.write("nochange")
    except OSError as error:
        sys.stderr.write(str(error))
        sys.exit(1)


def _openclaw_ours(value, managed):
    text = value if isinstance(value, str) else (value[0] if isinstance(value, list) and value and isinstance(value[0], str) else "")
    normalized = text.replace("\\", "/")
    plain = normalized[len("file://"):] if normalized.startswith("file://") else normalized
    return plain == managed or plain == managed + "/plugin.mjs" or "loongsuite-pilot-openclaw" in normalized or ("plugins/openclaw/plugin.mjs" in normalized and ".loongsuite-pilot/" in plain)


def cmd_clean_openclaw():
    path = os.environ["PILOT_OC_CONFIG"]
    managed = os.environ["PILOT_OC_MANAGED"].replace("\\", "/")
    try:
        data = _load_json(path)
    except (OSError, json.JSONDecodeError) as error:
        sys.stderr.write(str(error))
        sys.exit(1)
    changed = False
    for key in ("plugin", "plugins"):
        if not isinstance(data.get(key), list):
            continue
        filtered = [value for value in data[key] if not _openclaw_ours(value, managed)]
        if len(filtered) != len(data[key]):
            data[key] = filtered
            changed = True
    plugins = data.get("plugins")
    if isinstance(plugins, dict):
        load = plugins.get("load")
        if isinstance(load, dict) and isinstance(load.get("paths"), list):
            filtered = [value for value in load["paths"] if not _openclaw_ours(value, managed)]
            if len(filtered) != len(load["paths"]):
                load["paths"] = filtered
                changed = True
        entries = plugins.get("entries")
        if isinstance(entries, dict) and "loongsuite-pilot-openclaw" in entries:
            del entries["loongsuite-pilot-openclaw"]
            changed = True
    if not changed:
        sys.stdout.write("nochange")
        return
    _dump(path, data)
    sys.stdout.write("cleaned")


def _marker_offsets(data, marker):
    needle = marker.encode()
    offsets = []
    start = 0
    while start < len(data):
        index = data.find(needle, start)
        if index < 0:
            break
        at_line = index == 0 or data[index - 1] == 0x0A
        next_index = index + len(needle)
        boundary = next_index == len(data) or data[next_index] in (0x20, 0x09, 0x0D, 0x0A)
        if at_line and boundary:
            offsets.append(index)
        start = next_index
    return offsets


def cmd_dsh_cleanup():
    patch = None
    plugin_dir = None
    marker = "PILOT-OBSERVABILITY-MANAGED"
    args = sys.argv[2:]
    index = 0
    while index < len(args):
        if args[index] == "--patch":
            patch = args[index + 1]
            index += 2
        elif args[index] == "--plugin-dir":
            plugin_dir = args[index + 1]
            index += 2
        elif args[index] == "--marker":
            marker = args[index + 1]
            index += 2
        else:
            index += 1
    if plugin_dir:
        enabled = Path(plugin_dir) / ".collection-enabled"
        try:
            enabled.unlink()
        except FileNotFoundError:
            pass
    if not patch or not os.path.exists(patch):
        return
    original = Path(patch).read_bytes()
    begin = f"# BEGIN {marker}".encode()
    end = f"# END {marker}".encode()
    begins = _marker_offsets(original, f"# BEGIN {marker}")
    ends = _marker_offsets(original, f"# END {marker}")
    if not begins and not ends:
        return
    if len(begins) != 1 or len(ends) != 1 or ends[0] <= begins[0]:
        sys.stderr.write(f"conflicting or incomplete DSH marker block: {marker}\n")
        sys.exit(1)
    begin_line_end = original.find(b"\n", begins[0])
    if begin_line_end < 0:
        begin_line_end = len(original)
    end_line_end = original.find(b"\n", ends[0])
    if end_line_end < 0:
        end_line_end = len(original)
    block_end = end_line_end + 1 if end_line_end < len(original) and original[end_line_end] == 0x0A else end_line_end
    block = original[begins[0]:block_end].decode("utf-8", "replace")
    lines = block.splitlines()
    begin_line = original[begins[0]:begin_line_end].decode("utf-8", "replace").rstrip("\r")
    end_line = original[ends[0]:end_line_end].decode("utf-8", "replace").rstrip("\r")
    if not re.match(rf"^# BEGIN {re.escape(marker)}(?: \(created-file: (?:true|false)\))?$", begin_line) or end_line != f"# END {marker}" or "# entryId=loongsuite-pilot-observability" not in lines or not any(line.startswith("# pluginSource=") and len(line) > len("# pluginSource=") for line in lines) or not any(line.startswith("# pluginHash=") and len(line) > len("# pluginHash=") for line in lines):
        sys.stderr.write(f"conflicting or incomplete DSH marker block: {marker}\n")
        sys.exit(1)
    next_bytes = original[:begins[0]] + original[block_end:]
    created = re.search(r"created-file:\s*true", block) is not None
    if created and not next_bytes.decode("utf-8", "replace").strip():
        os.remove(patch)
        return
    mode = os.stat(patch).st_mode & 0o777
    tmp = f"{patch}.{os.getpid()}.tmp"
    with open(tmp, "wb") as handle:
        handle.write(next_bytes)
    os.chmod(tmp, mode)
    os.replace(tmp, patch)


COMMANDS = {
    "probe-count": cmd_probe_count,
    "probe-detected": cmd_probe_detected,
    "probe-menu": cmd_probe_menu,
    "probe-select": cmd_probe_select,
    "read-user-id": cmd_read_user_id,
    "json-argv": cmd_json_argv,
    "config-diffs": cmd_config_diffs,
    "write-config": cmd_write_config,
    "write-config-opts": cmd_write_config_opts,
    "strip-otel-hooks": cmd_strip_otel_hooks,
    "strip-otel-config": cmd_strip_otel_config,
    "reject-multi-sls": cmd_reject_multi_sls,
    "clean-hooks": cmd_clean_hooks,
    "state-abs": cmd_state_abs,
    "clean-grok": cmd_clean_grok,
    "clean-plugin-array": cmd_clean_plugin_array,
    "hermes-target": cmd_hermes_target,
    "hermes-ownership": cmd_hermes_ownership,
    "hermes-remove": cmd_hermes_remove,
    "clean-pi": cmd_clean_pi,
    "clean-openclaw": cmd_clean_openclaw,
    "dsh-cleanup": cmd_dsh_cleanup,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.stderr.write("usage: installer_py.py <command>\n")
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
