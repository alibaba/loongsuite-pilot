#!/usr/bin/env python3
"""Render a local HTML preview from an Alibaba Cloud SLS dashboard JSON.

The renderer executes SLS queries and embeds the returned rows alongside each
chart's layout and SQL.
"""

import json
import subprocess
import time
import argparse
import html as html_mod
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parents[3]


def parse_args():
    p = argparse.ArgumentParser(description="Render SLS dashboard JSON to local HTML")
    p.add_argument("scenario", nargs="?", default=None, help="子场景名；与 --case-dir 配合使用")
    p.add_argument("--dashboard", dest="dashboard_json", type=Path, help="dashboard JSON 路径")
    p.add_argument("--case-dir", type=Path, help="cases/<business-skill> 目录")
    p.add_argument("--hours", type=int, default=None, help="查询最近 N 小时（未指定时从 dashboard 查询 start 推导，兜底 168）")
    p.add_argument("--from", dest="ts_from", type=int)
    p.add_argument("--to", dest="ts_to", type=int)
    p.add_argument("--output", type=Path, default=None)
    p.add_argument("--filter", "--var", dest="filters", type=str, action="append", default=[], help="变量 key=value（可多个），替换 SQL 中的 ${{key}}")
    p.add_argument("--with-diff", action="store_true", help="和 git HEAD 中的同一路径 dashboard JSON 做 SQL / 结果 diff")
    p.add_argument("--default-project", default="", help="chartQuery 未声明 project 时使用的默认 project")
    p.add_argument("--profile", default="test", help="aliyun CLI profile（默认 test）")
    p.add_argument("--region", default="", help="aliyun CLI region override（默认使用 profile 配置）")
    return p.parse_args()


def parse_relative_start(start):
    if isinstance(start, str) and start.startswith("-") and start.endswith("s"):
        try:
            return int(start[1:-1])
        except ValueError:
            return None
    return None


def infer_range_seconds(dashboard):
    starts = []
    for chart in dashboard.get("charts", []):
        search = chart.get("search") or {}
        if not search.get("chartQueries"):
            continue
        seconds = parse_relative_start(search.get("start"))
        if seconds is not None:
            starts.append(seconds)
    if not starts:
        return None
    return Counter(starts).most_common(1)[0][0]


def get_time_range(args, dashboard=None):
    if args.ts_from and args.ts_to:
        return args.ts_from, args.ts_to
    now = int(time.time())
    if args.hours is not None:
        return now - args.hours * 3600, now
    range_seconds = infer_range_seconds(dashboard or {})
    if range_seconds is None:
        range_seconds = 168 * 3600
    return now - range_seconds, now


def get_chart_time_range(chart, args, ts_from, ts_to):
    if (args.ts_from and args.ts_to) or args.hours is not None:
        return ts_from, ts_to
    seconds = parse_relative_start((chart.get("search") or {}).get("start"))
    if seconds is None:
        return ts_from, ts_to
    return ts_to - seconds, ts_to


def query_sls(project, logstore, query, ts_from, ts_to, profile="", region=""):
    cmd = ["aliyun"]
    if profile:
        cmd.extend(["--profile", profile])
    cmd.extend([
        "sls", "get-logs-v2",
        "--project", project, "--logstore", logstore,
        "--query", query, "--from", str(ts_from), "--to", str(ts_to),
    ])
    if region:
        cmd.extend(["--region", region])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            return None, r.stderr.strip()[:200]
        payload = json.loads(r.stdout)
        if isinstance(payload, dict) and "data" in payload:
            return payload.get("data") or [], None
        return payload, None
    except subprocess.TimeoutExpired:
        return None, "查询超时"
    except json.JSONDecodeError:
        return None, "JSON 解析失败"
    except Exception as e:
        return None, str(e)[:200]


def load_dashboard(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def esc(s):
    return html_mod.escape(str(s)) if s is not None else ""


def get_display_name(chart):
    d = chart.get("display", {})
    return d.get("basicOptions", {}).get("displayName", d.get("displayName", chart.get("title", "")))


def get_doc_text(chart):
    links = chart.get("display", {}).get("documentLinkOption", {}).get("documentLinks", [])
    return links[0].get("title", "") if links else ""


def extract_cte_names(query):
    """从 SQL 中提取 WITH 后的 CTE 表名列表。"""
    import re
    if not query:
        return []
    return re.findall(r'\b(\w+)\s+AS\s*\(', query, re.IGNORECASE)


def render_cte_tag(query):
    """生成 CTE 表名标签 HTML。"""
    names = extract_cte_names(query)
    if not names:
        return ""
    tags = " ".join(f'<span class="cte-tag">{esc(n)}</span>' for n in names)
    return f' {tags}'


def time_str(ts_from, ts_to):
    fmt = "%Y-%m-%d %H:%M"
    return f"{datetime.fromtimestamp(ts_from).strftime(fmt)} ~ {datetime.fromtimestamp(ts_to).strftime(fmt)}"


def is_num(v):
    if v is None:
        return False
    try:
        float(v)
        return True
    except (ValueError, TypeError):
        return False


def fmt_num(v):
    if not is_num(v):
        return str(v) if v is not None else "-"
    n = float(v)
    a = abs(n)
    if a >= 1e9:
        return f"{n/1e9:.2f}B"
    if a >= 1e6:
        return f"{n/1e6:.2f}M"
    if a >= 1e4:
        return f"{n/1e3:.1f}K"
    if a == int(a) and a < 10000:
        return str(int(n))
    return f"{n:.2f}"


MAX_ROWS = 20

# 这些列名的值即使是数字也不做 KMB 缩写，保持原样显示
RAW_NUM_COLS = {'工号', 'work_no', 'user_id', 'work_no_extra', 'id', 'ID'}


def extract_sql_cols(query):
    """从 SQL 的最外层 SELECT 提取列别名顺序。"""
    if not query:
        return []
    parts = query.split("|", 1)
    sql = parts[1].strip() if len(parts) > 1 else parts[0].strip()
    # 跳过 CTE: WITH ... 最后一个 ) 之后的 SELECT
    # 找最外层 SELECT
    sql_upper = sql.upper()
    # 找最后一个顶层 SELECT（跳过 CTE 中的 SELECT）
    depth = 0
    last_select = -1
    i = 0
    while i < len(sql_upper):
        if sql_upper[i] == '(':
            depth += 1
        elif sql_upper[i] == ')':
            depth -= 1
        elif depth == 0 and sql_upper[i:i+6] == 'SELECT':
            last_select = i
        i += 1
    if last_select < 0:
        return []
    after_select = sql[last_select + 6:]
    # 取到 FROM 之前
    # 找顶层 FROM
    depth = 0
    from_pos = -1
    i = 0
    up = after_select.upper()
    while i < len(up):
        if up[i] == '(':
            depth += 1
        elif up[i] == ')':
            depth -= 1
        elif depth == 0 and up[i:i+4] == 'FROM' and (i == 0 or not up[i-1].isalpha()) and (i+4 >= len(up) or not up[i+4].isalpha()):
            from_pos = i
            break
        i += 1
    col_part = after_select[:from_pos].strip() if from_pos > 0 else after_select.strip()

    # 按逗号分割（忽略括号内的逗号）
    cols = []
    depth = 0
    cur = []
    for ch in col_part:
        if ch == '(':
            depth += 1
            cur.append(ch)
        elif ch == ')':
            depth -= 1
            cur.append(ch)
        elif ch == ',' and depth == 0:
            cols.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if cur:
        cols.append("".join(cur).strip())

    # 从每个列表达式中提取别名
    aliases = []
    for expr in cols:
        expr = expr.strip()
        if not expr:
            continue
        # AS "别名" 或 AS 别名
        import re
        m = re.search(r'\bAS\s+"([^"]+)"\s*$', expr, re.IGNORECASE)
        if m:
            aliases.append(m.group(1))
            continue
        m = re.search(r'\bAS\s+(\S+)\s*$', expr, re.IGNORECASE)
        if m:
            aliases.append(m.group(1))
            continue
        # 无 AS，取最后一个词或带引号的字段名
        m = re.search(r'"([^"]+)"\s*$', expr)
        if m:
            aliases.append(m.group(1))
            continue
        parts = expr.split()
        if parts:
            aliases.append(parts[-1])
    return aliases


def visible_cols(rows, query=""):
    """返回列顺序：优先按 SQL SELECT 顺序，兜底按返回顺序。"""
    if not rows:
        return []
    all_cols = [c for c in rows[0].keys() if not c.startswith("__")]
    sql_cols = extract_sql_cols(query)
    if sql_cols:
        ordered = [c for c in sql_cols if c in all_cols]
        remaining = [c for c in all_cols if c not in ordered]
        return ordered + remaining
    return all_cols


def fmt_sql(query):
    """格式化 SQL：关键字换行、字段分行、CTE 缩进。"""
    if not query:
        return ""
    import re
    sql = query.replace("\\n", "\n")
    flat = " ".join(l.strip() for l in sql.split("\n"))
    flat = re.sub(r'\s+', ' ', flat).strip()

    # 搜索条件 | SQL 分隔
    search_prefix = ""
    parts = flat.split("|", 1)
    if len(parts) == 2:
        search_prefix = parts[0].strip() + " |\n"
        flat = parts[1].strip()

    KW = ('SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY',
          'HAVING', 'LIMIT', 'LEFT JOIN', 'RIGHT JOIN',
          'INNER JOIN', 'JOIN', 'UNION ALL', 'UNION')

    def is_word_boundary(c):
        return not (c.isalnum() or c == '_')

    def split_top_keywords(s, indent):
        """在顶层关键字前插入换行（跳过所有括号内容）。"""
        pad = "  " * indent
        tokens = []
        depth = 0
        i = 0
        while i < len(s):
            if s[i] == '(':
                depth += 1
                tokens.append(s[i]); i += 1
            elif s[i] == ')':
                depth -= 1
                tokens.append(s[i]); i += 1
            elif depth == 0:
                matched = False
                for kw in KW:
                    end = i + len(kw)
                    if s[i:end].upper() == kw:
                        before = s[i-1] if i > 0 else ' '
                        after = s[end] if end < len(s) else ' '
                        if is_word_boundary(before) and is_word_boundary(after):
                            tokens.append(f"\n{pad}{s[i:end]}")
                            i = end; matched = True; break
                if not matched:
                    tokens.append(s[i]); i += 1
            else:
                tokens.append(s[i]); i += 1
        return "".join(tokens).strip()

    def _expand_case_when(field, indent):
        """展开字段中的 CASE WHEN...END 为多行缩进格式。"""
        import re as _re
        up = field.upper()
        if 'CASE' not in up:
            return field
        pad = "  " * indent
        pad1 = "  " * (indent + 1)
        # 找 CASE...END 块（可能有 AS alias 在 END 后面）
        # 在顶层拆分（跳过括号内的 CASE）
        result = []
        depth = 0
        i = 0
        while i < len(field):
            if field[i] == '(':
                depth += 1
                result.append(field[i]); i += 1
            elif field[i] == ')':
                depth -= 1
                result.append(field[i]); i += 1
            elif depth == 0 and field[i:i+4].upper() == 'CASE' and (i == 0 or is_word_boundary(field[i-1])):
                # 找到顶层 CASE，收集到 END
                case_buf = []
                ci = i
                case_depth = 0
                while ci < len(field):
                    if field[ci:ci+4].upper() == 'CASE' and (ci == i or is_word_boundary(field[ci-1])):
                        case_depth += 1
                    if field[ci:ci+3].upper() == 'END' and (ci + 3 >= len(field) or is_word_boundary(field[ci+3])):
                        case_depth -= 1
                        if case_depth == 0:
                            case_buf.append(field[ci:ci+3])
                            ci += 3
                            break
                    case_buf.append(field[ci])
                    ci += 1
                case_str = "".join(case_buf).strip()
                # 格式化 CASE 块：CASE / WHEN / THEN / ELSE / END 各占一行
                case_lines = []
                # 用正则拆分
                parts = _re.split(r'\b(CASE|WHEN|THEN|ELSE|END)\b', case_str, flags=_re.IGNORECASE)
                for pi, p in enumerate(parts):
                    p = p.strip()
                    if not p:
                        continue
                    up_p = p.upper()
                    if up_p == 'CASE':
                        case_lines.append(f"\n{pad}CASE")
                    elif up_p == 'WHEN':
                        case_lines.append(f"\n{pad1}WHEN")
                    elif up_p == 'THEN':
                        case_lines.append(f"\n{pad1}THEN")
                    elif up_p == 'ELSE':
                        case_lines.append(f"\n{pad1}ELSE")
                    elif up_p == 'END':
                        case_lines.append(f"\n{pad}END")
                    else:
                        case_lines.append(f" {p}")
                result.append("".join(case_lines).strip())
                # 剩余部分（AS alias 等）
                i = ci
            else:
                result.append(field[i]); i += 1
        return "".join(result)

    def split_select_fields(s, indent):
        """SELECT 后的字段按逗号分行。"""
        pad = "  " * indent
        pad1 = "  " * (indent + 1)
        lines = s.split("\n")
        result = []
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            up = stripped.upper()
            if up.startswith('SELECT ') and not up.startswith('SELECT *'):
                after = stripped[7:]
                fields = []
                d = 0; cur = []
                for ch in after:
                    if ch == '(': d += 1; cur.append(ch)
                    elif ch == ')': d -= 1; cur.append(ch)
                    elif ch == ',' and d == 0:
                        fields.append("".join(cur).strip()); cur = []
                    else: cur.append(ch)
                if cur:
                    fields.append("".join(cur).strip())
                if len(fields) > 1:
                    result.append(f"{pad}SELECT")
                    for j, f in enumerate(fields):
                        comma = "," if j < len(fields) - 1 else ""
                        expanded = _expand_case_when(f, indent + 2)
                        result.append(f"{pad1}{expanded}{comma}")
                    continue
            result.append(f"{pad}{stripped}")
        return "\n".join(result)

    def format_block(s, indent=0):
        """格式化一个 SQL 块（递归处理子查询和 CTE）。"""
        pad = "  " * indent

        # 1. 先在顶层做关键字换行（跳过括号内）
        kw_done = split_top_keywords(s, indent)

        # 2. CTE 分隔："), name AS (" → 逗号留上一行，CTE 名换行
        kw_done = re.sub(r'\)\s*,\s*(\w+)\s+AS\s*\(', lambda m: f"),\n{pad}{m.group(1)} AS (", kw_done)

        # 3. SELECT 字段分行
        field_done = split_select_fields(kw_done, indent)

        # 4. 递归格式化子查询/CTE 括号内容
        lines = field_done.split("\n")
        result = []
        for line in lines:
            if not line.strip():
                continue
            leading = line[:len(line) - len(line.lstrip())]
            expanded = _expand_subqueries(line.strip(), indent)
            # 展开产生的多行：第一行保持原始 leading，后续行保持自身缩进
            exp_lines = expanded.split("\n")
            for idx_l, sub_line in enumerate(exp_lines):
                if not sub_line.strip():
                    continue
                if idx_l == 0:
                    result.append(leading + sub_line)
                else:
                    result.append(sub_line)

        return "\n".join(result)

    def _expand_subqueries(line, indent):
        """展开一行中的子查询/CTE 括号。"""
        pad = "  " * indent
        # 找顶层的 ( ... ) 对
        out = []
        depth = 0
        buf = []
        is_func = False
        i = 0
        while i < len(line):
            if line[i] == '(':
                if depth == 0:
                    prefix = "".join(out) + "".join(buf)
                    words = prefix.rstrip().upper().split()
                    last = words[-1] if words else ''
                    second = words[-2] if len(words) >= 2 else ''
                    sql_keywords = {'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'UNION', 'WITH', 'INTO', 'SET', 'IN', 'EXISTS', 'NOT'}
                    is_cte = (last == 'AS' and second and second not in sql_keywords)
                    is_sql_kw = last in sql_keywords
                    is_func = (last == 'OVER' or (not is_cte and not is_sql_kw and last and (last[-1].isalnum() or last[-1] == '_')))
                    out.append("".join(buf)); buf = []; depth = 1
                else:
                    buf.append(line[i]); depth += 1
                i += 1
            elif line[i] == ')':
                depth -= 1
                if depth == 0:
                    inner = "".join(buf).strip(); buf = []
                    has_sql = ('SELECT ' in inner.upper()) and not is_func
                    if has_sql:
                        inner_fmt = format_block(inner, indent + 1)
                        out.append(f"(\n{inner_fmt}\n{pad})")
                    else:
                        out.append(f"({inner})")
                    is_func = False
                else:
                    buf.append(line[i])
                i += 1
            else:
                buf.append(line[i]); i += 1
        out.append("".join(buf))
        return "".join(out)

    return search_prefix + format_block(flat)


def compute_section_diff_info(section_sqls):
    """以 section 内第一个 SQL 为基准，计算后续 SQL 与基准的逐行差异。
    返回 list[dict|None]，索引对应 section 内第几个 SQL。
    第一个为 None（不标差异），后续为 {line_idx: (prefix_len, suffix_len)} 或 None（相同行）。
    """
    if len(section_sqls) <= 1:
        return [None] * len(section_sqls)
    formatted = [fmt_sql(q).split("\n") for q in section_sqls]
    base = formatted[0]
    result = [None]  # 第一个不标
    for fi in range(1, len(formatted)):
        cur = formatted[fi]
        info = {}
        max_len = max(len(base), len(cur))
        for li in range(max_len):
            base_line = base[li] if li < len(base) else ""
            cur_line = cur[li] if li < len(cur) else ""
            if base_line == cur_line:
                continue
            # 字符级：公共前缀
            prefix_len = 0
            min_len = min(len(base_line), len(cur_line))
            for ci in range(min_len):
                if base_line[ci] == cur_line[ci]:
                    prefix_len += 1
                else:
                    break
            # 公共后缀
            suffix_len = 0
            for ci in range(1, min_len - prefix_len + 1):
                if base_line[-ci] == cur_line[-ci]:
                    suffix_len += 1
                else:
                    break
            info[li] = (prefix_len, suffix_len)
        result.append(info if info else None)
    return result


LAYOUT_KEYS = ("xPos", "yPos", "width", "height")


def chart_layout(chart):
    d = chart.get("display", {})
    return {k: d.get(k) for k in LAYOUT_KEYS}


def fmt_layout(layout):
    if not layout:
        return ""
    return ", ".join(f"{k}={layout.get(k, '')}" for k in LAYOUT_KEYS)


def chart_info(chart, section="", default_project=""):
    qs = chart.get("search", {}).get("chartQueries", [])
    q0 = qs[0] if qs else {}
    return {
        "title": chart.get("title", ""),
        "display_name": get_display_name(chart),
        "type": chart.get("type", ""),
        "section": section,
        "layout": chart_layout(chart),
        "query": q0.get("query", ""),
        "project": q0.get("project", default_project),
        "logstore": q0.get("logstore", ""),
    }


def load_git_head_sqls(dashboard_json_path):
    """加载 git HEAD 版本的 dashboard.json，返回 {chart_title: chart_info}；无法加载时返回 None。"""
    try:
        # git show HEAD: 需要相对于 git 仓库根目录的路径
        git_root = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5
        ).stdout.strip()
        rel_path = dashboard_json_path.resolve().relative_to(Path(git_root))
        r = subprocess.run(
            ["git", "show", f"HEAD:{rel_path}"],
            capture_output=True, text=True, timeout=5, cwd=git_root
        )
        if r.returncode == 0:
            old = json.loads(r.stdout)
            result = {}
            section = "_top"
            old_charts = sorted(
                old.get("charts", []),
                key=lambda c: (c.get("display", {}).get("yPos", 0), c.get("display", {}).get("xPos", 0)),
            )
            for c in old_charts:
                if c.get("type") == "dashboardrow":
                    section = get_display_name(c)
                    continue
                title = c.get("title", "")
                if title:
                    result[title] = chart_info(c, section)
            return result
    except Exception:
        pass
    return None


def _side_by_side_sql(old_sql, new_sql):
    """生成左右对比的 SQL HTML。"""
    old_lines = fmt_sql(old_sql).split("\n") if old_sql else []
    new_lines = fmt_sql(new_sql).split("\n") if new_sql else []
    max_len = max(len(old_lines), len(new_lines))
    rows = []
    for i in range(max_len):
        ol = old_lines[i] if i < len(old_lines) else ""
        nl = new_lines[i] if i < len(new_lines) else ""
        if ol == nl:
            cls = ""
        else:
            cls = ' class="diff-changed"'
        rows.append(f"<tr{cls}><td><pre>{esc(ol)}</pre></td><td><pre>{esc(nl)}</pre></td></tr>")
    return "".join(rows)


def _build_result_grid(old_rows, new_rows, old_sql="", new_sql=""):
    """构建左右独立滚动、行对齐、差异高亮的结果对比。"""
    if not old_rows and not new_rows:
        return '<p class="muted">无数据</p>'

    old_cols = visible_cols(old_rows, old_sql) if old_rows else []
    new_cols = visible_cols(new_rows, new_sql) if new_rows else []

    def get_key(r, cols):
        return str(r.get(cols[0], "")) if cols else ""

    def fmt_cell(v, col):
        if col in RAW_NUM_COLS:
            return str(v) if v is not None else ""
        if is_num(v):
            return fmt_num(v)
        return str(v) if v is not None else ""

    old_list = (old_rows or [])[:MAX_ROWS]
    new_list = (new_rows or [])[:MAX_ROWS]

    old_by_key = {}
    for r in old_list:
        k = get_key(r, old_cols)
        old_by_key.setdefault(k, []).append(r)

    new_by_key = {}
    for r in new_list:
        k = get_key(r, new_cols)
        new_by_key.setdefault(k, []).append(r)

    seen = set()
    all_keys = []
    for r in old_list + new_list:
        cols_for_key = old_cols if old_cols else new_cols
        k = get_key(r, cols_for_key)
        if k not in seen:
            seen.add(k)
            all_keys.append(k)

    def build_panel(cols, by_key, other_by_key, rows_list):
        hdr = "".join(f"<th>{esc(c)}</th>" for c in cols)
        trs = []
        for k in all_keys:
            r = by_key.get(k, [None])[0]
            other_r = other_by_key.get(k, [None])[0]
            cells = ""
            for col in cols:
                v = fmt_cell(r.get(col) if r else None, col)
                # 比对：在对方同 key 行中找同名列
                ov = fmt_cell(other_r.get(col) if other_r else None, col) if col in (visible_cols([other_r], "") if other_r else []) else ""
                diff_cls = " diff-val" if (r is not None and other_r is not None and v != ov) else ""
                r_cls = " r" if (col not in RAW_NUM_COLS and r and is_num(r.get(col))) else ""
                cls = f' class="{(r_cls + diff_cls).strip()}"' if (r_cls + diff_cls).strip() else ""
                cells += f"<td{cls}>{esc(v)}</td>"
            row_cls = ""
            if r is None:
                row_cls = ' class="diff-row-del"'
                cells = "".join(f"<td></td>" for _ in cols)
            elif other_r is None:
                row_cls = ' class="diff-row-add"'
            trs.append(f"<tr{row_cls}>{cells}</tr>")
        note = ""
        if rows_list and len(rows_list) > MAX_ROWS:
            note = f'<div class="muted small">显示前 {MAX_ROWS} 行，共 {len(rows_list)} 行</div>'
        return f'<table class="diff-result-table"><thead><tr>{hdr}</tr></thead><tbody>{"".join(trs)}</tbody></table>{note}'

    old_panel = build_panel(old_cols, old_by_key, new_by_key, old_rows)
    new_panel = build_panel(new_cols, new_by_key, old_by_key, new_rows)

    return f'''<div class="diff-result-wrap">
<div class="diff-result-panel"><div class="diff-result-panel-title">committed</div>{old_panel}</div>
<div class="diff-result-panel"><div class="diff-result-panel-title">current</div>{new_panel}</div>
</div>'''


def _build_single_result_table(rows, sql=""):
    if rows is None:
        return '<p class="muted">当前查询未执行或执行失败</p>'
    if not rows:
        return '<p class="muted">无数据</p>'

    cols = visible_cols(rows, sql)
    hdr = "".join(f"<th>{esc(c)}</th>" for c in cols)
    trs = []
    for row in rows[:MAX_ROWS]:
        cells = ""
        for col in cols:
            v = row.get(col, "")
            if col not in RAW_NUM_COLS and is_num(v):
                cells += f'<td class="r">{fmt_num(v)}</td>'
            else:
                cells += f"<td>{esc(v)}</td>"
        trs.append(f"<tr>{cells}</tr>")
    note = f'<div class="muted small">显示前 {MAX_ROWS} 行，共 {len(rows)} 行</div>' if len(rows) > MAX_ROWS else ""
    return f'<table class="diff-result-table"><thead><tr>{hdr}</tr></thead><tbody>{"".join(trs)}</tbody></table>{note}'


def _build_added_result_grid(new_rows, new_sql=""):
    current = _build_single_result_table(new_rows, new_sql)
    return f'''<div class="diff-result-wrap">
<div class="diff-result-panel"><div class="diff-result-panel-title">committed</div><p class="muted">图表不存在</p></div>
<div class="diff-result-panel"><div class="diff-result-panel-title">current</div>{current}</div>
</div>'''


def _meta_value(info, key):
    if not info:
        return ""
    if key == "layout":
        return fmt_layout(info.get("layout", {}))
    return str(info.get(key, "") or "")


def _meta_diff_rows(old_info=None, new_info=None):
    fields = [
        ("图表标题", "display_name"),
        ("内部 title", "title"),
        ("图表类型", "type"),
        ("Section", "section"),
        ("Layout", "layout"),
    ]
    rows = []
    for label, key in fields:
        old_v = _meta_value(old_info, key)
        new_v = _meta_value(new_info, key)
        if old_v != new_v:
            rows.append((label, old_v, new_v))
    return rows


def has_meta_diff(old_info=None, new_info=None):
    return bool(_meta_diff_rows(old_info, new_info))


def render_meta_diff(old_info=None, new_info=None):
    rows = _meta_diff_rows(old_info, new_info)
    if not rows:
        return ""
    trs = "".join(
        f"<tr><th>{esc(label)}</th><td>{esc(old_v)}</td><td>{esc(new_v)}</td></tr>"
        for label, old_v, new_v in rows
    )
    return f'''<table class="change-meta">
<thead><tr><th>字段</th><th>committed</th><th>current</th></tr></thead>
<tbody>{trs}</tbody></table>'''


def render_added_chart_diff(chart_name, new_sql, new_rows=None, new_info=None, err=None):
    meta = render_meta_diff(None, new_info)
    meta_details = f'''<details class="sql-details">
<summary>变更信息</summary>
{meta}
</details>''' if meta else ""
    sql_rows = _side_by_side_sql("", new_sql)
    if err:
        result_html = f'<div class="err">{esc(err)}</div>'
    else:
        result_html = _build_added_result_grid(new_rows, new_sql)
    return f'''<div class="diff-full diff-added">
<div class="change-badge added">Added chart</div>
<div class="change-title">{esc(chart_name)}</div>
{meta_details}
<details class="sql-details">
<summary>📊 {esc(chart_name)} — SQL Diff (vs committed)</summary>
<div class="diff-container">
<table class="diff-table"><thead><tr><th>committed</th><th>current</th></tr></thead><tbody>{sql_rows}</tbody></table>
</div>
</details>
<details class="sql-details">
<summary>📊 {esc(chart_name)} — 结果 Diff (vs committed)</summary>
{result_html}
</details>
</div>'''


def render_removed_chart_diff(old_info):
    old_sql = old_info.get("query", "") if old_info else ""
    chart_name = old_info.get("display_name") or old_info.get("title") or "removed chart"
    meta = render_meta_diff(old_info, None)
    sql_html = f'<pre class="sql-pre">{esc(fmt_sql(old_sql))}</pre>' if old_sql else '<p class="muted">无 SQL</p>'
    return f'''<div class="diff-full diff-removed">
<div class="change-badge removed">Removed chart</div>
<div class="change-title">{esc(chart_name)}</div>
<details class="sql-details">
<summary>变更信息</summary>
{meta}
</details>
<details class="sql-details">
<summary>committed SQL</summary>
{sql_html}
</details>
</div>'''


def render_layout_summary(changes):
    if not changes:
        return ""
    rows = []
    for chart_name, old_info, new_info in changes:
        rows.append(
            "<tr>"
            f"<td>{esc(chart_name)}</td>"
            f"<td>{esc(_meta_value(old_info, 'section'))}</td>"
            f"<td>{esc(_meta_value(new_info, 'section'))}</td>"
            f"<td>{esc(_meta_value(old_info, 'layout'))}</td>"
            f"<td>{esc(_meta_value(new_info, 'layout'))}</td>"
            "</tr>"
        )
    return f'''<div class="diff-full diff-layout">
<div class="change-badge layout">Layout changes</div>
<div class="change-title">仅布局或元信息变化的图表</div>
<details class="sql-details">
<summary>Layout Diff</summary>
<div class="diff-container">
<table class="change-meta"><thead><tr><th>图表</th><th>committed section</th><th>current section</th><th>committed layout</th><th>current layout</th></tr></thead>
<tbody>{"".join(rows)}</tbody></table>
</div>
</details>
</div>'''


def render_sql_diff(chart_name, old_sql, new_sql, old_rows=None, new_rows=None, old_info=None, new_info=None):
    """渲染全宽的左右对比 diff 块（SQL + 结果），作为独立 grid 行。"""
    if not old_sql or old_sql == new_sql:
        return ""

    sql_rows = _side_by_side_sql(old_sql, new_sql)
    result_html = _build_result_grid(old_rows, new_rows, old_sql, new_sql)
    meta = render_meta_diff(old_info, new_info)
    meta_details = f'''<details class="sql-details">
<summary>变更信息</summary>
{meta}
</details>''' if meta else ""

    return f'''<div class="diff-full">
<div class="change-badge changed">Changed chart</div>
<div class="change-title">{esc(chart_name)}</div>
{meta_details}
<details class="sql-details">
<summary>📊 {esc(chart_name)} — SQL Diff (vs committed)</summary>
<div class="diff-container">
<table class="diff-table"><thead><tr><th>committed</th><th>current</th></tr></thead><tbody>{sql_rows}</tbody></table>
</div>
</details>
<details class="sql-details">
<summary>📊 {esc(chart_name)} — 结果 Diff (vs committed)</summary>
{result_html}
</details>
</div>'''


def render_sql(query, elapsed=None, diff_info=None):
    if not query:
        return ""
    formatted_text = fmt_sql(query)
    raw = esc(query.replace("\\n", "\n"))
    time_tag = f'<span class="sql-time">{elapsed}s (含CLI)</span>' if elapsed is not None else ""

    if diff_info is not None:
        lines = formatted_text.split("\n")
        highlighted = []
        for i, line in enumerate(lines):
            if i not in diff_info or diff_info[i] is None:
                highlighted.append(esc(line))
            else:
                prefix_len, suffix_len = diff_info[i]
                if suffix_len == 0:
                    pre = line[:prefix_len]
                    mid = line[prefix_len:]
                    suf = ""
                else:
                    pre = line[:prefix_len]
                    mid = line[prefix_len:-suffix_len] if suffix_len else line[prefix_len:]
                    suf = line[-suffix_len:]
                highlighted.append(f'{esc(pre)}<span class="sql-diff">{esc(mid)}</span>{esc(suf)}')
        content = "\n".join(highlighted)
    else:
        content = esc(formatted_text)

    return f'''<details class="sql-details">
<summary>SQL {time_tag}<button class="copy-btn" onclick="(function(b){{var t=b.parentElement.nextElementSibling;navigator.clipboard.writeText(t.getAttribute('data-raw'));b.textContent='已复制';setTimeout(function(){{b.textContent='复制'}},1500)}})(this)">复制</button></summary>
<pre class="sql-pre" data-raw="{raw}">{content}</pre></details>'''


# ── renderers ──

def render_static(chart, query="", elapsed=None, diff_info=None):
    name = esc(get_display_name(chart))
    d = chart.get("display", {})
    content = d.get("text") or d.get("markdownStr") or get_doc_text(chart) or ""
    if not content:
        content = chart.get("title", "")
    sql_h = render_sql(query, elapsed, diff_info)
    return f'''<div class="block">
<h3>{name}</h3>
<div style="white-space:pre-wrap;color:#555;line-height:1.7">{esc(content)}</div>
{sql_h}
</div>'''

def render_stat(chart, rows, query="", elapsed=None, diff_info=None):
    name = esc(get_display_name(chart)) + render_cte_tag(query)
    d = chart.get("display", {})
    a_opt = d.get("queryOptionMap", {}).get("A", {})
    show_fields = a_opt.get("showField", [])
    cf = a_opt.get("compareField", "")
    cd = a_opt.get("compareValueDescription", "")
    fmt = d.get("standardOption", {}).get("format", "none")
    unit = d.get("standardOption", {}).get("unit", {})
    cu = unit.get("customUnit", "") if unit.get("unit") == "custom" else ""
    doc = esc(get_doc_text(chart))
    sql_h = render_sql(query, elapsed, diff_info)

    if not rows:
        return f'<div class="card"><div class="card-t">{name}</div><div class="card-v">-</div>{sql_h}</div>'

    row = rows[0]
    mf = show_fields[0] if show_fields else list(row.keys())[0]
    mv = row.get(mf, "-")
    if fmt == "KMB" and is_num(mv):
        dv = fmt_num(mv)
    elif cu and is_num(mv):
        dv = f"{mv}{cu}"
    else:
        dv = str(mv) if mv is not None else "-"

    cmp = ""
    if cf and cf in row and is_num(row[cf]):
        cv = float(row[cf])
        arrow = "▲" if cv > 0 else "▼" if cv < 0 else "—"
        color = "#e74c3c" if cv > 0 else "#27ae60" if cv < 0 else "#999"
        cmp = f'<div class="card-c" style="color:{color}">{arrow} {abs(cv):.2f}% <span class="card-cd">{esc(cd)}</span></div>'

    doc_h = f'<div class="card-doc">{doc}</div>' if doc else ""
    return f'<div class="card"><div class="card-t">{name}</div><div class="card-v">{esc(dv)}</div>{cmp}{doc_h}{sql_h}</div>'


def render_table(chart, rows, query="", elapsed=None, diff_info=None):
    name = esc(get_display_name(chart)) + render_cte_tag(query)
    doc = esc(get_doc_text(chart))
    w = chart.get("display", {}).get("width", 12)
    wide = ""

    if not rows:
        return f'<div class="block{wide}"><h3>{name}</h3><p class="muted">无数据</p></div>'

    cols = visible_cols(rows, query)
    hdr = "".join(f"<th>{esc(c)}</th>" for c in cols)
    trs = []
    for row in rows[:MAX_ROWS]:
        cells = ""
        for c in cols:
            v = row.get(c, "")
            if c in RAW_NUM_COLS:
                cells += f"<td>{esc(v)}</td>"
            elif is_num(v):
                cells += f'<td class="r">{fmt_num(v)}</td>'
            else:
                cells += f"<td>{esc(v)}</td>"
        trs.append(f"<tr>{cells}</tr>")

    note = f'<div class="muted small">显示前 {MAX_ROWS} 行，共 {len(rows)} 行</div>' if len(rows) > MAX_ROWS else ""
    doc_h = f'<div class="doc">{doc}</div>' if doc else ""
    sql_h = render_sql(query, elapsed, diff_info)
    return f'''<div class="block{wide}"><h3>{name}</h3>{doc_h}
<div class="tbl-wrap"><table><thead><tr>{hdr}</tr></thead><tbody>{"".join(trs)}</tbody></table></div>{note}{sql_h}</div>'''


def render_bar(chart, rows, query="", elapsed=None, diff_info=None):
    name = esc(get_display_name(chart)) + render_cte_tag(query)
    doc = esc(get_doc_text(chart))
    d = chart.get("display", {})
    qom = d.get("queryOptionMap", {}).get("A", {})
    w = d.get("width", 12)
    wide = ""
    horiz = d.get("barOptions", {}).get("orientation") == "horizontal"

    if not rows:
        return f'<div class="block{wide}"><h3>{name}</h3><p class="muted">无数据</p></div>'

    rows = rows[:MAX_ROWS]
    cols = visible_cols(rows, query)
    x_key = qom.get("xAxisKey") or (cols[0] if cols else "")
    y_keys = qom.get("yAxisKeys", [])
    if not y_keys:
        y_keys = [c for c in cols if c != x_key and is_num(rows[0].get(c))]
    y_key = y_keys[0] if y_keys else (cols[1] if len(cols) > 1 else "")

    vals = [float(r.get(y_key, 0)) if is_num(r.get(y_key)) else 0 for r in rows]
    max_v = max(vals) if vals else 1
    if max_v == 0:
        max_v = 1

    doc_h = f'<div class="doc">{doc}</div>' if doc else ""
    bars = []
    for r, v in zip(rows, vals):
        label = esc(str(r.get(x_key, "")))
        pct = v / max_v * 100
        fv = fmt_num(v)
        bars.append(f'<div class="bar-row"><span class="bar-label">{label}</span>'
                     f'<div class="bar-track"><div class="bar-fill" style="width:{pct:.1f}%"></div></div>'
                     f'<span class="bar-val">{fv}</span></div>')

    sql_h = render_sql(query, elapsed, diff_info)
    return f'<div class="block{wide}"><h3>{name}</h3>{doc_h}<div class="bar-chart">{"".join(bars)}</div>{sql_h}</div>'


def render_line_as_table(chart, rows, query="", elapsed=None, diff_info=None):
    name = esc(get_display_name(chart)) + render_cte_tag(query)
    doc = esc(get_doc_text(chart))
    d = chart.get("display", {})
    qom = d.get("queryOptionMap", {}).get("A", {})

    if not rows:
        return f'<div class="block"><h3>{name}</h3><p class="muted">无数据</p></div>'

    rows = rows[:MAX_ROWS]
    x_key = qom.get("xAxisKey", "t")
    y_keys = qom.get("yAxisKeys", [])
    cols = visible_cols(rows, query)
    if not y_keys:
        y_keys = [c for c in cols if c != x_key and is_num(rows[0].get(c))]
    show_cols = [x_key] + y_keys

    hdr = "".join(f"<th>{esc(c)}</th>" for c in show_cols)
    trs = []
    for row in rows:
        cells = []
        for c in show_cols:
            v = row.get(c, "")
            if c == x_key:
                label = str(v)
                if is_num(v) and float(v) > 1e9:
                    try:
                        label = datetime.fromtimestamp(int(float(v))).strftime("%m-%d")
                    except Exception:
                        pass
                cells.append(f"<td>{esc(label)}</td>")
            elif c in RAW_NUM_COLS:
                cells.append(f"<td>{esc(v)}</td>")
            elif is_num(v):
                cells.append(f'<td class="r">{fmt_num(v)}</td>')
            else:
                cells.append(f"<td>{esc(v)}</td>")
        trs.append(f"<tr>{''.join(cells)}</tr>")

    # sparklines via CSS
    sparklines = []
    for yk in y_keys:
        vals = [float(r.get(yk, 0)) if is_num(r.get(yk)) else 0 for r in rows]
        max_v = max(vals) if vals else 1
        if max_v == 0:
            max_v = 1
        dots = []
        n = len(vals)
        for i, v in enumerate(vals):
            x_pct = i / max(n - 1, 1) * 100
            y_pct = 100 - v / max_v * 80
            dots.append(f'<div class="spark-dot" style="left:{x_pct:.1f}%;bottom:{v/max_v*80:.1f}%" title="{fmt_num(v)}"></div>')
        sparklines.append(f'<div class="spark-row"><span class="spark-label">{esc(yk)}</span><div class="spark-box">{"".join(dots)}</div></div>')

    doc_h = f'<div class="doc">{doc}</div>' if doc else ""
    spark_html = f'<div class="spark-group">{"".join(sparklines)}</div>' if sparklines else ""
    sql_h = render_sql(query, elapsed, diff_info)
    return f'''<div class="block"><h3>{name}</h3>{doc_h}{spark_html}
<div class="tbl-wrap"><table><thead><tr>{hdr}</tr></thead><tbody>{"".join(trs)}</tbody></table></div>{sql_h}</div>'''


def render_pie_as_bar(chart, rows, query="", elapsed=None, diff_info=None):
    name = esc(get_display_name(chart)) + render_cte_tag(query)
    doc = esc(get_doc_text(chart))
    d = chart.get("display", {})
    qom = d.get("queryOptionMap", {}).get("A", {})

    if not rows:
        return f'<div class="block"><h3>{name}</h3><p class="muted">无数据</p></div>'

    rows = rows[:MAX_ROWS]
    cols = visible_cols(rows, query)
    show_key = qom.get("showFieldKey") or (cols[0] if cols else "")
    num_key = qom.get("numFieldKey") or next((c for c in cols if c != show_key and is_num(rows[0].get(c))), cols[-1] if cols else "")

    vals = [float(r.get(num_key, 0)) if is_num(r.get(num_key)) else 0 for r in rows]
    total = sum(vals) or 1

    colors = ["#3498db", "#2ecc71", "#e74c3c", "#f39c12", "#9b59b6", "#1abc9c", "#e67e22", "#34495e", "#16a085", "#c0392b", "#8e44ad", "#2c3e50"]
    doc_h = f'<div class="doc">{doc}</div>' if doc else ""
    items = []
    for i, (r, v) in enumerate(zip(rows, vals)):
        label = esc(str(r.get(show_key, "")))
        pct = v / total * 100
        color = colors[i % len(colors)]
        items.append(f'<div class="pie-row"><span class="pie-color" style="background:{color}"></span>'
                      f'<span class="pie-label">{label}</span>'
                      f'<span class="pie-pct">{pct:.1f}%</span>'
                      f'<span class="pie-val">{fmt_num(v)}</span></div>')

    stacked = ""
    acc = 0
    for i, v in enumerate(vals[:12]):
        pct = v / total * 100
        color = colors[i % len(colors)]
        seg_label = esc(str(rows[i].get(show_key, "")))
        stacked += f'<div class="pie-seg" style="width:{pct:.1f}%;background:{color}" title="{seg_label} {pct:.1f}%"></div>'
        acc += pct

    sql_h = render_sql(query, elapsed, diff_info)
    return f'''<div class="block"><h3>{name}</h3>{doc_h}
<div class="pie-bar">{stacked}</div>
<div class="pie-legend">{"".join(items)}</div>{sql_h}</div>'''


def render_agg(chart, rows, query="", elapsed=None, diff_info=None):
    name = esc(get_display_name(chart)) + render_cte_tag(query)
    doc = esc(get_doc_text(chart))
    d = chart.get("display", {})
    qom = d.get("queryOptionMap", {}).get("A", {})

    if not rows:
        return f'<div class="block"><h3>{name}</h3><p class="muted">无数据</p></div>'

    x_key = qom.get("xAxisKey", "t")
    agg_field = qom.get("aggField", "")
    y_key = qom.get("yAxisKey", "")
    cols = visible_cols(rows, query)
    if not agg_field:
        agg_field = next((c for c in cols if c != x_key and not is_num(rows[0].get(c))), "")
    if not y_key:
        y_key = next((c for c in cols if c not in (x_key, agg_field) and is_num(rows[0].get(c))), "")

    groups = {}
    x_vals_ordered = []
    for r in rows:
        x = str(r.get(x_key, ""))
        g = str(r.get(agg_field, ""))
        v = float(r.get(y_key, 0)) if is_num(r.get(y_key)) else 0
        if x not in x_vals_ordered:
            x_vals_ordered.append(x)
        groups.setdefault(g, {})[x] = v

    totals = {g: sum(d.values()) for g, d in groups.items()}
    sorted_groups = sorted(totals, key=lambda g: -totals[g])[:10]

    hdr = f"<th>{esc(x_key)}</th>" + "".join(f"<th>{esc(g)}</th>" for g in sorted_groups)
    trs = []
    for x in x_vals_ordered:
        label = x
        if is_num(x) and float(x) > 1e9:
            try:
                label = datetime.fromtimestamp(int(float(x))).strftime("%m-%d")
            except Exception:
                pass
        cells = f"<td>{esc(label)}</td>"
        cells += "".join(f'<td class="r">{fmt_num(groups.get(g, {}).get(x, 0))}</td>' for g in sorted_groups)
        trs.append(f"<tr>{cells}</tr>")

    doc_h = f'<div class="doc">{doc}</div>' if doc else ""
    note = f'<div class="muted small">显示 Top {len(sorted_groups)} 分组（共 {len(groups)} 个）</div>' if len(groups) > len(sorted_groups) else ""
    sql_h = render_sql(query, elapsed, diff_info)
    return f'''<div class="block"><h3>{name}</h3>{doc_h}
<div class="tbl-wrap"><table><thead><tr>{hdr}</tr></thead><tbody>{"".join(trs)}</tbody></table></div>{note}{sql_h}</div>'''


HTML_TEMPLATE = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;color:#2c3e50;padding:20px;max-width:1400px;margin:0 auto}}
.hdr{{background:#fff;border-radius:8px;padding:20px 28px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}}
.hdr h1{{font-size:20px;margin-bottom:6px}}
.hdr .meta{{color:#888;font-size:12px}}
.sec{{background:#34495e;color:#fff;padding:8px 18px;border-radius:6px;font-size:15px;font-weight:600;margin:20px 0 8px}}
.dash-grid{{display:grid;grid-template-columns:repeat(24,1fr);gap:8px;margin-bottom:14px}}
.dash-grid>.card,.dash-grid>.block{{min-width:0}}
.card{{background:#fff;border-radius:8px;padding:14px 18px;box-shadow:0 1px 3px rgba(0,0,0,.06)}}
.card-t{{font-size:12px;color:#888;margin-bottom:6px}}
.card-v{{font-size:26px;font-weight:700}}
.card-c{{font-size:12px;margin-top:3px}}
.card-cd{{color:#aaa;margin-left:3px}}
.card-doc{{font-size:10px;color:#bbb;margin-top:5px;border-top:1px solid #f0f0f0;padding-top:3px}}
.block{{background:#fff;border-radius:8px;padding:14px 18px;box-shadow:0 1px 3px rgba(0,0,0,.06)}}
.block h3{{font-size:13px;color:#2c3e50;margin-bottom:6px}}
.doc{{font-size:10px;color:#bbb;margin-bottom:6px}}
.muted{{color:#999;font-size:12px}}.small{{font-size:11px;margin-top:4px}}
.tbl-wrap{{overflow-x:auto}}
table{{border-collapse:collapse;width:100%;font-size:12px}}
th{{background:#f8f9fa;padding:6px 10px;text-align:left;border-bottom:2px solid #e0e0e0;white-space:nowrap;font-weight:600}}
td{{padding:5px 10px;border-bottom:1px solid #f0f0f0;white-space:nowrap}}
td.r{{text-align:right;font-variant-numeric:tabular-nums}}
tr:hover td{{background:#fafbfc}}
.bar-chart{{margin:6px 0}}
.bar-row{{display:flex;align-items:center;margin-bottom:3px;font-size:12px}}
.bar-label{{width:120px;text-align:right;padding-right:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}}
.bar-track{{flex:1;height:18px;background:#f0f2f5;border-radius:3px;overflow:hidden}}
.bar-fill{{height:100%;background:linear-gradient(90deg,#3498db,#2980b9);border-radius:3px;transition:width .3s}}
.bar-val{{width:70px;text-align:right;padding-left:6px;font-variant-numeric:tabular-nums;flex-shrink:0}}
.pie-bar{{display:flex;height:20px;border-radius:4px;overflow:hidden;margin:8px 0}}
.pie-seg{{height:100%;min-width:2px}}
.pie-legend{{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;margin-top:6px}}
.pie-row{{display:flex;align-items:center;gap:4px}}
.pie-color{{width:10px;height:10px;border-radius:2px;flex-shrink:0}}
.pie-label{{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.pie-pct{{color:#888;font-variant-numeric:tabular-nums}}
.pie-val{{color:#aaa;font-variant-numeric:tabular-nums}}
.spark-group{{margin:6px 0 10px}}
.spark-row{{display:flex;align-items:center;margin-bottom:4px}}
.spark-label{{width:120px;font-size:11px;text-align:right;padding-right:8px;color:#666}}
.spark-box{{flex:1;height:24px;background:#f8f9fa;border-radius:3px;position:relative;overflow:hidden}}
.spark-dot{{position:absolute;width:5px;height:5px;background:#3498db;border-radius:50%}}
.cte-tag{{display:inline-block;background:#e8f4fd;color:#2980b9;font-size:10px;padding:1px 6px;border-radius:3px;font-weight:400;vertical-align:middle;margin-left:2px}}
.sql-details{{margin-top:8px}}
.sql-details summary{{font-size:11px;color:#888;cursor:pointer;user-select:none;display:flex;align-items:center;gap:8px}}
.sql-details summary:hover{{color:#3498db}}
.sql-time{{font-size:10px;color:#999;margin-left:4px}}
.copy-btn{{margin-left:auto;font-size:10px;padding:1px 8px;border:1px solid #ccc;border-radius:3px;background:#fff;color:#666;cursor:pointer}}
.copy-btn:hover{{background:#f0f0f0;color:#333}}
.sql-diff{{background:#fff3cd;border-radius:2px;padding:0 2px}}
.diff-full{{background:#fff;border-radius:8px;padding:14px 18px;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:3px solid #f39c12}}
.diff-added{{border-left-color:#2ecc71}}
.diff-removed{{border-left-color:#e74c3c}}
.diff-layout{{border-left-color:#3498db}}
.change-badge{{display:inline-block;color:#fff;font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px;margin-bottom:6px;background:#f39c12}}
.change-badge.added{{background:#2ecc71}}
.change-badge.removed{{background:#e74c3c}}
.change-badge.layout{{background:#3498db}}
.change-title{{font-size:14px;font-weight:700;color:#2c3e50;margin-bottom:8px}}
.change-meta{{width:100%;border-collapse:collapse;font-size:11px;margin:6px 0 10px}}
.change-meta th{{background:#f8f9fa;color:#555;font-weight:600}}
.change-meta th,.change-meta td{{padding:5px 8px;border-bottom:1px solid #eee;vertical-align:top;white-space:normal}}
.diff-container{{overflow-x:auto;margin-top:4px}}
.diff-table{{width:100%;table-layout:fixed;border-collapse:collapse;font-size:11px}}
.diff-table th{{background:#f0f0f0;padding:4px 8px;text-align:left;font-weight:600;width:50%;border-bottom:2px solid #ddd}}
.diff-table td{{padding:2px 6px;vertical-align:top;border-bottom:1px solid #f0f0f0;width:50%}}
.diff-table td pre{{margin:0;white-space:pre-wrap;word-break:break-all;font-size:11px;font-family:Menlo,Monaco,Consolas,monospace}}
.diff-changed td{{background:#fff8e1}}
.diff-result-wrap{{display:grid;grid-template-columns:1fr 1fr;gap:0}}
.diff-result-panel{{overflow-x:auto;border:1px solid #e8e8e8;border-radius:4px}}
.diff-result-panel:first-child{{border-right:none;border-radius:4px 0 0 4px}}
.diff-result-panel:last-child{{border-left:3px solid #ccc;border-radius:0 4px 4px 0}}
.diff-result-panel-title{{background:#f0f0f0;text-align:center;font-size:11px;font-weight:600;color:#555;padding:4px;position:sticky;top:0;z-index:1}}
.diff-result-table{{border-collapse:collapse;width:100%;font-size:11px}}
.diff-result-table th,.diff-result-table td{{padding:4px 8px;border-bottom:1px solid #eee;white-space:nowrap}}
.diff-result-table td.r{{text-align:right;font-variant-numeric:tabular-nums}}
.diff-val{{background:#fff3cd;font-weight:600}}
.diff-row-add td{{background:#dfd}}
.diff-row-del td{{background:#fdd}}
.sql-pre{{background:#f8f9fa;border:1px solid #e8e8e8;border-radius:4px;padding:10px 12px;font-size:11px;line-height:1.5;overflow-x:auto;white-space:pre-wrap;word-break:break-all;color:#555;margin-top:4px;font-family:Menlo,Monaco,Consolas,monospace}}
.err{{color:#e74c3c;font-size:12px;padding:6px;background:#fdf0ef;border-radius:4px}}
.ft{{text-align:center;color:#aaa;font-size:11px;margin-top:28px;padding:14px}}
</style>
</head>
<body>
<div class="hdr"><h1>{title}</h1><div class="meta">{time_range} &nbsp;|&nbsp; {generated_at} &nbsp;|&nbsp; {chart_count} 个图表</div></div>
{body}
<div class="ft">render_report.py &nbsp;|&nbsp; {project}</div>
</body>
</html>'''


def resolve_paths(args):
    if args.dashboard_json:
        dashboard_json = args.dashboard_json
    elif args.case_dir and args.scenario:
        dashboard_json = args.case_dir / "output" / f"{args.scenario}-dashboard.json"
    else:
        raise SystemExit("必须提供 --dashboard，或同时提供 --case-dir 与 scenario")

    if args.output:
        output_html = args.output
    elif args.case_dir and args.scenario:
        output_html = args.case_dir / "output" / f"{args.scenario}-report.html"
    else:
        name = dashboard_json.name
        suffix = "-dashboard.json"
        if name.endswith(suffix):
            name = name[:-len(suffix)] + "-report.html"
        else:
            name = dashboard_json.stem + "-report.html"
        output_html = dashboard_json.with_name(name)
    return dashboard_json, output_html


def main():
    args = parse_args()
    dashboard_json, output_html = resolve_paths(args)

    if not dashboard_json.exists():
        print(f"错误: {dashboard_json} 不存在")
        return
    output_html.parent.mkdir(parents=True, exist_ok=True)

    dashboard = load_dashboard(dashboard_json)
    ts_from, ts_to = get_time_range(args, dashboard)
    dashboard_title = dashboard.get("displayName", "SLS Report")
    charts = dashboard.get("charts", [])

    scenario_label = args.scenario or dashboard_json.stem
    print(f"大盘: {dashboard_title} ({scenario_label})")
    print(f"时间: {time_str(ts_from, ts_to)}")
    print(f"图表: {len(charts)} 个\n")

    charts.sort(key=lambda c: (c.get("display", {}).get("yPos", 0), c.get("display", {}).get("xPos", 0)))

    # 加载 git HEAD 版本的 SQL 用于 diff
    head_sqls = load_git_head_sqls(dashboard_json) if args.with_diff else None
    diff_enabled = args.with_diff and head_sqls is not None
    if args.with_diff and head_sqls is None:
        print("  diff: 未找到 git HEAD baseline，跳过 diff。")
    current_titles = {
        c.get("title", "")
        for c in charts
        if c.get("title") and c.get("type") != "dashboardrow"
    }
    layout_changes = []

    # ── Phase 1: 并行查询所有数据（含旧 SQL diff 查询）──
    query_tasks = []  # (chart_index, chart, sql, project, logstore, is_old)
    changed_titles = set()
    for i, c in enumerate(charts):
        if c.get("type") == "dashboardrow":
            continue
        qs = c.get("search", {}).get("chartQueries", [])
        if not qs:
            continue
        q0 = qs[0]
        chart_title = c.get("title", "")
        sql = q0.get("query", "")
        proj = q0.get("project", args.default_project)
        ls = q0.get("logstore", "")
        query_tasks.append((i, c, sql, proj, ls, False))
        # 如果旧 SQL 不同，也加入查询队列
        old_info = head_sqls.get(chart_title, {}) if diff_enabled else {}
        old_sql = old_info.get("query", "") if old_info else ""
        if old_sql and old_sql != sql:
            changed_titles.add(chart_title)
            query_tasks.append((i, c, old_sql, old_info.get("project", proj), old_info.get("logstore", ls), True))

    query_results = {}  # chart_index -> (rows, err, elapsed)
    old_query_results = {}  # chart_index -> (rows, err)
    t0 = time.time()
    n_old = len([t for t in query_tasks if t[5]])
    print(f"  执行查询: {len(query_tasks)} 个查询（含 {n_old} 个旧版 diff 查询）")

    # 解析 --filter/--var 参数
    filters = {}
    for f_str in args.filters:
        if "=" in f_str:
            k, v = f_str.split("=", 1)
            filters[k] = v
    if filters:
        print(f"  过滤: {filters}")

    def _apply_filters(sql):
        """替换 SQL 中的 ${{key}} token 为过滤值。"""
        for k, v in filters.items():
            sql = sql.replace(f"${{{{{k}}}}}", v)
        return sql

    def _do_query(task):
        ci, c, sql, proj, ls, is_old = task
        nm = get_display_name(c)
        sql = _apply_filters(sql)
        q_from, q_to = get_chart_time_range(c, args, ts_from, ts_to)
        if "to_unixtime(now())" in sql:
            sql = sql.replace("to_unixtime(now())", str(ts_to))
            q_from = min(q_from, ts_to - 1209600)
        q_start = time.time()
        rows, err = query_sls(proj, ls, sql, q_from, q_to, args.profile, args.region)
        q_elapsed = round(time.time() - q_start, 1)
        rows = rows or []
        status = f"ERROR: {err}" if err else f"OK ({len(rows)} rows)"
        return ci, rows, err, nm, status, q_elapsed, is_old

    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(_do_query, t): t for t in query_tasks}
        done_count = 0
        for future in as_completed(futures):
            ci, rows, err, nm, status, q_elapsed, is_old = future.result()
            if is_old:
                old_query_results[ci] = (rows, err)
                done_count += 1
                tag = "[旧]"
                print(f"  [{done_count}/{len(query_tasks)}] {tag} {nm} ... {status} ({q_elapsed}s)")
            else:
                query_results[ci] = (rows, err, q_elapsed)
                done_count += 1
                print(f"  [{done_count}/{len(query_tasks)}] {nm} ... {status} ({q_elapsed}s)")

    elapsed = time.time() - t0
    print(f"  查询完成，耗时 {elapsed:.1f}s\n")

    # ── Phase 1.5: 按 section 分组，以第一个 SQL 为基准计算差异 ──
    section_sqls = {}  # section_name -> [sql, ...]
    section_chart_map = {}  # chart_index -> (section_name, index_in_section)
    cur_section = "_top"
    for i, c in enumerate(charts):
        if c.get("type") == "dashboardrow":
            cur_section = get_display_name(c)
            continue
        qs = c.get("search", {}).get("chartQueries", [])
        if qs:
            sql = qs[0].get("query", "")
            idx_in_sec = len(section_sqls.get(cur_section, []))
            section_sqls.setdefault(cur_section, []).append(sql)
            section_chart_map[i] = (cur_section, idx_in_sec)

    section_diffs = {}  # section_name -> list[diff_info|None]
    for sec, sqls_list in section_sqls.items():
        section_diffs[sec] = compute_section_diff_info(sqls_list)

    # ── Phase 2: 按 24 列网格渲染 HTML，布局与 dashboard.json 一致 ──
    # 将 yPos 映射为连续的 grid row
    all_ypos = sorted(set(c.get("display", {}).get("yPos", 0) for c in charts))
    ypos_to_row = {y: r + 1 for r, y in enumerate(all_ypos)}

    # 按 section 分组，收集每个 section 内的 yPos 用于相对行号
    section_ypos_map = {}  # section_name -> sorted list of unique yPos
    cur_sec_name = "_top"
    for c in charts:
        if c.get("type") == "dashboardrow":
            cur_sec_name = get_display_name(c)
            continue
        yp = c.get("display", {}).get("yPos", 0)
        section_ypos_map.setdefault(cur_sec_name, set()).add(yp)
    section_ypos_map = {k: sorted(v) for k, v in section_ypos_map.items()}

    # 按 section 分组渲染：每个 section 一个 grid 容器，diff 块放在容器后面
    sections = []  # [(sec_html_or_none, [chart_items], [diff_items])]
    cur_sec_html = None
    cur_sec_name = "_top"
    cur_charts = []
    cur_diffs = []
    idx = 0

    for i, c in enumerate(charts):
        ct = c.get("type", "")
        nm = get_display_name(c)
        display = c.get("display", {})
        xp = display.get("xPos", 0)
        yp = display.get("yPos", 0)
        w = display.get("width", 24)
        h = display.get("height", 1)
        col_start = xp + 1
        col_end = xp + w + 1

        # 计算 section 内相对 grid-row
        sec_ypos_list = section_ypos_map.get(cur_sec_name, [yp])
        if yp in sec_ypos_list:
            row_start = sec_ypos_list.index(yp) + 1
        else:
            row_start = 1
        row_span = 1
        for y2 in sec_ypos_list:
            if y2 > yp and y2 < yp + h:
                row_span += 1

        style = f'style="grid-column:{col_start}/{col_end};grid-row:{row_start}/span {row_span}"'

        if ct == "dashboardrow":
            cur_sec_name = nm
            sections.append((cur_sec_html, cur_charts, cur_diffs))
            cur_sec_html = f'<div class="sec">{esc(nm)}</div>'
            cur_charts = []
            cur_diffs = []
            continue

        if i not in query_results and ct not in ("text", "markdownpro"):
            continue

        rows, err, q_elapsed = query_results.get(i, ([], None, None))
        qs = c.get("search", {}).get("chartQueries", [])
        raw_sql = qs[0].get("query", "") if qs else ""
        sql = _apply_filters(raw_sql)
        sec, sec_idx = section_chart_map.get(i, ("_top", 0))
        sec_diff_list = section_diffs.get(sec, [])
        cl = sec_diff_list[sec_idx] if sec_idx < len(sec_diff_list) else None
        idx += 1

        # 生成 diff（如果有变更），暂存到 section 末尾
        chart_title = c.get("title", "")
        old_info = head_sqls.get(chart_title, {}) if diff_enabled else {}
        old_sql = old_info.get("query", "") if old_info else ""
        old_rows_data = old_query_results.get(i, (None, None))[0]
        new_info = chart_info(c, sec, args.default_project)

        if err:
            sql_h = render_sql(sql, q_elapsed, cl)
            if ct == "statpro":
                cur_charts.append(f'<div class="card" {style}><div class="card-t">{esc(nm)}</div><div class="err">{esc(err)}</div>{sql_h}</div>')
            else:
                cur_charts.append(f'<div class="block" {style}><h3>{esc(nm)}</h3><div class="err">{esc(err)}</div>{sql_h}</div>')
            if not diff_enabled:
                diff_h = ""
            elif not old_info:
                diff_h = render_added_chart_diff(nm, raw_sql, None, new_info, err)
            elif old_sql and old_sql != raw_sql:
                diff_h = render_sql_diff(nm, old_sql, raw_sql, old_rows_data, None, old_info, new_info)
            else:
                diff_h = ""
                if diff_enabled and has_meta_diff(old_info, new_info):
                    layout_changes.append((nm, old_info, new_info))
            if diff_h:
                cur_diffs.append(diff_h)
            continue

        if ct in ("text", "markdownpro"):
            html = render_static(c, sql, q_elapsed, cl)
        elif ct == "statpro":
            html = render_stat(c, rows, sql, q_elapsed, cl)
        elif ct == "tablepro":
            html = render_table(c, rows, sql, q_elapsed, cl)
        elif ct == "barpro":
            html = render_bar(c, rows, sql, q_elapsed, cl)
        elif ct == "linepro":
            html = render_line_as_table(c, rows, sql, q_elapsed, cl)
        elif ct == "piepro":
            html = render_pie_as_bar(c, rows, sql, q_elapsed, cl)
        elif ct == "aggpro":
            html = render_agg(c, rows, sql, q_elapsed, cl)
        else:
            html = render_table(c, rows, sql, q_elapsed, cl)

        # 注入 grid style 到第一个 <div class="card" 或 <div class="block"
        import re as _re
        html = _re.sub(r'<div class="(card|block)"', f'<div class="\\1" {style}', html, count=1)
        cur_charts.append(html)

        if not diff_enabled:
            diff_html = ""
        elif ct in ("text", "markdownpro") and not sql:
            diff_html = ""
            if has_meta_diff(old_info, new_info):
                layout_changes.append((nm, old_info, new_info))
        elif not old_info:
            diff_html = render_added_chart_diff(nm, raw_sql, rows, new_info)
        elif old_sql and old_sql != raw_sql:
            diff_html = render_sql_diff(nm, old_sql, raw_sql, old_rows_data, rows, old_info, new_info)
        else:
            diff_html = ""
            if diff_enabled and has_meta_diff(old_info, new_info):
                layout_changes.append((nm, old_info, new_info))
        if diff_html:
            cur_diffs.append(diff_html)

    # 最后一个 section
    sections.append((cur_sec_html, cur_charts, cur_diffs))

    # 组装 body：每个 section 一个 grid 容器 + diff 块在容器外
    body_parts = []
    for sec_html, chart_items, diff_items in sections:
        if sec_html:
            body_parts.append(sec_html)
        if chart_items:
            body_parts.append(f'<div class="dash-grid">{"".join(chart_items)}</div>')
        for dh in diff_items:
            body_parts.append(dh)
    layout_html = render_layout_summary(layout_changes)
    if layout_html:
        body_parts.append(layout_html)
    removed_diffs = [
        render_removed_chart_diff(old_info)
        for title, old_info in (head_sqls or {}).items()
        if title not in current_titles
    ] if diff_enabled else []
    if removed_diffs:
        body_parts.append('<div class="sec">Removed Charts</div>')
        body_parts.extend(removed_diffs)

    body = body_parts

    out = HTML_TEMPLATE.format(
        title=dashboard_title, time_range=time_str(ts_from, ts_to),
        generated_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        chart_count=idx, body="\n".join(body), project=dashboard_json,
    )

    output_html.write_text(out, encoding="utf-8")
    print(f"\n报告已生成: {output_html}")


if __name__ == "__main__":
    main()
