#!/usr/bin/env python3
"""Send one prompt to Kiro Desktop through CDP and verify session persistence."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys
import time
import urllib.request

import websockets


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt", help="Prompt to submit to Kiro Desktop")
    parser.add_argument("--port", type=int, default=9333)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument(
        "--sessions-root",
        type=Path,
        default=Path.home() / ".kiro" / "sessions",
    )
    parser.add_argument(
        "--probe-only",
        action="store_true",
        help="Locate and focus the input, but do not insert or submit text",
    )
    return parser.parse_args()


class CdpConnection:
    def __init__(self, websocket):
        self.websocket = websocket
        self.next_id = 0

    async def command(self, method: str, params: dict | None = None, session_id: str | None = None) -> dict:
        self.next_id += 1
        command_id = self.next_id
        message: dict = {"id": command_id, "method": method}
        if params is not None:
            message["params"] = params
        if session_id is not None:
            message["sessionId"] = session_id
        await self.websocket.send(json.dumps(message))

        while True:
            response = json.loads(await asyncio.wait_for(self.websocket.recv(), timeout=10))
            if response.get("id") != command_id:
                continue
            if "error" in response:
                raise RuntimeError(f"CDP {method} failed: {response['error']}")
            return response.get("result", {})


def browser_websocket(port: int) -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=3) as response:
        version = json.load(response)
    websocket_url = version.get("webSocketDebuggerUrl")
    if not websocket_url:
        raise RuntimeError(f"Port {port} is not a Browser CDP endpoint")
    print(f"[kiro-cdp] browser={version.get('Browser', 'unknown')}")
    return websocket_url


def attributes(node: dict) -> dict[str, str]:
    raw = node.get("attributes", [])
    return dict(zip(raw[0::2], raw[1::2]))


async def inspect_input(cdp: CdpConnection, session_id: str, backend_node_id: int) -> dict:
    resolved = await cdp.command(
        "DOM.resolveNode",
        {"backendNodeId": backend_node_id},
        session_id,
    )
    object_id = resolved.get("object", {}).get("objectId")
    if not object_id:
        return {"visible": False, "area": 0, "objectId": None}

    result = await cdp.command(
        "Runtime.callFunctionOn",
        {
            "objectId": object_id,
            "functionDeclaration": """function () {
                const r = this.getBoundingClientRect();
                const style = getComputedStyle(this);
                return {
                    visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
                    area: r.width * r.height,
                    text: (this.innerText || '').trim(),
                    disabled: this.getAttribute('aria-disabled') === 'true'
                };
            }""",
            "returnByValue": True,
        },
        session_id,
    )
    value = result.get("result", {}).get("value", {})
    value["objectId"] = object_id
    return value


async def find_chat_input(cdp: CdpConnection) -> tuple[str, str, dict]:
    await cdp.command("Target.setDiscoverTargets", {"discover": True})
    targets = (await cdp.command("Target.getTargets")).get("targetInfos", [])
    candidates = [
        target
        for target in targets
        if target.get("type") == "iframe"
        and "extensionId=kiro.kiroAgent" in target.get("url", "")
    ]
    if not candidates:
        raise RuntimeError("No kiro.kiroAgent iframe target found; open Kiro Chat first")

    errors: list[str] = []
    for target in candidates:
        attached = await cdp.command(
            "Target.attachToTarget",
            {"targetId": target["targetId"], "flatten": True},
        )
        session_id = attached.get("sessionId")
        if not session_id:
            continue
        try:
            await cdp.command("DOM.enable", session_id=session_id)
            document = await cdp.command(
                "DOM.getFlattenedDocument",
                {"depth": -1, "pierce": True},
                session_id,
            )
            matching_nodes: list[dict] = []
            for node in document.get("nodes", []):
                attrs = attributes(node)
                classes = attrs.get("class", "").split()
                if (
                    node.get("nodeName") == "DIV"
                    and attrs.get("contenteditable") == "true"
                    and "chat-input-content" in classes
                ):
                    matching_nodes.append(node)

            inspected: list[dict] = []
            for node in matching_nodes:
                details = await inspect_input(cdp, session_id, node["backendNodeId"])
                if details.get("objectId"):
                    details["backendNodeId"] = node["backendNodeId"]
                    inspected.append(details)
            inspected.sort(key=lambda item: (bool(item.get("visible")), item.get("area", 0)), reverse=True)
            if inspected:
                selected = inspected[0]
                print(
                    "[kiro-cdp] target="
                    f"{target['targetId']} inputs={len(inspected)} "
                    f"visible={selected.get('visible')} area={selected.get('area', 0):.0f}"
                )
                return session_id, target["targetId"], selected
            errors.append(f"{target['targetId']}: no chat-input-content")
        except Exception as exc:  # keep probing other live/rebuilt webviews
            errors.append(f"{target['targetId']}: {exc}")

    raise RuntimeError("Kiro iframe found but no usable input: " + "; ".join(errors))


async def focus_and_send(cdp: CdpConnection, session_id: str, selected: dict, prompt: str, submit: bool) -> str:
    object_id = selected["objectId"]
    focused = await cdp.command(
        "Runtime.callFunctionOn",
        {
            "objectId": object_id,
            "functionDeclaration": "function () { this.focus(); return document.activeElement === this; }",
            "returnByValue": True,
        },
        session_id,
    )
    is_focused = focused.get("result", {}).get("value", False)
    if not is_focused:
        raise RuntimeError("Resolved chat input could not be focused")
    print("[kiro-cdp] focused=true")

    if not submit:
        return ""

    if selected.get("text"):
        raise RuntimeError("Internal error: non-empty Kiro input was not cleared and re-resolved")

    await cdp.command("Input.insertText", {"text": prompt}, session_id)
    verified = await cdp.command(
        "Runtime.callFunctionOn",
        {
            "objectId": object_id,
            "functionDeclaration": "function () { return (this.innerText || '').trim(); }",
            "returnByValue": True,
        },
        session_id,
    )
    actual_text = verified.get("result", {}).get("value", "")
    if actual_text != prompt:
        raise RuntimeError(f"Input verification mismatch: expected {prompt!r}, got {actual_text!r}")
    print(f"[kiro-cdp] inserted={len(actual_text)} chars")

    for event_type in ("keyDown", "keyUp"):
        await cdp.command(
            "Input.dispatchKeyEvent",
            {
                "type": event_type,
                "key": "Enter",
                "code": "Enter",
                "windowsVirtualKeyCode": 13,
            },
            session_id,
        )
    print("[kiro-cdp] submitted=true")
    return actual_text


async def clear_input(cdp: CdpConnection, session_id: str, selected: dict) -> None:
    """Clear a non-empty TipTap editor; the caller must resolve the new node afterwards."""
    object_id = selected["objectId"]
    await cdp.command(
        "Runtime.callFunctionOn",
        {
            "objectId": object_id,
            "functionDeclaration": "function () { this.focus(); return document.activeElement === this; }",
            "returnByValue": True,
        },
        session_id,
    )
    modifier = 4 if sys.platform == "darwin" else 2
    for event_type in ("keyDown", "keyUp"):
        await cdp.command(
            "Input.dispatchKeyEvent",
            {
                "type": event_type,
                "key": "a",
                "code": "KeyA",
                "windowsVirtualKeyCode": 65,
                "modifiers": modifier,
            },
            session_id,
        )
    for event_type in ("keyDown", "keyUp"):
        await cdp.command(
            "Input.dispatchKeyEvent",
            {
                "type": event_type,
                "key": "Backspace",
                "code": "Backspace",
                "windowsVirtualKeyCode": 8,
            },
            session_id,
        )
    await asyncio.sleep(0.2)
    print("[kiro-cdp] cleared_stale_input=true")


def session_offsets(root: Path) -> dict[Path, int]:
    return {path: path.stat().st_size for path in root.glob("**/messages.jsonl")}


def read_appended(path: Path, offset: int) -> list[dict]:
    size = path.stat().st_size
    if size < offset:
        offset = 0
    with path.open("rb") as stream:
        stream.seek(offset)
        raw = stream.read().decode("utf-8", errors="replace")
    events: list[dict] = []
    for line in raw.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


async def wait_for_turn(root: Path, baseline: dict[Path, int], prompt: str, timeout: int) -> tuple[Path, list[dict]]:
    deadline = time.monotonic() + timeout
    matched_path: Path | None = None
    seen: list[dict] = []
    reported = 0

    while time.monotonic() < deadline:
        for path in root.glob("**/messages.jsonl"):
            events = read_appended(path, baseline.get(path, 0))
            if matched_path is None:
                for event in events:
                    payload = event.get("payload", {})
                    if payload.get("type") == "user" and payload.get("content") == prompt:
                        matched_path = path
                        print(f"[kiro-session] matched={path}")
                        break
            if matched_path == path:
                seen = events

        if matched_path is not None:
            event_types = [event.get("payload", {}).get("type", "unknown") for event in seen]
            if len(event_types) > reported:
                print(f"[kiro-session] events={','.join(event_types)}")
                reported = len(event_types)
            turn_end = next(
                (event for event in seen if event.get("payload", {}).get("type") == "turn_end"),
                None,
            )
            if turn_end is not None:
                return matched_path, seen
        await asyncio.sleep(1)

    if matched_path is None:
        raise TimeoutError(f"Prompt was not persisted under {root} within {timeout}s")
    raise TimeoutError(f"Session was found but no turn_end arrived within {timeout}s")


def summarize(events: list[dict]) -> dict:
    payloads = [event.get("payload", {}) for event in events]
    turn_end = next((payload for payload in payloads if payload.get("type") == "turn_end"), {})
    usage = next((payload for payload in payloads if payload.get("type") == "usage_summary"), {})
    display_error = next(
        (
            payload.get("value", {})
            for payload in payloads
            if payload.get("type") == "session_metadata" and payload.get("key") == "displayError"
        ),
        {},
    )
    assistant_texts: list[str] = []
    for payload in payloads:
        if payload.get("type") == "user":
            continue
        for key in ("content", "text", "message"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                assistant_texts.append(value.strip())
    return {
        "eventTypes": [payload.get("type", "unknown") for payload in payloads],
        "stopReason": turn_end.get("stopReason"),
        "status": usage.get("status"),
        "elapsedTime": usage.get("elapsedTime"),
        "assistantText": assistant_texts[-1] if assistant_texts else None,
        "errorType": display_error.get("errorType"),
        "errorMessage": display_error.get("message"),
    }


async def main() -> int:
    args = parse_args()
    websocket_url = browser_websocket(args.port)
    baseline = session_offsets(args.sessions_root)
    print(f"[kiro-session] baseline_files={len(baseline)}")

    async with websockets.connect(websocket_url, max_size=16 * 1024 * 1024, open_timeout=5) as websocket:
        cdp = CdpConnection(websocket)
        session_id, _, selected = await find_chat_input(cdp)
        if not args.probe_only and selected.get("text"):
            await clear_input(cdp, session_id, selected)
            session_id, _, selected = await find_chat_input(cdp)
        await focus_and_send(cdp, session_id, selected, args.prompt, not args.probe_only)

    if args.probe_only:
        print("PASS: Kiro Chat input discovered and focused")
        return 0

    path, events = await wait_for_turn(args.sessions_root, baseline, args.prompt, args.timeout)
    result = summarize(events)
    print(f"[kiro-session] file={path}")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get("status") in {"success", "completed"} and result.get("stopReason") != "error":
        print("PASS: Kiro prompt submitted and completed turn persisted")
        return 0
    print(
        "FAIL: Kiro persisted the turn but the agent did not complete successfully"
        + (f": {result['errorMessage']}" if result.get("errorMessage") else ""),
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
