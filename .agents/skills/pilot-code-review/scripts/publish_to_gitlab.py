#!/usr/bin/env python3
"""
Publish review findings to GitLab MR via REST API (MCP-free fallback).

Reads publish-payload.json and posts inline + summary comments to GitLab.
Requires GITLAB_TOKEN env var or ~/.gitlab-token file.

Usage:
  python3 publish_to_gitlab.py --repo-root <path> --target-type pr --target-id <id> --mr-iid <iid>
  python3 publish_to_gitlab.py --repo-root <path> --target-type branch --target-id <name> --mr-iid <iid>

Optional:
  --gitlab-host https://gitlab.alibaba-inc.com  (default)
  --gitlab-repo sls/loongsuite-pilot            (auto-detected from git remote if omitted)
  --dry-run                                     (print API calls without executing)
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# 幂等标记:发布时附加到评论正文(HTML 注释,GitLab 渲染时隐藏),
# 重复运行时据此跳过已发布内容,避免评论堆叠。
SUMMARY_MARKER = "<!-- loongsuite-cr-bot:summary -->"


def inline_marker(path: str, line: int) -> str:
    return f"<!-- loongsuite-cr-bot:inline:{path}:{line} -->"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def sanitize_branch_name(name: str) -> str:
    return name.replace("/", "-")


def get_token() -> Optional[str]:
    token = os.environ.get("GITLAB_TOKEN", "").strip()
    if token:
        return token
    token_file = Path.home() / ".gitlab-token"
    if token_file.exists():
        lines = token_file.read_text(encoding="utf-8").strip().splitlines()
        if lines:
            return lines[0]
    return None


def get_repo_path_from_git(repo_root: Path) -> Optional[str]:
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=repo_root, capture_output=True, text=True, check=True,
        )
        url = result.stdout.strip()
        # Handle SSH: git@gitlab.alibaba-inc.com:sls/loongsuite-pilot.git
        # Handle HTTPS: https://gitlab.alibaba-inc.com/sls/loongsuite-pilot.git
        import re
        m = re.search(r"gitlab\.alibaba-inc\.com[:/](.+?)(?:\.git)?$", url)
        if m:
            return m.group(1)
    except subprocess.CalledProcessError:
        pass
    return None


def gitlab_api(host: str, token: str, method: str, path: str,
               data: Optional[Dict] = None, dry_run: bool = False,
               retries: int = 2) -> Tuple[int, Any]:
    url = f"{host}/api/v4{path}"

    if dry_run:
        print(f"[DRY-RUN] {method} {url}", file=sys.stderr)
        if data:
            print(f"  Body: {json.dumps(data, ensure_ascii=False)[:200]}...", file=sys.stderr)
        return 200, {"id": 0, "dry_run": True}

    headers = {
        "PRIVATE-TOKEN": token,
        "Content-Type": "application/json",
    }
    body = json.dumps(data, ensure_ascii=False).encode("utf-8") if data else None

    attempt = 0
    while True:
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp_body = resp.read().decode("utf-8")
                return resp.status, json.loads(resp_body) if resp_body else {}
        except urllib.error.HTTPError as e:
            resp_body = e.read().decode("utf-8", errors="replace")
            # 仅对幂等 GET 的瞬时服务端错误重试,避免 POST 重试造成重复评论。
            if method == "GET" and e.code in (429, 500, 502, 503, 504) and attempt < retries:
                attempt += 1
                time.sleep(2 ** attempt)
                continue
            return e.code, {"error": resp_body}
        except Exception as e:
            # 连接层错误(请求多半未送达/未生效),各方法均可安全重试。
            if attempt < retries:
                attempt += 1
                time.sleep(2 ** attempt)
                continue
            return 0, {"error": str(e)}


def get_mr_diff_refs(host: str, token: str, project_encoded: str,
                     mr_iid: int, dry_run: bool) -> Dict[str, str]:
    status, data = gitlab_api(
        host, token, "GET",
        f"/projects/{project_encoded}/merge_requests/{mr_iid}",
        dry_run=dry_run,
    )
    if status != 200:
        return {}
    diff_refs = data.get("diff_refs", {})
    return {
        "base_sha": diff_refs.get("base_sha", ""),
        "head_sha": diff_refs.get("head_sha", ""),
        "start_sha": diff_refs.get("start_sha", ""),
    }


def get_mr_changed_paths(host: str, token: str, project_encoded: str,
                         mr_iid: int, dry_run: bool) -> List[str]:
    status, data = gitlab_api(
        host, token, "GET",
        f"/projects/{project_encoded}/merge_requests/{mr_iid}/changes",
        dry_run=dry_run,
    )
    if status != 200:
        return []
    return [c.get("new_path", "") for c in data.get("changes", [])]


def post_inline_comment(host: str, token: str, project_encoded: str,
                        mr_iid: int, diff_refs: Dict[str, str],
                        path: str, line: int, body: str,
                        dry_run: bool) -> Tuple[bool, str]:
    data = {
        "body": body,
        "position": {
            "position_type": "text",
            "base_sha": diff_refs["base_sha"],
            "head_sha": diff_refs["head_sha"],
            "start_sha": diff_refs["start_sha"],
            "new_path": path,
            "new_line": line,
        },
    }
    status, resp = gitlab_api(
        host, token, "POST",
        f"/projects/{project_encoded}/merge_requests/{mr_iid}/discussions",
        data=data, dry_run=dry_run,
    )
    if status in (200, 201):
        return True, ""
    # 仅当行确实不在 diff 内(400)才回退为全局 note;鉴权/限流/服务端错误(401/429/5xx)
    # 应直接报失败,不要生成位置错乱的全局评论(重跑时还会叠加)。
    if status == 400:
        fallback_body = f"📍 `{path}:{line}`\n\n{body}"
        status2, resp2 = gitlab_api(
            host, token, "POST",
            f"/projects/{project_encoded}/merge_requests/{mr_iid}/notes",
            data={"body": fallback_body}, dry_run=dry_run,
        )
        if status2 in (200, 201):
            return True, "fallback_to_note"
        return False, resp2.get("error", str(resp2))
    return False, resp.get("error", str(resp))


def list_existing_note_bodies(host: str, token: str, project_encoded: str,
                              mr_iid: int, dry_run: bool) -> List[str]:
    """拉取 MR 现有 notes 正文(含 diff discussion notes),用于幂等去重。"""
    if dry_run:
        return []
    bodies: List[str] = []
    page = 1
    while page <= 20:
        status, data = gitlab_api(
            host, token, "GET",
            f"/projects/{project_encoded}/merge_requests/{mr_iid}"
            f"/notes?per_page=100&page={page}",
            dry_run=False,
        )
        if status != 200 or not isinstance(data, list) or not data:
            break
        bodies.extend(n.get("body", "") for n in data if isinstance(n, dict))
        if len(data) < 100:
            break
        page += 1
    return bodies


def post_summary_comment(host: str, token: str, project_encoded: str,
                         mr_iid: int, body: str, dry_run: bool) -> Tuple[bool, str]:
    status, resp = gitlab_api(
        host, token, "POST",
        f"/projects/{project_encoded}/merge_requests/{mr_iid}/notes",
        data={"body": body}, dry_run=dry_run,
    )
    if status in (200, 201):
        return True, ""
    return False, resp.get("error", str(resp))


def main() -> None:
    parser = argparse.ArgumentParser(description="Publish review to GitLab MR via REST API.")
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--target-type", required=True, choices=["pr", "branch"])
    parser.add_argument("--target-id", required=True)
    parser.add_argument("--mr-iid", type=int, required=True, help="GitLab MR IID")
    parser.add_argument("--gitlab-host", default="https://gitlab.alibaba-inc.com")
    parser.add_argument("--gitlab-repo", help="GitLab repo path (auto-detected if omitted)")
    parser.add_argument("--dry-run", action="store_true", help="Print API calls without executing")
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    target_id_dir = sanitize_branch_name(args.target_id) if args.target_type == "branch" else args.target_id
    review_dir = repo_root / "code-review" / f"{args.target_type}-{target_id_dir}"

    # Check token
    token = get_token()
    if not token and not args.dry_run:
        print(json.dumps({
            "status": "failed",
            "error": "No GitLab token found. Set GITLAB_TOKEN env var or create ~/.gitlab-token",
            "channel": "manual",
        }))
        sys.exit(1)

    # Resolve repo path
    gitlab_repo = args.gitlab_repo or get_repo_path_from_git(repo_root)
    if not gitlab_repo:
        print(json.dumps({
            "status": "failed",
            "error": "Cannot determine GitLab repo path. Use --gitlab-repo.",
        }))
        sys.exit(1)

    project_encoded = urllib.parse.quote(gitlab_repo, safe="")

    # Read payload
    payload_path = review_dir / "publish-payload.json"
    if not payload_path.exists():
        print(json.dumps({"status": "failed", "error": f"publish-payload.json not found at {payload_path}"}))
        sys.exit(1)

    payload = json.loads(payload_path.read_text(encoding="utf-8"))

    # Get diff refs for inline comments
    diff_refs = get_mr_diff_refs(args.gitlab_host, token or "", project_encoded, args.mr_iid, args.dry_run)
    if not diff_refs.get("head_sha") and not args.dry_run:
        print(json.dumps({"status": "failed", "error": "Cannot get MR diff refs. MR may not exist or token lacks access."}))
        sys.exit(1)

    # Get changed file paths for validation
    changed_paths = get_mr_changed_paths(args.gitlab_host, token or "", project_encoded, args.mr_iid, args.dry_run)

    # 幂等:一次性拉取现有评论正文,据标记跳过本轮已发布过的内容
    existing_blob = "\n".join(
        list_existing_note_bodies(args.gitlab_host, token or "", project_encoded, args.mr_iid, args.dry_run)
    )

    # Publish inline comments
    inline_results = []
    for comment in payload.get("inline_comments", []):
        path = comment["path"]
        line = comment["line"]
        marker = inline_marker(path, line)
        body = f"{comment['body']}\n\n{marker}"

        # Validate path is in MR diff
        if changed_paths and path not in changed_paths:
            inline_results.append({
                "path": path, "line": line, "severity": comment.get("severity", ""),
                "status": "skipped", "error": "path not in MR diff",
            })
            continue

        # 幂等:同 path:line 已发布过则跳过,避免重复评论
        if marker in existing_blob:
            inline_results.append({
                "path": path, "line": line, "severity": comment.get("severity", ""),
                "status": "skipped", "error": "already published",
            })
            continue

        success, err = post_inline_comment(
            args.gitlab_host, token or "", project_encoded,
            args.mr_iid, diff_refs, path, line, body, args.dry_run,
        )
        inline_results.append({
            "path": path, "line": line, "severity": comment.get("severity", ""),
            "status": "success" if success else "failed",
            "error": err if err and err != "fallback_to_note" else None,
            "fallback": err == "fallback_to_note",
        })

    # Publish summary
    summary_path = review_dir / "platform-summary.md"
    summary_body = summary_path.read_text(encoding="utf-8") if summary_path.exists() else ""
    summary_success, summary_err = (False, "no summary file")
    summary_skipped = False
    if summary_body:
        if SUMMARY_MARKER in existing_blob:
            # 幂等:摘要已发布过则跳过,避免重复堆叠
            summary_success, summary_err, summary_skipped = True, "already published", True
        else:
            summary_success, summary_err = post_summary_comment(
                args.gitlab_host, token or "", project_encoded,
                args.mr_iid, f"{summary_body}\n\n{SUMMARY_MARKER}", args.dry_run,
            )

    # Write publish-result.json
    published_count = sum(1 for r in inline_results if r["status"] == "success")
    failed_count = sum(1 for r in inline_results if r["status"] == "failed")
    skipped_count = sum(1 for r in inline_results if r["status"] == "skipped")

    result = {
        "platform": "gitlab",
        "channel": "gitlab_api",
        "target_type": args.target_type,
        "target_id": args.target_id,
        "mr_iid": args.mr_iid,
        "gitlab_repo": gitlab_repo,
        "published_at": utc_now(),
        "summary_comment": {
            "status": "skipped_duplicate" if summary_skipped
                      else ("success" if summary_success else "failed"),
            "error": summary_err if (not summary_success or summary_skipped) else None,
        },
        "inline_comments": inline_results,
        "stats": {
            "total_findings": payload.get("stats", {}).get("total_findings", 0),
            "published": published_count + (1 if summary_success else 0),
            "failed": failed_count + (0 if summary_success else 1),
            "skipped": skipped_count,
        },
    }

    result_path = review_dir / "publish-result.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # Output summary
    print(json.dumps({
        "status": "success" if failed_count == 0 and summary_success else "partial",
        "channel": "gitlab_api",
        "inline_published": published_count,
        "inline_failed": failed_count,
        "inline_skipped": skipped_count,
        "summary_published": summary_success,
        "result_file": str(result_path.relative_to(repo_root)),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
