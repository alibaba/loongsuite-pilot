import fs from "node:fs";
import path from "node:path";
import { openClawCapabilities } from "./compatibility.mjs";

const MAX_PACKAGE_BYTES = 256 * 1024;

/** The 3.8 npm bundle can report runtime.version="unknown" because its
 * source-relative package.json lookup no longer matches the bundled layout.
 * Follow only the executing Node entry, never PATH, cwd, or a version env var:
 * those may describe a different installed OpenClaw. No subprocess or cache.
 */
export function resolveRuntimeCapabilities(runtimeVersion, entry = process.argv[1]) {
  const version = typeof runtimeVersion === "string" ? runtimeVersion.trim() : runtimeVersion;
  // An explicit unsupported/malformed version is authoritative, not a reason
  // to select another installation and bypass the admission guard.
  if (version !== undefined && version !== null && version !== "" && version !== "unknown") {
    return openClawCapabilities(version);
  }
  if (typeof entry !== "string" || !path.isAbsolute(entry)) return null;
  let dir;
  try { dir = path.dirname(fs.realpathSync(entry)); } catch { return null; }
  for (let depth = 0; depth < 8 && dir !== path.parse(dir).root; depth++) {
    let fd;
    try {
      fd = fs.openSync(path.join(dir, "package.json"), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) return null;
      // Bound the read too: the file may grow after fstat. Never import/execute
      // package code just to read metadata.
      const buffer = Buffer.alloc(MAX_PACKAGE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > MAX_PACKAGE_BYTES) return null;
      const pkg = JSON.parse(buffer.toString("utf8", 0, size));
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return null;
      if (pkg?.name === "openclaw") return openClawCapabilities(pkg.version);
      // A nested type-only package.json may be a module-scope marker. A
      // different named package is a boundary; do not search its ancestors.
      if (pkg?.name !== undefined) return null;
    } catch (err) {
      if (err?.code !== "ENOENT") return null;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* fail open for the host */ } }
    }
    dir = path.dirname(dir);
  }
  return null;
}
