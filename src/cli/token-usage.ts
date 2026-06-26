import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJsonFile, resolveHome } from '../utils/fs-utils.js';

export type MetricsRange = 'today' | 'sevenDays' | 'thirtyDays';

export interface ShareEntry {
  share?: number;
}

export interface ModelShareEntry extends ShareEntry {
  model?: string;
  totalTokens?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
}

export interface AgentShareEntry extends ShareEntry {
  agentType?: string;
  sessions?: number;
  events?: number;
  tokens?: number;
}

export interface ProviderShareEntry extends ShareEntry {
  provider?: string;
  totalTokens?: number;
}

export interface RepoShareEntry {
  repo?: string;
  sessions?: number;
  events?: number;
}

export interface DailyPoint {
  day?: string;
  value?: number;
}

export interface RangeData {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalSessions?: number;
  totalRequests?: number;
  totalToolCalls?: number;
  totalEvents?: number;
  modelShares?: ModelShareEntry[];
  agentShares?: AgentShareEntry[];
  providerShares?: ProviderShareEntry[];
  repoShares?: RepoShareEntry[];
}

export interface MetricsSummary {
  version?: number;
  generatedAt?: string;
  packageVersion?: string;
  ranges?: Partial<Record<MetricsRange, RangeData>>;
  dailyTokens?: DailyPoint[];
  dailySessions?: DailyPoint[];
}

export interface RuntimeRecord {
  status?: string;
  packageVersion?: string;
  pid?: number;
  updatedAt?: string;
}

interface ConfigFile {
  dataDir?: string;
}

export interface TokenUsageOptions {
  range: MetricsRange;
  dataDir?: string;
  color: boolean;
  help: boolean;
}

export interface TokenUsageViewData {
  dataDir: string;
  summaryPath: string;
  runtimePath: string;
  summary: MetricsSummary | null;
  runtime: RuntimeRecord | null;
  runtimeAlive: boolean;
  summaryError?: string;
  runtimeError?: string;
  now: Date;
}

export interface ParseResult {
  options: TokenUsageOptions;
  error?: string;
}

const DEFAULT_DATA_DIR = '~/.loongsuite-pilot';

const RANGE_LABELS: Record<MetricsRange, string> = {
  today: 'Today',
  sevenDays: 'Last 7 days',
  thirtyDays: 'Last 30 days',
};

const TABLE_NAME_WIDTH = 26;
const TABLE_VALUE_WIDTH = 8;
const TABLE_METRIC_WIDTH = 6;
const TABLE_META_WIDTH = 4;
const TABLE_BAR_WIDTH = 24;

export function parseTokenUsageArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  isTTY = Boolean(process.stdout.isTTY),
): ParseResult {
  const options: TokenUsageOptions = {
    range: 'today',
    color: isTTY && env.NO_COLOR === undefined,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      options.help = true;
      continue;
    }
    if (arg === '--once') {
      continue;
    }
    if (arg === '--no-color') {
      options.color = false;
      continue;
    }
    if (arg === '--today') {
      options.range = 'today';
      continue;
    }
    if (arg === '--7d' || arg === '--seven-days') {
      options.range = 'sevenDays';
      continue;
    }
    if (arg === '--30d' || arg === '--thirty-days') {
      options.range = 'thirtyDays';
      continue;
    }
    if (arg.startsWith('--range=')) {
      const range = parseRangeValue(arg.slice('--range='.length));
      if (!range) return { options, error: `Invalid range: ${arg.slice('--range='.length)}` };
      options.range = range;
      continue;
    }
    if (arg === '--range') {
      const value = args[++i];
      const range = parseRangeValue(value);
      if (!range) return { options, error: `Invalid range: ${value ?? ''}` };
      options.range = range;
      continue;
    }
    if (arg.startsWith('--data-dir=')) {
      options.dataDir = arg.slice('--data-dir='.length);
      continue;
    }
    if (arg === '--data-dir') {
      const value = args[++i];
      if (!value) return { options, error: 'Missing value for --data-dir' };
      options.dataDir = value;
      continue;
    }
    return { options, error: `Unknown option: ${arg}` };
  }

  return { options };
}

export async function runTokenUsageCommand(args: string[] = process.argv.slice(3)): Promise<number> {
  const parsed = parseTokenUsageArgs(args);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${renderHelp()}\n`);
    return 1;
  }
  if (parsed.options.help) {
    process.stdout.write(`${renderHelp()}\n`);
    return 0;
  }

  const options = parsed.options;
  const data = await loadViewData(options);
  process.stdout.write(`${renderTokenUsage(data, options, terminalWidth())}\n`);
  return data.summary ? 0 : 1;
}

export function renderHelp(): string {
  return [
    'Usage: loongsuite-pilot token-usage [options]',
    '',
    'Shows token usage from logs/metrics-summary.json and service state from logs/runtime.json.',
    '',
    'Options:',
    '  --once                    Print once and exit (default)',
    '  --range <today|7d|30d>    Aggregation range (default: today)',
    '  --today, --7d, --30d      Shortcut range selectors',
    '  --data-dir <path>         Override LoongSuite Pilot data directory',
    '  --no-color                Disable ANSI colors',
    '  --help, -h                Show this help',
  ].join('\n');
}

export async function resolveTokenUsageDataDir(explicitDataDir?: string): Promise<string> {
  if (explicitDataDir) return resolveHome(explicitDataDir);
  if (process.env.LOONGSUITE_PILOT_DATA_DIR) {
    return resolveHome(process.env.LOONGSUITE_PILOT_DATA_DIR);
  }

  const configPath = resolveHome(
    process.env.AGENT_DATA_COLLECTION_CONFIG ?? path.join(DEFAULT_DATA_DIR, 'config.json'),
  );
  const config = await readJsonFile<ConfigFile>(configPath);
  return resolveHome(config?.dataDir ?? DEFAULT_DATA_DIR);
}

export async function loadViewData(options: TokenUsageOptions): Promise<TokenUsageViewData> {
  const dataDir = await resolveTokenUsageDataDir(options.dataDir);
  const summaryPath = path.join(dataDir, 'logs', 'metrics-summary.json');
  const runtimePath = path.join(dataDir, 'logs', 'runtime.json');

  const [summaryResult, runtimeResult] = await Promise.all([
    readJsonWithError<MetricsSummary>(summaryPath),
    readJsonWithError<RuntimeRecord>(runtimePath),
  ]);

  const runtimeAlive = runtimeResult.data ? isRuntimeAlive(runtimeResult.data) : false;

  return {
    dataDir,
    summaryPath,
    runtimePath,
    summary: summaryResult.data,
    runtime: runtimeResult.data,
    runtimeAlive,
    summaryError: summaryResult.error,
    runtimeError: runtimeResult.error,
    now: new Date(),
  };
}

export function renderTokenUsage(
  data: TokenUsageViewData,
  options: TokenUsageOptions,
  width = 100,
): string {
  const color = makeColor(options.color);
  const rangeData = data.summary?.ranges?.[options.range] ?? {};
  const generatedAt = formatDateTime(data.summary?.generatedAt);
  const runtimeUpdated = formatDateTime(data.runtime?.updatedAt);
  const serviceState = formatServiceState(data, color);
  const heading = `${color.bold('LoongSuite Pilot Token Usage')}  ${serviceState}`;
  const rangeLine = [
    `Range ${RANGE_LABELS[options.range]}`,
    `Generated ${generatedAt ?? data.summaryError ?? 'not found'}`,
    `Runtime ${runtimeUpdated ?? data.runtimeError ?? 'not found'}`,
  ].join('  |  ');
  const versionLine = [
    `Version ${data.runtime?.packageVersion ?? data.summary?.packageVersion ?? 'unknown'}`,
    `Now ${formatDateTime(data.now.toISOString())}`,
  ].join('  |  ');

  const lines: string[] = [
    heading,
    rangeLine,
    versionLine,
    '',
  ];

  if (!data.summary) {
    lines.push(color.yellow('No metrics summary found yet.'));
    lines.push('Start loongsuite-pilot and wait for the metrics summary writer to refresh.');
    return trimLines(lines, width);
  }

  lines.push(...renderKpis(rangeData, color));
  lines.push('');
  lines.push(renderTokenBreakdown(rangeData, width, color));
  lines.push('');
  lines.push(...renderShareSection('Providers', rangeData.providerShares ?? [], width, color, {
    nameHeader: 'Provider',
    name: (item) => item.provider ?? 'unknown',
    value: (item) => item.totalTokens ?? 0,
  }));
  lines.push('');
  lines.push(...renderShareSection('Models', rangeData.modelShares ?? [], width, color, {
    nameHeader: 'Model',
    name: (item) => item.model ?? 'unknown',
    value: (item) => item.totalTokens ?? 0,
    detail: (item) => `in ${compactNumber(item.inputTokens ?? 0)}, cache ${compactNumber(item.cacheReadTokens ?? 0)}`,
  }));
  lines.push('');
  lines.push(...renderAgentSection(rangeData.agentShares ?? [], width, color));
  lines.push('');
  lines.push(...renderRepoSection(rangeData.repoShares ?? [], width, color));
  lines.push('');
  lines.push(...renderTrendSection(options.range, data.summary.dailyTokens ?? [], data.summary.dailySessions ?? [], width, color));

  return trimLines(lines, width);
}

function parseRangeValue(value: string | undefined): MetricsRange | null {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'today':
    case '1d':
    case 'day':
      return 'today';
    case '7d':
    case '7':
    case 'seven':
    case 'sevendays':
    case 'seven-days':
      return 'sevenDays';
    case '30d':
    case '30':
    case 'thirty':
    case 'thirtydays':
    case 'thirty-days':
      return 'thirtyDays';
    default:
      return null;
  }
}

async function readJsonWithError<T>(filePath: string): Promise<{ data: T | null; error?: string }> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return { data: JSON.parse(raw) as T };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { data: null, error: 'not found' };
    return { data: null, error: 'unreadable' };
  }
}

function isRuntimeAlive(runtime: RuntimeRecord): boolean {
  if (runtime.status !== 'active') return false;
  if (!runtime.pid || runtime.pid <= 0) return false;
  try {
    process.kill(runtime.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function renderKpis(rangeData: RangeData, color: ReturnType<typeof makeColor>): string[] {
  const cells = [
    { label: 'Tokens', value: compactNumber(rangeData.totalTokens ?? 0), paint: color.cyan },
    { label: 'Input', value: compactNumber(rangeData.inputTokens ?? 0), paint: color.normal },
    { label: 'Output', value: compactNumber(rangeData.outputTokens ?? 0), paint: color.normal },
    { label: 'Cache', value: compactNumber(rangeData.cacheReadTokens ?? 0), paint: color.normal },
    { label: 'Sessions', value: String(rangeData.totalSessions ?? 0), paint: color.normal },
    { label: 'Requests', value: String(rangeData.totalRequests ?? 0), paint: color.normal },
    { label: 'Tools', value: String(rangeData.totalToolCalls ?? 0), paint: color.normal },
    { label: 'Events', value: String(rangeData.totalEvents ?? 0), paint: color.normal },
  ];

  const width = 12;
  const rows: string[] = [color.bold('Summary')];
  for (let i = 0; i < cells.length; i += 4) {
    const row = cells.slice(i, i + 4);
    rows.push(`  ${row.map(cell => color.dim(padRight(cell.label, width))).join('  ')}`);
    rows.push(`  ${row.map(cell => cell.paint(padRight(cell.value, width))).join('  ')}`);
    if (i + 4 < cells.length) rows.push('');
  }
  return rows;
}

function renderTokenBreakdown(rangeData: RangeData, width: number, color: ReturnType<typeof makeColor>): string {
  const total = rangeData.totalTokens ?? 0;
  const input = rangeData.inputTokens ?? 0;
  const output = rangeData.outputTokens ?? 0;
  const cache = rangeData.cacheReadTokens ?? 0;
  const cacheCreation = rangeData.cacheCreationTokens ?? 0;
  const inputShare = total > 0 ? input / total : 0;
  const outputShare = total > 0 ? output / total : 0;
  const cacheShare = input > 0 ? cache / input : 0;
  const barWidth = tableBarWidth(width);
  const row = (label: string, share: number, value: string) =>
    tableRow(label, value, percent(share), '', renderBar(share, barWidth, color));

  return [
    color.bold('Token Breakdown'),
    row('Input', inputShare, compactNumber(input)),
    row('Output', outputShare, compactNumber(output)),
    tableRow('Cache read', compactNumber(cache), percent(cacheShare), '', color.dim('of input')),
    cacheCreation > 0
      ? tableRow('Cache write', compactNumber(cacheCreation))
      : undefined,
  ].filter(Boolean).join('\n');
}

function renderShareSection<T extends ShareEntry>(
  title: string,
  items: T[],
  width: number,
  color: ReturnType<typeof makeColor>,
  fields: {
    nameHeader: string;
    name: (item: T) => string;
    value: (item: T) => number;
    detail?: (item: T) => string;
  },
): string[] {
  const lines = [color.bold(title)];
  if (items.length === 0) {
    lines.push(color.dim('  no data'));
    return lines;
  }

  const barWidth = tableBarWidth(width);
  lines.push(color.dim(tableRow(fields.nameHeader, 'Tokens', 'Share', '', 'Usage')));
  for (const item of items.slice(0, 6)) {
    const share = clampShare(item.share ?? 0);
    const name = truncateMiddle(fields.name(item), TABLE_NAME_WIDTH);
    const value = compactNumber(fields.value(item));
    const detail = fields.detail ? `  ${color.dim(fields.detail(item))}` : '';
    lines.push(tableRow(name, value, percent(share), '', renderBar(share, barWidth, color), detail));
  }
  return lines;
}

function renderAgentSection(
  items: AgentShareEntry[],
  width: number,
  color: ReturnType<typeof makeColor>,
): string[] {
  const lines = [color.bold('Agents')];
  if (items.length === 0) {
    lines.push(color.dim('  no data'));
    return lines;
  }

  const barWidth = tableBarWidth(width);
  lines.push(color.dim(tableRow('Agent', 'Tokens', 'Events', 'Sess', 'Activity')));
  for (const item of items.slice(0, 8)) {
    const share = clampShare(item.share ?? 0);
    const name = truncateMiddle(item.agentType ?? 'unknown', TABLE_NAME_WIDTH);
    lines.push(tableRow(
      name,
      compactNumber(item.tokens ?? 0),
      String(item.events ?? 0),
      String(item.sessions ?? 0),
      renderBar(share, barWidth, color),
    ));
  }
  return lines;
}

function renderRepoSection(
  items: RepoShareEntry[],
  width: number,
  color: ReturnType<typeof makeColor>,
): string[] {
  const lines = [color.bold('Repositories')];
  if (items.length === 0) {
    lines.push(color.dim('  no data'));
    return lines;
  }

  lines.push(color.dim(tableRow('Repository', '', 'Events', 'Sess')));
  for (const item of items.slice(0, 6)) {
    const repo = truncateMiddle(item.repo ?? 'unknown', TABLE_NAME_WIDTH);
    lines.push(tableRow(repo, '', String(item.events ?? 0), String(item.sessions ?? 0)));
  }
  return lines;
}

function renderTrendSection(
  range: MetricsRange,
  dailyTokens: DailyPoint[],
  dailySessions: DailyPoint[],
  width: number,
  color: ReturnType<typeof makeColor>,
): string[] {
  const count = range === 'thirtyDays' ? 30 : 7;
  const tokenPoints = dailyTokens.slice(-count);
  const sessionPoints = dailySessions.slice(-count);
  const lines = [color.bold(range === 'thirtyDays' ? 'Token Trend (30d)' : 'Token Trend (7d)')];
  if (tokenPoints.length === 0) {
    lines.push(color.dim('  no trend data'));
    return lines;
  }

  const maxValue = Math.max(1, ...tokenPoints.map((p) => p.value ?? 0));
  const barWidth = Math.min(26, Math.max(8, width - 38));
  lines.push(color.dim(`  ${padRight('Day', 5)} ${padLeft('Tokens', 8)}  Trend${' '.repeat(Math.max(0, barWidth - 3))} Sessions`));
  for (const point of tokenPoints) {
    const value = point.value ?? 0;
    const day = point.day?.slice(5) ?? '--';
    const sessions = sessionPoints.find((p) => p.day === point.day)?.value ?? 0;
    lines.push(`  ${day} ${padLeft(compactNumber(value), 8)}  ${renderBar(value / maxValue, barWidth, color)} ${padLeft(String(sessions), 3)}`);
  }
  return lines;
}

function formatServiceState(data: TokenUsageViewData, color: ReturnType<typeof makeColor>): string {
  if (data.runtimeAlive) {
    return color.green(`active pid ${data.runtime?.pid ?? '-'}`);
  }
  if (data.runtime?.status) {
    return color.yellow(`${data.runtime.status} pid ${data.runtime.pid ?? '-'}`);
  }
  return color.yellow('service not running');
}

function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${formatOneDecimal(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${formatOneDecimal(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${formatOneDecimal(value / 1_000)}K`;
  return String(Math.round(value));
}

function formatOneDecimal(value: number): string {
  return value.toFixed(1);
}

function percent(value: number): string {
  return `${Math.round(clampShare(value) * 100)}%`;
}

function renderBar(value: number, width: number, color: ReturnType<typeof makeColor>): string {
  const share = clampShare(value);
  const filled = share > 0 ? Math.max(1, Math.round(width * share)) : 0;
  return color.cyan(`[${'#'.repeat(filled)}${'-'.repeat(Math.max(0, width - filled))}]`);
}

function tableBarWidth(width: number): number {
  return Math.min(TABLE_BAR_WIDTH, Math.max(10, width - 58));
}

function tableRow(
  name: string,
  value = '',
  metric = '',
  meta = '',
  tail = '',
  detail = '',
): string {
  const row = [
    `  ${padRight(name, TABLE_NAME_WIDTH)}`,
    padLeft(value, TABLE_VALUE_WIDTH),
    padLeft(metric, TABLE_METRIC_WIDTH),
    padLeft(meta, TABLE_META_WIDTH),
  ].join(' ');
  const tailPart = tail ? `  ${tail}` : '';
  return `${row}${tailPart}${detail}`;
}

function clampShare(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function formatDateTime(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function terminalWidth(): number {
  return Math.max(72, process.stdout.columns || 100);
}

function trimLines(lines: string[], width: number): string {
  return lines
    .flatMap((line) => line.split('\n'))
    .map((line) => stripAnsi(line).length > width + 20 ? truncateAnsiUnsafe(line, width + 20) : line)
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

function truncateAnsiUnsafe(value: string, maxLength: number): string {
  if (stripAnsi(value).length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}...`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const left = Math.ceil((maxLength - 3) / 2);
  const right = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, left)}...${value.slice(value.length - right)}`;
}

function padRight(value: string, width: number): string {
  const length = visibleLength(value);
  return length >= width ? value : value + ' '.repeat(width - length);
}

function padLeft(value: string, width: number): string {
  const length = visibleLength(value);
  return length >= width ? value : ' '.repeat(width - length) + value;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function makeColor(enabled: boolean) {
  const paint = (code: string, text: string) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    normal: (text: string) => text,
    bold: (text: string) => paint('1', text),
    dim: (text: string) => paint('2', text),
    green: (text: string) => paint('32', text),
    yellow: (text: string) => paint('33', text),
    cyan: (text: string) => paint('36', text),
  };
}
