/**
 * 捕获数据脱敏模块 —— llm-proxy 与 mitm 解析器共用。
 *
 * 原则（宁错杀不放过）：
 *   1. 敏感键名（token/secret/password/api_key/authorization…）→ 值整个替换；
 *   2. 值形态像凭据（JWT / sk- / ghp_ / AKIA…）→ 替换，不管键名叫什么；
 *   3. 长字符串里的疑似密钥不扫描正文（性能），只按结构化的键递归走；
 *   4. Authorization / Cookie 请求头在 proxy 层整体丢弃，不进这里。
 *
 * 替换形态：`[REDACTED:<原因>:<原长度>]`，保留长度便于估熵，但绝不保留前后缀。
 */

/** 键名命中即脱敏。键名在嵌套 JSON 里大小写与分隔符不统一，统一小写后匹配 */
const SECRET_KEY_RE = /(^|[_\-.])(token|secret|password|passwd|credential|auth|api[_\-.]?key|apikey|access[_\-.]?key|private[_\-.]?key|session[_\-.]?key|bearer|cookie|signature|sign|client[_\-.]?secret|refresh[_\-.]?token|id[_\-.]?token|acl[_\-.]?token)([_\-.]|$)/i;

/** 值形态像凭据：JWT、各家 token 前缀、AWS AK。命中即脱敏，与键名无关 */
const SECRET_VALUE_RE = /^(eyJ[A-Za-z0-9_-]{16,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[bpas]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|Bearer\s+\S{16,})/;

/** 这些键名保留值（是观测目标本身，不是凭据）*/
const KEEP_KEYS = new Set(['trace_id', 'request_id', 'session_id', 'agent_id', 'model', 'stream', 'url', 'method', 'status']);

function redactTag(reason, len) {
  return `[REDACTED:${reason}:${len}]`;
}

/**
 * 递归脱敏任意 JSON 值。返回新对象，不改原值。
 * @param {*} v        输入值
 * @param {string} key 当前所处的键名（根为空串）
 * @param {number} depth 递归深度上限，防病态嵌套
 */
export function sanitize(v, key = '', depth = 12) {
  if (depth <= 0) return '[REDACTED:max-depth]';
  if (v == null) return v;

  if (typeof v === 'string') {
    if (!KEEP_KEYS.has(key) && SECRET_KEY_RE.test(key)) return redactTag('key-name', v.length);
    if (SECRET_VALUE_RE.test(v)) return redactTag('value-shape', v.length);
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;

  if (Array.isArray(v)) {
    return v.map((item, i) => sanitize(item, key || String(i), depth - 1));
  }
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = sanitize(val, k, depth - 1);
    }
    return out;
  }
  return v;
}

/**
 * 请求头脱敏：Authorization / Cookie / 各家 token 头整体丢弃（不是替换，
 * 是压根不保留——替换形态也会泄露长度与存在性，对观测无价值）。
 * 返回 { headers, dropped: [...] }
 */
const DROP_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token|x-csrf-token|x-session-token|acl-token)$/i;

export function sanitizeHeaders(headers = {}) {
  const kept = {};
  const dropped = [];
  for (const [k, v] of Object.entries(headers)) {
    const sv = String(v);
    if (DROP_HEADER_RE.test(k) || SECRET_KEY_RE.test(k) || SECRET_VALUE_RE.test(sv)) {
      dropped.push(k.toLowerCase());
      continue;
    }
    kept[k.toLowerCase()] = sv;
  }
  return { headers: kept, dropped };
}

/**
 * messages 摘要：只保留 role + 字符数 + 首 120 字符的形态指纹。
 * system prompt 全文是否保留由调用方决定（默认截断——观测结构优先于留存内容）。
 * @param {Array} messages OpenAI 风格 messages 数组
 * @param {object} opts { keepSystemChars: number, keepUserChars: number }
 */
export function summarizeMessages(messages, opts = {}) {
  if (!Array.isArray(messages)) return null;
  const keepSystem = opts.keepSystemChars ?? 200;
  const keepUser = opts.keepUserChars ?? 120;
  return messages.map(m => {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const keep = m.role === 'system' ? keepSystem : keepUser;
    return {
      role: m.role,
      chars: text.length,
      head: text.slice(0, keep),
      truncated: text.length > keep,
    };
  });
}
