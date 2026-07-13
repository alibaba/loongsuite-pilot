#!/usr/bin/env python3
"""Build markdown draft bodies from exceptions.json candidates (no SLS calls)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def pick_samples(samples: list[dict], alarm_type: str, limit: int = 5) -> list[dict]:
    out = []
    for row in samples:
        if str(row.get("alarm_type") or "") == alarm_type:
            out.append(row)
        if len(out) >= limit:
            break
    return out


def pick_users(users: list[dict], alarm_type: str, limit: int = 5) -> list[dict]:
    out = []
    for row in users:
        types = str(row.get("alarm_types") or "")
        if alarm_type in types.split(", ") or alarm_type in types:
            out.append(row)
        if len(out) >= limit:
            break
    return out


def render_body(c: dict, *, window: str, samples: list[dict], users: list[dict], health: dict) -> str:
    label = c.get("label") or c["alarm_type"]
    title = (
        f"[Pilot异常] {label} · 影响 Agent {c.get('agent_count', 0)} · "
        f"用户 {c.get('user_count', 0)}"
    )
    lines = [
        f"# {title}",
        "",
        "## Summary",
        "",
        f"- 告警类型: `{c['alarm_type']}`（{label}）",
        f"- 指纹: `{c['fingerprint']}`",
        f"- 影响 Agent 数: {c.get('agent_count', 0)}",
        f"- 影响用户数: {c.get('user_count', 0)}",
        f"- L3 Agent 数: {c.get('l3_agent_count', 0)}",
        f"- 级别样例: {c.get('level_sample') or '-'}",
        f"- 数据窗口: `{window}`",
        "",
        "## Health Context",
        "",
    ]
    if health:
        lines.extend([
            f"- 守护掉线 Agent: {health.get('daemon_down', '-')}",
            f"- 版本无效 Agent: {health.get('version_invalid', '-')}",
            f"- 守护存活率(%): {health.get('daemon_alive_pct', '-')}",
            f"- nohup 占比(%): {health.get('nohup_pct', '-')}",
            f"- Agent 总数(快照): {health.get('agent_total', '-')}",
            "",
        ])
    else:
        lines.extend(["- （无健康 KPI 数据）", ""])

    lines.extend([
        "## Priority",
        "",
        "（待主 Agent 按 references/priority.md 裁定：P0–P3 + Impact/Severity/Difficulty）",
        "",
        "## Evidence",
        "",
    ])
    if users:
        lines.append("Top 用户（含本类型）:")
        for u in users:
            lines.append(
                f"- user={u.get('user_id')} agents={u.get('agent_count')} types={u.get('alarm_types')}"
            )
        lines.append("")
    if samples:
        lines.append("最近样本:")
        for s in samples:
            msg = str(s.get("alarm_message") or "")[:160]
            lines.append(
                f"- {s.get('t')} {s.get('level')} ip={s.get('ip')} user={s.get('user_id')} "
                f"ver={s.get('ver')} msg={msg}"
            )
        lines.append("")

    lines.extend([
        "## 告警消息分类",
        "",
        "（待子 Agent 深挖：将窗口内告警消息按模板归类，用表格展示每类的影响 Agent 数和含义说明）",
        "",
        "## 代码分析",
        "",
        "（待子 Agent 深挖：用自然语言段落描述告警的触发逻辑、代码路径和触发条件）",
        "",
        "## 验证过程",
        "",
        "（待补：每条验证包含验证目的、完整查询命令、返回结果、结论；禁止留下可查的「待验证」）",
        "",
        "## 根因",
        "",
        "（待补：用自然语言描述因果链，主因 + 数据支撑；已排除的假设一并写明）",
        "",
        "## 修复建议",
        "",
        "（待补：每条建议包含要改什么文件/函数、怎么改、预期效果）",
        "",
        "## 待确认项",
        "",
        "（仅限无法通过 SLS 或代码验证的项，可为空）",
        "",
        "## 时间线",
        "",
    ])
    return title, "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", default="", help="path to exceptions.json")
    parser.add_argument("--out-dir", default="", help="write one md per candidate")
    args = parser.parse_args()

    root = skill_root()
    if args.snapshot:
        snap_path = Path(args.snapshot)
    else:
        runs = sorted((root / "data" / "runs").glob("*/exceptions.json"))
        if not runs:
            raise SystemExit("no exceptions.json found; run fetch_exceptions.py first")
        snap_path = runs[-1]

    data = json.loads(snap_path.read_text(encoding="utf-8"))
    window = data.get("window") or "-604800s"
    results = data.get("results") or {}
    samples = results.get("recent_samples") or []
    users = results.get("top_users") or []
    health_rows = results.get("health_kpis") or []
    health = health_rows[0] if health_rows else {}

    out_dir = Path(args.out_dir) if args.out_dir else snap_path.parent / "drafts"
    out_dir.mkdir(parents=True, exist_ok=True)

    drafts = []
    for c in data.get("candidates") or []:
        title, body = render_body(c, window=window, samples=pick_samples(samples, c["alarm_type"]),
                                  users=pick_users(users, c["alarm_type"]), health=health)
        fname = f"{c['fingerprint'].replace(':', '_')}.md"
        path = out_dir / fname
        path.write_text(body, encoding="utf-8")
        drafts.append({
            "fingerprint": c["fingerprint"],
            "alarm_type": c["alarm_type"],
            "title": title,
            "body_file": str(path),
            "agent_count": c.get("agent_count"),
            "user_count": c.get("user_count"),
        })
        print(f"draft {path.name}")

    manifest = out_dir / "manifest.json"
    manifest.write_text(json.dumps(drafts, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {manifest} count={len(drafts)}")


if __name__ == "__main__":
    main()
