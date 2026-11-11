const fs = require('node:fs');

function rootTriggerEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.LOONGSUITE_PILOT_ROOT_TRIGGER || '').trim());
}

function ensurePrivateLogDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  if (!rootTriggerEnabled()) { fs.chmodSync(dir, 0o700); return; }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Pilot event directory is not a real directory');
  if (stat.uid === 0 && (stat.mode & 0o7777) === 0o1777) return;
  fs.chmodSync(dir, 0o700);
}

exports.ensurePrivateLogDir = ensurePrivateLogDir;
exports.writerSuffix = writerSuffix;
exports.appendPrivateFile = appendPrivateFile;

function writerSuffix() {
  return rootTriggerEnabled() && typeof process.getuid === 'function' ? `-uid${process.getuid()}` : '';
}

function appendPrivateFile(file, content) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND
    | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0), 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('Pilot event file belongs to another writer');
    }
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, content, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}
