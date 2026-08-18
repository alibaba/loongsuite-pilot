#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal local OTLP/HTTP trace receiver + browser UI.
 *
 * It accepts the same endpoint used by OtlpTraceFlusher:
 *   POST http://127.0.0.1:<port>/v1/traces  (application/x-protobuf)
 *
 * No external service is required. Captured spans are kept in memory and also
 * appended as JSONL under ~/.loongsuite-pilot/logs/local-otel/traces.jsonl.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const rootModule = await import('@opentelemetry/otlp-transformer/build/esm/generated/root.js');
const otlpRoot = rootModule.default;
const ExportTraceServiceRequest = otlpRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : fallback;
};

const port = Number(arg('--port', process.env.LOCAL_OTEL_PORT || 4318));
const host = arg('--host', process.env.LOCAL_OTEL_HOST || '127.0.0.1');
const dataDir = arg('--data-dir', process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot'));
const outDir = path.join(dataDir, 'logs', 'local-otel');
const outFile = path.join(outDir, 'traces.jsonl');
const maxTraces = Number(arg('--max-traces', process.env.LOCAL_OTEL_MAX_TRACES || 200));
fs.mkdirSync(outDir, { recursive: true });

const traces = new Map();
let batches = 0;
let spansTotal = 0;
let lastError = null;

const spanKind = {
  0: 'UNSPECIFIED',
  1: 'INTERNAL',
  2: 'SERVER',
  3: 'CLIENT',
  4: 'PRODUCER',
  5: 'CONSUMER',
};

function bytesToHex(bytes) {
  if (!bytes) return '';
  return Buffer.from(bytes).toString('hex');
}

function longToBigInt(value) {
  if (value == null) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') return BigInt(value || '0');
  if (typeof value.toString === 'function') return BigInt(value.toString());
  return 0n;
}

function nanosToMs(value) {
  const n = longToBigInt(value);
  if (n === 0n) return 0;
  return Number(n / 1000000n);
}

function anyValueToJson(v) {
  if (!v || typeof v !== 'object') return undefined;
  if (v.stringValue != null) return v.stringValue;
  if (v.boolValue != null) return Boolean(v.boolValue);
  if (v.intValue != null) return Number(longToBigInt(v.intValue));
  if (v.doubleValue != null) return Number(v.doubleValue);
  if (v.bytesValue != null) return bytesToHex(v.bytesValue);
  if (v.arrayValue?.values) return v.arrayValue.values.map(anyValueToJson);
  if (v.kvlistValue?.values) return kvListToObject(v.kvlistValue.values);
  return undefined;
}

function kvListToObject(values = []) {
  const out = {};
  for (const item of values) {
    if (!item?.key) continue;
    out[item.key] = anyValueToJson(item.value);
  }
  return out;
}

function normalizeEvents(events = []) {
  return events.map(ev => ({
    name: ev.name || '',
    timeMs: nanosToMs(ev.timeUnixNano),
    attributes: kvListToObject(ev.attributes || []),
  }));
}

function normalizeSpan(span, resource, scope) {
  const startMs = nanosToMs(span.startTimeUnixNano);
  const endMs = nanosToMs(span.endTimeUnixNano);
  return {
    traceId: bytesToHex(span.traceId),
    spanId: bytesToHex(span.spanId),
    parentSpanId: bytesToHex(span.parentSpanId),
    name: span.name || '',
    kind: spanKind[span.kind] || String(span.kind ?? ''),
    startMs,
    endMs,
    durationMs: startMs && endMs ? Math.max(0, endMs - startMs) : 0,
    attributes: kvListToObject(span.attributes || []),
    resource,
    scope,
    status: span.status ? { code: span.status.code, message: span.status.message || '' } : undefined,
    events: normalizeEvents(span.events || []),
  };
}

function addSpans(spans, persist = true) {
  if (spans.length === 0) return;
  batches += 1;
  spansTotal += spans.length;
  for (const span of spans) {
    if (!span.traceId) continue;
    let trace = traces.get(span.traceId);
    if (!trace) {
      trace = { traceId: span.traceId, spans: [], services: new Set(), firstStartMs: 0, lastEndMs: 0 };
      traces.set(span.traceId, trace);
    }
    const exists = trace.spans.some(s => s.spanId === span.spanId);
    if (!exists) trace.spans.push(span);
    const svc = span.resource?.['service.name'];
    if (svc) trace.services.add(String(svc));
    if (span.startMs && (!trace.firstStartMs || span.startMs < trace.firstStartMs)) trace.firstStartMs = span.startMs;
    if (span.endMs && span.endMs > trace.lastEndMs) trace.lastEndMs = span.endMs;
  }
  for (const trace of traces.values()) {
    trace.spans.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
  }
  while (traces.size > maxTraces) {
    const oldest = [...traces.values()].sort((a, b) => (a.lastEndMs || 0) - (b.lastEndMs || 0))[0];
    if (!oldest) break;
    traces.delete(oldest.traceId);
  }
  if (persist) fs.appendFileSync(outFile, JSON.stringify({ ts: new Date().toISOString(), spans }) + '\n');
}

function loadPersistedSpans() {
  if (!fs.existsSync(outFile)) return;
  try {
    const lines = fs.readFileSync(outFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-2000);
    let loadedRows = 0;
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (Array.isArray(row.spans)) {
          addSpans(row.spans, false);
          loadedRows += 1;
        }
      } catch {
        // ignore bad persisted rows
      }
    }
    console.log(`Loaded ${loadedRows} persisted OTLP batch(es) from ${outFile}`);
  } catch (err) {
    lastError = `load persisted spans failed: ${String(err?.message || err)}`;
  }
}


function decodeOtlpTraceRequest(body) {
  const decoded = ExportTraceServiceRequest.decode(body);
  const spans = [];
  for (const rs of decoded.resourceSpans || []) {
    const resource = kvListToObject(rs.resource?.attributes || []);
    for (const ss of rs.scopeSpans || []) {
      const scope = { name: ss.scope?.name || '', version: ss.scope?.version || '' };
      for (const span of ss.spans || []) spans.push(normalizeSpan(span, resource, scope));
    }
  }
  return spans;
}

function traceSummary(trace) {
  const spanKinds = trace.spans.reduce((acc, s) => {
    const key = s.attributes?.['gen_ai.span.kind'] || s.kind || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const agents = [...new Set(trace.spans.map(s => s.attributes?.['gen_ai.agent.type']).filter(Boolean))];
  const rootSpan = trace.spans.find(s => !s.parentSpanId) || trace.spans[0];
  const llmSpan = trace.spans.find(s => s.attributes?.['gen_ai.span.kind'] === 'LLM');
  const hasModelCapture = trace.spans.some(s => s.attributes?.['trae.model.source']);
  const hasLlmOutput = trace.spans.some(s => Array.isArray(s.attributes?.['gen_ai.output.messages']) && s.attributes['gen_ai.output.messages'].length > 0);
  const hasToolOrSubagent = !!(spanKinds.TOOL || spanKinds.SUBAGENT);
  const weakHookOnly = !!trace.hookFallback && !hasModelCapture && !hasLlmOutput && !hasToolOrSubagent;
  return {
    traceId: trace.traceId,
    services: [...trace.services],
    agents,
    spanCount: trace.spans.length,
    spanKinds,
    hasModelCapture,
    hasLlmOutput,
    weakHookOnly,
    firstStartMs: trace.firstStartMs,
    lastEndMs: trace.lastEndMs,
    durationMs: trace.firstStartMs && trace.lastEndMs ? trace.lastEndMs - trace.firstStartMs : 0,
    rootName: llmSpan?.name || rootSpan?.name || '',
  };
}

function json(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function html(res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"/><title>Local OTEL Trace</title><style>
body{margin:0;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#0b1020;color:#dbe7ff}header{padding:12px 16px;background:#111a33;border-bottom:1px solid #243354;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.pill{background:#20345f;border:1px solid #40609f;border-radius:999px;padding:3px 9px}.wrap{display:grid;grid-template-columns:420px 1fr;height:calc(100vh - 60px)}aside{border-right:1px solid #243354;overflow:auto}.trace{padding:12px 14px;border-bottom:1px solid #1d2a48;cursor:pointer}.trace:hover,.trace.active{background:#172342}.trace-title{display:flex;justify-content:space-between;gap:8px;align-items:center}.badge{font-size:11px;border-radius:999px;padding:2px 7px;background:#20345f;border:1px solid #40609f;color:#cfe0ff}.muted{color:#91a4c9;font-size:12px}.main{overflow:auto;padding:16px}.summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px;margin:10px 0 14px}.card{background:#111a33;border:1px solid #2a3f6f;border-radius:8px;padding:10px}.span{margin:8px 0;padding:10px;border:1px solid #2a3f6f;border-radius:8px;background:#111a33}.tree{margin-top:12px}.node{position:relative;margin:8px 0 8px var(--indent);padding:10px;border:1px solid #2a3f6f;border-left-width:5px;border-radius:8px;background:#111a33}.node:before{content:'';position:absolute;left:-14px;top:18px;width:12px;border-top:1px solid #40609f}.kind-ENTRY{border-left-color:#8b5cf6}.kind-AGENT{border-left-color:#06b6d4}.kind-STEP{border-left-color:#f59e0b}.kind-LLM{border-left-color:#22c55e}.kind-TOOL{border-left-color:#3b82f6}.kind-SUBAGENT{border-left-color:#ec4899}.kind-UNKNOWN{border-left-color:#64748b}.badge.kind-ENTRY{background:#3b246b}.badge.kind-AGENT{background:#164e63}.badge.kind-STEP{background:#713f12}.badge.kind-LLM{background:#14532d}.badge.kind-TOOL{background:#1e3a8a}.badge.kind-SUBAGENT{background:#831843}.name{font-weight:600}.attrs{white-space:pre-wrap;background:#071022;padding:10px;border-radius:6px;overflow:auto;color:#c9f0ff;max-height:360px;margin-top:8px}.missing{color:#ff8f8f}.kv{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}summary{cursor:pointer;display:inline-block;margin-top:8px;padding:4px 8px;border:1px solid #2a3f6f;border-radius:6px;background:#0c1730}details[open] summary{background:#172342}input{background:#071022;color:#dbe7ff;border:1px solid #2a3f6f;border-radius:6px;padding:8px;width:280px}label{display:flex;align-items:center;gap:6px;color:#cfe0ff}input[type=checkbox]{width:auto}button{background:#2d61d6;color:white;border:1px solid #5d85e8;border-radius:6px;padding:8px 12px;cursor:pointer}button:hover{background:#3b73f0}button:disabled{opacity:.6;cursor:wait}</style></head><body>
<header><strong>Local OTEL Trace</strong><span id="stats" class="pill">loading</span><button id="refresh">刷新</button><span id="last" class="muted">auto refresh: 3s</span><input id="q" placeholder="按 traceId / span / model / 内容筛选"/><label><input id="completeOnly" type="checkbox" checked/>只看完整轨迹</label></header><div class="wrap"><aside id="list"></aside><main id="detail" class="main"></main></div>
<script>
let DATA=[],ACTIVE='',OPEN_DETAILS=new Set(),LAST_SIG='';
const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function fmt(ms){return ms?new Date(ms).toLocaleTimeString()+'.'+String(ms%1000).padStart(3,'0'):'-'}
function kindOf(s){return s.attributes?.['gen_ai.span.kind']||s.kind||'UNKNOWN'}
function kindClass(k){return ['ENTRY','AGENT','STEP','LLM','TOOL','SUBAGENT'].includes(k)?k:'UNKNOWN'}
function isCompleteTrace(t){return !t.weakHookOnly&&!!(t.spanKinds?.LLM||t.spanKinds?.TOOL||t.spanKinds?.SUBAGENT)}
function richScore(t){return t.lastEndMs||t.firstStartMs||0}
function match(t,q){if(!q)return true; const needle=q.toLowerCase(); if(String(t.traceId).toLowerCase().includes(needle))return true; return JSON.stringify(t).toLowerCase().includes(needle)}
function counts(t){const k=t.spanKinds||{};return 'ENTRY '+(k.ENTRY||0)+' · AGENT '+(k.AGENT||0)+' · STEP '+(k.STEP||0)+' · LLM '+(k.LLM||0)+' · TOOL '+(k.TOOL||0)+' · SUBAGENT '+(k.SUBAGENT||0)}
function render(){const q=$('#q').value.trim(); const completeOnly=$('#completeOnly').checked; const rows=DATA.filter(t=>(!completeOnly||isCompleteTrace(t))&&match(t,q)).sort((a,b)=>richScore(b)-richScore(a)); if(!rows.some(t=>t.traceId===ACTIVE))ACTIVE=rows[0]?.traceId||''; $('#list').innerHTML=rows.map(t=>'<div class="trace '+(t.traceId===ACTIVE?'active':'')+'" data-trace-id="'+esc(t.traceId)+'"><div class="trace-title"><b>'+esc(t.rootName||t.traceId.slice(0,10))+'</b><span class="badge">'+(t.weakHookOnly?'不完整Hook':(t.hasModelCapture?'模型+Trace':(t.hookFallback?'完整Hook':(t.proxyOnly?'代理LLM':(isCompleteTrace(t)?'完整':'空壳')))))+'</span></div><div class="muted">trace '+esc(t.traceId)+'</div><div class="muted">'+counts(t)+'</div><div class="muted">spans '+t.spanCount+' · '+t.durationMs+'ms · '+fmt(t.firstStartMs)+'</div></div>').join('')||'<p class="muted" style="padding:14px">没有匹配的 trace；可取消「只看完整轨迹」或清空筛选。</p>'; detail(rows.find(t=>t.traceId===ACTIVE)||rows[0]);}
function buildTree(spans){const byId=new Map(spans.map(s=>[s.spanId,s]));const children=new Map();for(const s of spans)children.set(s.spanId,[]);const roots=[];for(const s of spans){if(s.parentSpanId&&byId.has(s.parentSpanId))children.get(s.parentSpanId).push(s);else roots.push(s)}for(const arr of children.values())arr.sort((a,b)=>(a.startMs||0)-(b.startMs||0));roots.sort((a,b)=>(a.startMs||0)-(b.startMs||0));return{roots,children}}
function textOfPart(p){return typeof p==='string'?p:(p?.content||p?.text||'')}
function textOfMsg(m){const c=m?.content;if(typeof c==='string')return c;if(Array.isArray(c))return c.map(textOfPart).filter(Boolean).join(' ');if(Array.isArray(m?.parts))return m.parts.map(textOfPart).filter(Boolean).join(' ');return ''}
function firstText(msgs,role){return (Array.isArray(msgs)?msgs:[]).filter(m=>!role||m.role===role).map(textOfMsg).filter(Boolean)[0]||''}
function lastText(msgs,role){const xs=(Array.isArray(msgs)?msgs:[]).filter(m=>!role||m.role===role).map(textOfMsg).filter(Boolean);return xs[xs.length-1]||''}
function clip(s,n=180){s=String(s||'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n)+'…':s}
function spanNode(s,children,depth){const k=kindClass(kindOf(s));const miss=Object.keys(s.attributes||{}).filter(k=>k.includes('observability.missing')&&s.attributes[k]===true);const model=s.attributes?.['gen_ai.request.model']||s.attributes?.['gen_ai.response.model']||'';const tool=s.attributes?.['gen_ai.tool.name']||'';const hookIn=s.attributes?.['gen_ai.input.messages'];const hookOut=s.attributes?.['gen_ai.output.messages'];const proxyMsgs=s.attributes?.['trae.model_proxy.input.messages']||s.attributes?.['trae.model_proxy.request_body']?.messages;const user=firstText(hookIn,'user');const answer=lastText(hookOut,'assistant');const modelOutput=!answer&&k==='LLM'&&s.attributes?.['trae.model_proxy.delta_chars']?('已捕获 '+s.attributes['trae.model_proxy.delta_chars']+' 字符，展开属性查看完整 SSE'):'';const roles=Array.isArray(proxyMsgs)?proxyMsgs.map(m=>m.role).filter(Boolean).join(' → '):'';const toolDefs=Array.isArray(s.attributes?.['gen_ai.tool.definitions'])?s.attributes['gen_ai.tool.definitions'].length:(s.attributes?.['trae.model_proxy.tools_count']||'');const extra=[user&&('输入：'+esc(clip(user))),answer&&('输出：'+esc(clip(answer))),modelOutput&&('模型输出：'+esc(modelOutput)),roles&&('model context='+esc(roles)),toolDefs&&('tools='+esc(toolDefs))].filter(Boolean).join('<br/>');const meta=[k,s.durationMs+'ms',model&&('model='+model),tool&&('tool='+tool)].filter(Boolean).join(' · ');const open=OPEN_DETAILS.has(s.spanId)?' open':'';return '<div class="node kind-'+k+'" style="--indent:'+(depth*22)+'px"><div class="name">'+esc(s.name)+' <span class="badge kind-'+k+'">'+esc(meta)+'</span></div>'+(extra?'<div class="muted">'+extra+'</div>':'')+(miss.length?'<div class="missing">missing: '+esc(miss.join(', '))+'</div>':'')+'<div class="muted">span='+esc(s.spanId)+' parent='+(s.parentSpanId?esc(s.parentSpanId):'-')+' · '+fmt(s.startMs)+'</div><details data-span-id="'+esc(s.spanId)+'"'+open+'><summary>属性 / events（点击固定展开）</summary><pre class="attrs">'+esc(JSON.stringify({resource:s.resource,attributes:s.attributes,events:s.events},null,2))+'</pre></details></div>'+children.get(s.spanId).map(c=>spanNode(c,children,depth+1)).join('')}
function detail(t){if(!t){$('#detail').innerHTML='<p class="muted">No traces yet. POST OTLP spans to /v1/traces.</p>';return} const tree=buildTree(t.spans||[]); $('#detail').innerHTML='<h2>完整 Trace：'+esc(t.rootName||t.traceId)+'</h2><p class="muted">trace_id='+esc(t.traceId)+'</p><div class="summary"><div class="card"><div class="muted">Duration</div><b>'+t.durationMs+'ms</b></div><div class="card"><div class="muted">Spans</div><b>'+t.spanCount+'</b></div><div class="card"><div class="muted">Kinds</div><b>'+esc(counts(t))+'</b></div><div class="card"><div class="muted">Service</div><b>'+esc((t.services||[]).join(',')||'-')+'</b></div></div><div class="tree">'+tree.roots.map(r=>spanNode(r,tree.children,0)).join('')+'</div>'}
window.sel=id=>{ACTIVE=id;render()}; $('#q').oninput=render; $('#completeOnly').onchange=render; $('#list').onclick=e=>{const el=e.target.closest('.trace'); if(el?.dataset?.traceId) sel(el.dataset.traceId)}; $('#detail').addEventListener('toggle',e=>{const el=e.target;if(el?.tagName==='DETAILS'&&el.dataset?.spanId){if(el.open)OPEN_DETAILS.add(el.dataset.spanId);else OPEN_DETAILS.delete(el.dataset.spanId)}},true);
function dataSig(traces){return traces.map(t=>[t.traceId,t.spanCount,t.lastEndMs,t.hasModelCapture,t.weakHookOnly,t.spanKinds?.SUBAGENT||0,t.spanKinds?.TOOL||0].join(':')).join('|')}
function restoreScroll(pos){requestAnimationFrame(()=>requestAnimationFrame(()=>{if(pos.detail)$('#detail').scrollTop=pos.detail;if(pos.list)$('#list').scrollTop=pos.list;if(pos.win)window.scrollTo(0,pos.win)}))}
async function load(){const btn=$('#refresh'); const pos={detail:$('#detail')?.scrollTop||0,list:$('#list')?.scrollTop||0,win:window.scrollY||0}; const prevActive=ACTIVE; if(btn)btn.disabled=true; try{const r=await fetch('/api/traces?ts='+Date.now(),{cache:'no-store'}); const j=await r.json(); const complete=j.traces.filter(isCompleteTrace).length; const tool=j.traces.filter(t=>t.spanKinds?.TOOL).length; const sub=j.traces.filter(t=>t.spanKinds?.SUBAGENT).length; $('#stats').textContent='完整 '+complete+'/'+j.traces.length+' · 含Tool '+tool+' · 含SubAgent '+sub+' · OTLP spans '+j.stats.spansTotal; $('#last').textContent='last refresh: '+new Date().toLocaleTimeString()+' · auto refresh: 3s · source: '+(j.stats.source||'otlp'); const sig=dataSig(j.traces); if(sig===LAST_SIG){return} LAST_SIG=sig; DATA=j.traces; render(); if(ACTIVE===prevActive)restoreScroll(pos)}catch(e){$('#last').textContent='refresh failed: '+e.message}finally{if(btn)btn.disabled=false}} $('#refresh').onclick=()=>{LAST_SIG='';load()}; setInterval(load,3000); load();
</script></body></html>`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 50 * 1024 * 1024) reject(new Error('request too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,GET,OPTIONS', 'access-control-allow-headers': '*' });
    res.end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/traces') {
    try {
      let body = await readBody(req);
      if (String(req.headers['content-encoding'] || '').includes('gzip')) body = zlib.gunzipSync(body);
      const spans = decodeOtlpTraceRequest(body);
      addSpans(spans);
      res.writeHead(200, { 'content-type': 'application/x-protobuf', 'access-control-allow-origin': '*' });
      res.end(Buffer.alloc(0));
    } catch (err) {
      lastError = String(err?.stack || err);
      json(res, 400, { ok: false, error: lastError });
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/traces') {
    const summaries = [...traces.values()]
      .sort((a, b) => (b.lastEndMs || 0) - (a.lastEndMs || 0))
      .map(t => ({ ...traceSummary(t), spans: t.spans }));
    json(res, 200, { ok: true, traces: summaries, stats: { batches, spansTotal, traceCount: traces.size, outFile, lastError, source: 'otlp_receiver_only' } });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    json(res, 200, { ok: true, batches, spansTotal, traceCount: traces.size, outFile, lastError });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/') return html(res);
  json(res, 404, { ok: false, error: 'not found' });
});

loadPersistedSpans();

server.listen(port, host, () => {
  console.log(`Local OTEL receiver: http://${host}:${port}`);
  console.log(`OTLP traces endpoint: http://${host}:${port}/v1/traces`);
  console.log(`JSONL backup: ${outFile}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
