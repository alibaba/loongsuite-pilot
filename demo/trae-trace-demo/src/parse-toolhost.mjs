/**
 * 解析 toolhost 侧数据 → RunCommand 类工具的真实参数/结果/起止
 *
 * 三级关联链路：
 *   ai-agent 日志 command_id=job-xxx
 *     → toolhost.log  "Native async host job completed job_id=job-xxx exit_code=N execution_duration_ms=N"
 *       → jobs/job-xxx/{state.json, output.log, cwd.txt}
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const RE = {
  completed:
    /Native async host job completed job_id=(job-[0-9a-f]+) exit_code=(-?\d+) execution_duration_ms=(\d+)(?:\s+monitor_status=(\w+))?/,
  execEntry: /exec_sandbox entry job_id=(job-[0-9a-f]+) command=(.*?)(?:\s+blocking=|\s+log_path=|$)/,
  logPath: /log_path=(\S+)/,
  head: /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s/,
};

/** 单条命令输出最多读取的字节数，防止把巨型输出灌进浏览器 */
const MAX_OUTPUT_BYTES = 64 * 1024;

export async function parseToolhostLog(toolhostLogPath) {
  /** jobId -> {exitCode, durationMs, monitorStatus, completedAtMs, command, logPath} */
  const jobs = new Map();
  if (!toolhostLogPath || !fs.existsSync(toolhostLogPath)) return jobs;

  const rl = readline.createInterface({
    input: fs.createReadStream(toolhostLogPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.includes('job_id=')) continue;
    const hm = RE.head.exec(line);
    const atMs = hm ? Date.parse(hm[1]) : null;

    const cm = RE.completed.exec(line);
    if (cm) {
      const [, jobId, exitCode, durationMs, monitorStatus] = cm;
      const prev = jobs.get(jobId) || { jobId };
      jobs.set(jobId, {
        ...prev,
        exitCode: Number(exitCode),
        durationMs: Number(durationMs),
        monitorStatus: monitorStatus || null,
        completedAtMs: Number.isNaN(atMs) ? null : atMs,
      });
      continue;
    }

    const em = RE.execEntry.exec(line);
    if (em) {
      const [, jobId, command] = em;
      const lp = RE.logPath.exec(line);
      const prev = jobs.get(jobId) || { jobId };
      jobs.set(jobId, {
        ...prev,
        command: command.trim(),
        logPath: lp ? lp[1] : prev.logPath || null,
        startedAtMs: Number.isNaN(atMs) ? null : atMs,
      });
    }
  }

  return jobs;
}

/**
 * 读取某个 job 的落盘目录。
 * 该目录在系统临时目录下，随时可能被清理，因此全部访问都要容错。
 */
export function readJobArtifacts(jobsDir, jobId) {
  if (!jobsDir || !jobId) return null;
  const dir = path.join(jobsDir, jobId);
  if (!fs.existsSync(dir)) return null;

  const out = { jobId, dir, state: null, cwd: null, output: null, outputTruncated: false };

  try {
    const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    out.state = JSON.parse(raw);
  } catch {
    /* state.json 可能尚未写入或已被清理 */
  }

  try {
    out.cwd = fs.readFileSync(path.join(dir, 'cwd.txt'), 'utf8').trim();
  } catch {
    /* optional */
  }

  try {
    const p = path.join(dir, 'output.log');
    const size = fs.statSync(p).size;
    if (size > MAX_OUTPUT_BYTES) {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(MAX_OUTPUT_BYTES);
      fs.readSync(fd, buf, 0, MAX_OUTPUT_BYTES, 0);
      fs.closeSync(fd);
      out.output = buf.toString('utf8');
      out.outputTruncated = true;
      out.outputTotalBytes = size;
    } else {
      out.output = fs.readFileSync(p, 'utf8');
      out.outputTotalBytes = size;
    }
  } catch {
    /* output.log 可能不存在（非命令类 job） */
  }

  return out;
}

/** 扫描 jobs 目录，返回全部 jobId（用于诊断） */
export function listJobIds(jobsDir) {
  if (!jobsDir || !fs.existsSync(jobsDir)) return [];
  try {
    return fs
      .readdirSync(jobsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('job-'))
      .map(d => d.name);
  } catch {
    return [];
  }
}
