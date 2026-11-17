import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , configPath, action, ...args] = process.argv;

function parsePort(value) {
  if (!/^\d{1,5}$/.test(value)) throw new Error('port must be an integer between 1 and 65535');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('port must be an integer between 1 and 65535');
  return port;
}

export async function updateDashboardConfig(file, command, options = []) {
  if (!file || !['start', 'stop'].includes(command) ||
      (command === 'start' && options.length > 1) ||
      (command === 'stop' && options.length !== 0)) {
    throw new Error('usage: loongsuite-pilot dashboard start [port] | stop');
  }
  const port = options.length ? parsePort(options[0]) : undefined;
  let original = null;
  let mode = 0o600;
  try {
    original = await fs.readFile(file, 'utf8');
    mode = (await fs.stat(file)).mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let config = {};
  if (original !== null) {
    try {
      config = JSON.parse(original.replace(/^\uFEFF/, ''));
    } catch {
      throw new Error(`refusing to overwrite invalid JSON config: ${file}`);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`refusing to overwrite non-object JSON config: ${file}`);
    }
  }
  const dashboard = config.dashboard;
  if (dashboard !== undefined && (!dashboard || typeof dashboard !== 'object' || Array.isArray(dashboard))) {
    throw new Error(`refusing to overwrite invalid dashboard config: ${file}`);
  }
  config.dashboard = { ...dashboard, enabled: command === 'start' };
  if (port !== undefined) config.dashboard.port = port;

  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return config.dashboard.port ?? 8765;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  updateDashboardConfig(configPath, action, args).then(port => {
    console.log(`Dashboard ${action === 'start' ? 'enabled' : 'disabled'} in ${configPath} (port ${port}).`);
  }).catch(error => {
    console.error(`loongsuite-pilot dashboard: ${error.message}`);
    process.exitCode = 1;
  });
}
