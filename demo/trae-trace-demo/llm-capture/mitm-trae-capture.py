#!/usr/bin/env python3
"""
mitm-trae-capture.py —— mitmproxy 插件版 TRAE LLM 流量捕获（路线 B）。

适用：TRAE 不开放「自定义模型入口」、或请求直发云端无法改 base_url 时，
用 mitmproxy 在 TLS 终止点抓。前提：机器信任 mitmproxy 根证书，
且 TRAE 未做证书钉扎（pinning）——若钉扎，此路不通，如实告知用户。

用法：
  mitmdump -s mitm-trae-capture.py
  # 然后让系统代理指向 mitmproxy（默认 127.0.0.1:8080）
  # 输出固定写 llm-capture/out/mitm-capture.jsonl（改 OUT_PATH 可换位置）

安全约定（与 llm-proxy 一致）：
  1. Authorization / Cookie 等凭据头只记「存在性」，值整体丢弃；
  2. 请求/响应 JSON 递归脱敏后才落盘；
  3. SSE 只记 delta 统计（字符数 / finish_reason / usage），不存生成原文；
  4. 捕获文件在 out/ 下，不进仓库。
"""
import json
import os
import re
import time

from mitmproxy import http

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "mitm-capture.jsonl")
_out = None
_seq = 0

SECRET_KEY_RE = re.compile(
    r"(^|[_\-.])(token|secret|password|passwd|credential|auth|api[_\-.]?key|apikey|"
    r"access[_\-.]?key|private[_\-.]?key|session[_\-.]?key|bearer|cookie|signature|"
    r"client[_\-.]?secret|refresh[_\-.]?token|id[_\-.]?token)([_\-.]|$)", re.I)
SECRET_VALUE_RE = re.compile(
    r"^(eyJ[A-Za-z0-9_-]{16,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}|"
    r"sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+\S{16,})")
DROP_HEADERS = {"authorization", "proxy-authorization", "cookie", "set-cookie",
                "x-api-key", "x-auth-token", "x-access-token", "x-session-token"}

# 只关心 LLM/Agent 类流量，其余（遥测/更新检查）不捕获
INTEREST_RE = re.compile(r"(chat|completion|agent|llm|model|create_agent_task|commit_toolcall)", re.I)


def _redact(value, key=""):
    """递归脱敏：键名命中或值形态像凭据即替换；保留长度，绝不保留前后缀"""
    if isinstance(value, str):
        if key and SECRET_KEY_RE.search(key):
            return f"[REDACTED:key-name:{len(value)}]"
        if SECRET_VALUE_RE.match(value):
            return f"[REDACTED:value-shape:{len(value)}]"
        return value
    if isinstance(value, dict):
        return {k: _redact(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v, key) for v in value]
    return value


def _open_out():
    global _out
    if _out is None:
        os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
        _out = open(OUT_PATH, "a", encoding="utf-8")
    return _out


def _write(rec):
    _open_out().write(json.dumps(rec, ensure_ascii=False) + "\n")
    _out.flush()


def request(flow: http.HTTPFlow):
    if not INTEREST_RE.search(flow.request.pretty_url):
        return
    global _seq
    _seq += 1
    flow.metadata["capture_id"] = _seq
    flow.metadata["started_at"] = time.time()

    headers = {}
    dropped = []
    for k, v in flow.request.headers.items():
        if k.lower() in DROP_HEADERS:
            dropped.append(k.lower())
        else:
            headers[k.lower()] = v

    body = None
    raw = flow.request.get_text(strict=False)
    if raw:
        try:
            body = _redact(json.loads(raw))
        except (ValueError, TypeError):
            body = None  # 非 JSON：只记长度

    _write({
        "id": _seq, "kind": "request", "ts": time.time(),
        "method": flow.request.method, "url": flow.request.pretty_url,
        "headers": headers, "dropped_headers": dropped,
        "body_chars": len(raw or ""), "body": body,
    })


def response(flow: http.HTTPFlow):
    cid = flow.metadata.get("capture_id")
    if cid is None:
        return
    ctype = flow.response.headers.get("content-type", "")
    is_sse = "text/event-stream" in ctype
    rec = {
        "id": cid, "kind": "response", "ts": time.time(),
        "status": flow.response.status_code,
        "ms": int((time.time() - flow.metadata.get("started_at", time.time())) * 1000),
        "is_sse": is_sse,
    }
    if is_sse:
        events = []
        for line in flow.response.get_text(strict=False).splitlines():
            m = re.match(r"^data:\s*(.+)$", line.strip())
            if not m:
                continue
            if m.group(1) == "[DONE]":
                events.append({"done": True})
                continue
            try:
                ev = json.loads(m.group(1))
                delta = (ev.get("choices") or [{}])[0].get("delta") or {}
                events.append({
                    "delta_chars": len(delta.get("content") or ""),
                    "reasoning_chars": len(delta.get("reasoning_content") or delta.get("reasoning") or ""),
                    "tool_calls": len(delta.get("tool_calls") or []),
                    "finish_reason": (ev.get("choices") or [{}])[0].get("finish_reason"),
                    "usage": ev.get("usage"),
                })
            except (ValueError, TypeError, IndexError):
                pass
        rec["sse_events"] = events
        rec["sse_total_delta_chars"] = sum(e.get("delta_chars", 0) for e in events)
        rec["sse_total_reasoning_chars"] = sum(e.get("reasoning_chars", 0) for e in events)
    else:
        raw = flow.response.get_text(strict=False)
        rec["body_chars"] = len(raw or "")
        try:
            rec["body"] = _redact(json.loads(raw))
        except (ValueError, TypeError):
            rec["body"] = None
    _write(rec)
