#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const OUTPUT_DIR = path.join(homedir(), '.loongsuite-pilot', 'logs', 'output');

const FIELD_SPECS = {
  'llm.request': {
    fields: [
      { key: 'event.id', label: 'event.id' },
      { key: 'user.id', label: 'user.id' },
      { key: 'gen_ai.session.id', label: 'session.id' },
      { key: 'gen_ai.turn.id', label: 'turn.id' },
      { key: 'gen_ai.step.id', label: 'step.id' },
      { key: 'gen_ai.provider.name', label: 'provider' },
      { key: 'gen_ai.request.model', label: 'request.model' },
      { key: 'gen_ai.input.messages_delta', label: 'input.msg_delta' },
    ],
  },
  'llm.response': {
    fields: [
      { key: 'event.id', label: 'event.id' },
      { key: 'user.id', label: 'user.id' },
      { key: 'gen_ai.session.id', label: 'session.id' },
      { key: 'gen_ai.step.id', label: 'step.id' },
      { key: 'gen_ai.response.id', label: 'response.id' },
      { key: 'gen_ai.response.model', label: 'response.model' },
      { key: 'gen_ai.response.finish_reasons', label: 'finish_reasons' },
      { key: 'gen_ai.usage.input_tokens', label: 'input_tokens' },
      { key: 'gen_ai.usage.output_tokens', label: 'output_tokens' },
      { key: 'gen_ai.output.messages', label: 'output.msg' },
    ],
  },
  'tool.call': {
    fields: [
      { key: 'event.id', label: 'event.id' },
      { key: 'user.id', label: 'user.id' },
      { key: 'gen_ai.session.id', label: 'session.id' },
      { key: 'gen_ai.step.id', label: 'step.id' },
      { key: 'gen_ai.tool.name', label: 'tool.name' },
      { key: 'gen_ai.tool.call.id', label: 'tool.call.id' },
      { key: 'gen_ai.tool.call.arguments', label: 'tool.call.args' },
    ],
  },
  'tool.result': {
    fields: [
      { key: 'event.id', label: 'event.id' },
      { key: 'user.id', label: 'user.id' },
      { key: 'gen_ai.session.id', label: 'session.id' },
      { key: 'gen_ai.step.id', label: 'step.id' },
      { key: 'gen_ai.tool.name', label: 'tool.name' },
      { key: 'gen_ai.tool.call.id', label: 'tool.call.id' },
      { key: 'gen_ai.tool.call.duration', label: 'tool.call.dur' },
    ],
  },
};

function parseCli() {
  const { values } = parseArgs({
    options: {
      agents:    { type: 'string', short: 'a' },
      date:      { type: 'string', short: 'd' },
      threshold: { type: 'string', short: 't', default: '90' },
      format:    { type: 'string', short: 'f', default: 'text' },
      output:    { type: 'string', short: 'o' },
    },
    strict: true,
  });
  if (!values.agents) {
    console.error('error: --agents is required (comma-separated agent names)');
    process.exit(2);
  }
  if (!['text', 'json'].includes(values.format)) {
    console.error('error: --format must be text or json');
    process.exit(2);
  }
  const today = new Date();
  const defaultDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return {
    agents: values.agents.split(',').map(a => a.trim()),
    date: values.date || defaultDate,
    threshold: Number(values.threshold),
    format: values.format,
    output: values.output,
  };
}

function isFilled(value) {
  if (value === undefined || value === null) return false;
  const s = String(value);
  return s !== '' && s !== 'null';
}

function resolveFiles(agents, date) {
  const resolved = [];
  for (const agent of agents) {
    const filename = `${agent}-${date}.jsonl`;
    const filepath = path.join(OUTPUT_DIR, filename);
    try {
      readFileSync(filepath, { flag: 'r' });
      resolved.push({ agent, filepath, filename });
    } catch {
      const available = readdirSync(OUTPUT_DIR)
        .filter(f => f.startsWith(agent + '-') && f.endsWith('.jsonl'))
        .sort()
        .reverse()
        .slice(0, 3);
      console.error(`warning: ${filename} not found. Available: ${available.join(', ') || 'none'}`);
    }
  }
  if (resolved.length === 0) {
    console.error('error: no valid files found');
    process.exit(2);
  }
  return resolved;
}

function collectStats(files) {
  // stats[eventName][agentType] = { total, filled: { fieldKey: count } }
  const stats = {};
  for (const eventName of Object.keys(FIELD_SPECS)) {
    stats[eventName] = {};
  }
  for (const { filepath } of files) {
    const content = readFileSync(filepath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const eventName = entry['event.name'];
      if (!FIELD_SPECS[eventName]) continue;
      const agentType = entry['gen_ai.agent.type'] || 'unknown';
      if (!stats[eventName][agentType]) {
        stats[eventName][agentType] = { total: 0, filled: {} };
        for (const f of FIELD_SPECS[eventName].fields) {
          stats[eventName][agentType].filled[f.key] = 0;
        }
      }
      const bucket = stats[eventName][agentType];
      bucket.total++;
      for (const f of FIELD_SPECS[eventName].fields) {
        if (isFilled(entry[f.key])) {
          bucket.filled[f.key]++;
        }
      }
    }
  }
  return stats;
}

function buildReport(stats, threshold) {
  const report = { threshold, tables: [] };
  for (const [eventName, spec] of Object.entries(FIELD_SPECS)) {
    const agentStats = stats[eventName];
    const rows = [];
    for (const [agentType, bucket] of Object.entries(agentStats)) {
      if (bucket.total === 0) continue;
      const fieldResults = spec.fields.map(f => {
        const pct = Math.round((bucket.filled[f.key] / bucket.total) * 1000) / 10;
        return { label: f.label, key: f.key, pct, pass: pct >= threshold };
      });
      const avg = Math.round((fieldResults.reduce((s, r) => s + r.pct, 0) / fieldResults.length) * 10) / 10;
      rows.push({ agentType, total: bucket.total, avg, fields: fieldResults });
    }
    rows.sort((a, b) => b.total - a.total);
    report.tables.push({ eventName, rows });
  }
  return report;
}

function formatText(report) {
  const lines = [];
  const failures = [];
  for (const table of report.tables) {
    if (table.rows.length === 0) {
      lines.push(`\n═══ ${table.eventName} 填充率 ═══`);
      lines.push('  (无数据)');
      continue;
    }
    const fields = FIELD_SPECS[table.eventName].fields;
    const headerLabels = fields.map(f => f.label);
    lines.push(`\n═══ ${table.eventName} 填充率 (阈值: ${report.threshold}%) ═══\n`);
    const colWidths = [
      Math.max(12, ...table.rows.map(r => r.agentType.length + 2)),
      6, 7,
      ...headerLabels.map(l => Math.max(l.length + 1, 7)),
    ];
    const header = [
      'agent_type'.padEnd(colWidths[0]),
      '事件数'.padEnd(colWidths[1]),
      '综合(%)'.padEnd(colWidths[2]),
      ...headerLabels.map((l, i) => l.padEnd(colWidths[i + 3])),
    ].join(' | ');
    lines.push(`  ${header}`);
    lines.push(`  ${'-'.repeat(header.length)}`);
    for (const row of table.rows) {
      const cells = [
        row.agentType.padEnd(colWidths[0]),
        String(row.total).padStart(colWidths[1]),
        String(row.avg.toFixed(1)).padStart(colWidths[2]),
        ...row.fields.map((f, i) => {
          const val = f.pct.toFixed(1) + (f.pass ? '' : '\u274C');
          return val.padStart(colWidths[i + 3]);
        }),
      ].join(' | ');
      lines.push(`  ${cells}`);
      const failing = row.fields.filter(f => !f.pass);
      if (failing.length > 0) {
        failures.push({
          agent: row.agentType,
          event: table.eventName,
          fields: failing.map(f => `${f.label}(${f.pct.toFixed(1)}%)`),
        });
      }
    }
  }
  if (failures.length > 0) {
    lines.push(`\n⚠️  未达标字段 (< ${report.threshold}%):\n`);
    for (const f of failures) {
      lines.push(`  ${f.agent} / ${f.event}: ${f.fields.join(', ')}`);
    }
  } else {
    lines.push('\n✅ 所有字段填充率均达标！');
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const opts = parseCli();
  console.error(`[field-coverage] agents: ${opts.agents.join(', ')} | date: ${opts.date} | threshold: ${opts.threshold}%`);
  const files = resolveFiles(opts.agents, opts.date);
  console.error(`[field-coverage] loaded ${files.length} file(s): ${files.map(f => f.filename).join(', ')}`);
  const stats = collectStats(files);
  const report = buildReport(stats, opts.threshold);
  let output;
  if (opts.format === 'json') {
    output = JSON.stringify(report, null, 2);
  } else {
    output = formatText(report);
  }
  if (opts.output) {
    writeFileSync(opts.output, output, 'utf8');
    console.error(`[field-coverage] report written to ${opts.output}`);
  } else {
    console.log(output);
  }
  const hasFailure = report.tables.some(t => t.rows.some(r => r.fields.some(f => !f.pass)));
  process.exit(hasFailure ? 1 : 0);
}

main();
