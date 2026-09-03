import * as crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
  DirectoryPluginActivationConfig,
  DirectoryPluginConfig,
} from '../types/index.js';
import { detectAgent } from './detect-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DirectoryPluginStrategy');

const DEFAULT_MARKER_FILE = '.loongsuite-pilot-managed.json';
const MARKER_SCHEMA_VERSION = 1;
const MARKER_OWNER = 'loongsuite-pilot';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_ACTIVATION_TIMEOUT_MS = 30_000;
const execFile = promisify(execFileCallback);

interface DirectoryPluginMarker {
  schemaVersion: typeof MARKER_SCHEMA_VERSION;
  owner: typeof MARKER_OWNER;
  agentId: string;
  sourceHash: string;
  dataDir?: string;
  activationHash?: string;
  activationStatus?: 'activated' | 'unsupported';
}

interface ActivationCommandOutput {
  stdout: string;
  stderr: string;
}

type TargetState =
  | { kind: 'missing' }
  | { kind: 'empty' }
  | { kind: 'managed'; marker: DirectoryPluginMarker }
  | { kind: 'unmanaged' };

export class DirectoryPluginStrategy implements DeployStrategy {
  private readonly dataDir?: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ? path.resolve(dataDir) : undefined;
  }

  async detect(def: AgentDefinition): Promise<boolean> {
    return detectAgent(def.detection);
  }

  async needsDeploy(
    def: AgentDefinition,
    _record?: DeployedAgentRecord,
  ): Promise<boolean> {
    const config = def.directoryPlugin;
    if (!config) return true;

    try {
      const markerFile = this.resolveMarkerFile(config);
      const targetState = await this.inspectTarget(config.targetDir, markerFile, def.id);
      if (targetState.kind !== 'managed') return true;

      const sourceHash = await this.hashDirectory(config.sourceDir, markerFile);
      if (targetState.marker.sourceHash !== sourceHash) return true;
      if (this.dataDir && targetState.marker.dataDir !== this.dataDir) return true;
      if (targetState.marker.activationHash !== this.hashActivation(config.activation)) return true;

      const targetHash = await this.hashDirectory(
        config.targetDir,
        markerFile,
        config.sourceDir,
      );
      return targetHash !== targetState.marker.sourceHash;
    } catch (err) {
      logger.warn('failed to inspect directory plugin', {
        agentId: def.id,
        error: String(err),
      });
      return true;
    }
  }

  async deploy(def: AgentDefinition): Promise<DeployResult> {
    const config = def.directoryPlugin;
    if (!config) {
      return {
        success: false,
        agentId: def.id,
        deployMode: 'directory-plugin',
        error: 'missing directoryPlugin config',
      };
    }

    let stagingDir: string | undefined;
    try {
      const markerFile = this.resolveMarkerFile(config);
      const sourceDir = path.resolve(config.sourceDir);
      const targetDir = path.resolve(config.targetDir);
      this.assertNonOverlappingPaths(sourceDir, targetDir);
      await this.assertDirectory(sourceDir, 'sourceDir');

      const targetState = await this.inspectTarget(targetDir, markerFile, def.id);
      if (targetState.kind === 'unmanaged') {
        throw new Error(`refusing to overwrite unmanaged non-empty directory: ${targetDir}`);
      }

      const sourceHash = await this.hashDirectory(sourceDir, markerFile);
      const parentDir = path.dirname(targetDir);
      await fs.mkdir(parentDir, { recursive: true });
      stagingDir = await fs.mkdtemp(
        path.join(parentDir, `.${path.basename(targetDir)}.loongsuite-pilot-`),
      );

      await this.copyDirectoryContents(sourceDir, stagingDir);
      const stagedHash = await this.hashDirectory(stagingDir, markerFile);
      if (stagedHash !== sourceHash) {
        throw new Error('source directory changed while it was being copied');
      }

      const marker: DirectoryPluginMarker = {
        schemaVersion: MARKER_SCHEMA_VERSION,
        owner: MARKER_OWNER,
        agentId: def.id,
        sourceHash,
        ...(this.dataDir ? { dataDir: this.dataDir } : {}),
      };
      await this.writeMarker(stagingDir, markerFile, marker);

      if (targetState.kind === 'missing') {
        await fs.rename(stagingDir, targetDir);
      } else {
        await this.replaceExistingTarget(
          targetDir,
          stagingDir,
          markerFile,
          def.id,
          targetState.kind,
        );
      }
      stagingDir = undefined;

      const activationHash = this.hashActivation(config.activation);
      let activationStatus: DirectoryPluginMarker['activationStatus'];
      if (config.activation && activationHash) {
        activationStatus = await this.activate(config.activation);
        marker.activationHash = activationHash;
        marker.activationStatus = activationStatus;
        await this.writeMarker(targetDir, markerFile, marker);
      }

      logger.info('directory plugin deployed', {
        agentId: def.id,
        targetDir,
        sourceHash,
        activationStatus: activationStatus ?? 'not-configured',
      });
      return { success: true, agentId: def.id, deployMode: 'directory-plugin' };
    } catch (err) {
      return {
        success: false,
        agentId: def.id,
        deployMode: 'directory-plugin',
        error: String(err),
      };
    } finally {
      if (stagingDir) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async undeploy(def: AgentDefinition): Promise<boolean> {
    const config = def.directoryPlugin;
    if (!config) return false;

    try {
      const markerFile = this.resolveMarkerFile(config);
      const targetState = await this.inspectTarget(config.targetDir, markerFile, def.id);
      if (targetState.kind === 'missing') return true;
      if (targetState.kind !== 'managed') {
        logger.warn('refusing to remove unmanaged directory plugin', {
          agentId: def.id,
          targetDir: config.targetDir,
        });
        return false;
      }

      if (config.activation?.disableArgs?.length) {
        try {
          await this.deactivate(config.activation);
        } catch (err) {
          logger.warn('failed to deactivate directory plugin before removal', {
            agentId: def.id,
            error: String(err),
          });
        }
      }

      await fs.rm(config.targetDir, { recursive: true, force: true });
      logger.info('directory plugin removed', {
        agentId: def.id,
        targetDir: config.targetDir,
      });
      return true;
    } catch (err) {
      logger.warn('failed to remove directory plugin', {
        agentId: def.id,
        targetDir: config.targetDir,
        error: String(err),
      });
      return false;
    }
  }

  protected async copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    entries.sort((left, right) => this.compareEntryNames(left.name, right.name));

    for (const entry of entries) {
      await fs.cp(
        path.join(sourceDir, entry.name),
        path.join(targetDir, entry.name),
        {
          recursive: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
        },
      );
    }
  }

  protected async runActivationCommand(
    command: string,
    args: string[],
    timeoutMs = DEFAULT_ACTIVATION_TIMEOUT_MS,
  ): Promise<ActivationCommandOutput> {
    const result = await execFile(command, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  }

  private hashActivation(config?: DirectoryPluginActivationConfig): string | undefined {
    if (!config) return undefined;
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify({
      command: config.command,
      probeArgs: config.probeArgs ?? [],
      timeoutMs: config.timeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS,
      enableArgs: config.enableArgs,
      optionalEnableArgs: config.optionalEnableArgs ?? [],
      disableArgs: config.disableArgs ?? [],
    }));
    return `sha256:${hash.digest('hex')}`;
  }

  private async activate(
    config: DirectoryPluginActivationConfig,
  ): Promise<'activated' | 'unsupported'> {
    const probeOutput = await this.probeActivation(config);
    if (probeOutput === null) return 'unsupported';
    const optionalArgs = (config.optionalEnableArgs ?? [])
      .filter(arg => probeOutput.includes(arg));
    await this.runActivationCommand(
      config.command,
      [...config.enableArgs, ...optionalArgs],
      this.resolveActivationTimeout(config),
    );
    return 'activated';
  }

  private async deactivate(config: DirectoryPluginActivationConfig): Promise<void> {
    if (!config.disableArgs?.length || await this.probeActivation(config) === null) return;
    await this.runActivationCommand(
      config.command,
      config.disableArgs,
      this.resolveActivationTimeout(config),
    );
  }

  private async probeActivation(config: DirectoryPluginActivationConfig): Promise<string | null> {
    if (!config.probeArgs?.length) return '';
    try {
      const result = await this.runActivationCommand(
        config.command,
        config.probeArgs,
        this.resolveActivationTimeout(config),
      );
      return `${result.stdout}\n${result.stderr}`;
    } catch (err) {
      if (!this.isExplicitUnsupportedError(err)) throw err;
      logger.info('directory plugin activation is unsupported by target CLI', {
        command: config.command,
      });
      return null;
    }
  }

  private resolveActivationTimeout(config: DirectoryPluginActivationConfig): number {
    const value = config.timeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`directory plugin activation timeoutMs must be positive: ${value}`);
    }
    return value;
  }

  private isExplicitUnsupportedError(err: unknown): boolean {
    const details = err as NodeJS.ErrnoException & {
      stderr?: string | Buffer;
      stdout?: string | Buffer;
      killed?: boolean;
      signal?: string;
    };
    if (
      details.code === 'ENOENT'
      || details.code === 'EACCES'
      || details.code === 'ETIMEDOUT'
      || details.killed
      || details.signal
    ) {
      return false;
    }
    const output = [
      details.message,
      details.stderr?.toString(),
      details.stdout?.toString(),
    ].filter(Boolean).join('\n');
    return /(?:unknown|unrecognized|unsupported|invalid)\s+(?:command|subcommand|choice)|no such command/i
      .test(output);
  }

  private async writeMarker(
    directory: string,
    markerFile: string,
    marker: DirectoryPluginMarker,
  ): Promise<void> {
    await fs.writeFile(
      path.join(directory, markerFile),
      `${JSON.stringify(marker, null, 2)}\n`,
      'utf8',
    );
  }

  private resolveMarkerFile(config: DirectoryPluginConfig): string {
    const markerFile = config.markerFile ?? DEFAULT_MARKER_FILE;
    if (
      !markerFile
      || markerFile === '.'
      || path.isAbsolute(markerFile)
      || path.basename(markerFile) !== markerFile
    ) {
      throw new Error(`markerFile must be a file name inside targetDir: ${markerFile}`);
    }
    return markerFile;
  }

  private assertNonOverlappingPaths(sourceDir: string, targetDir: string): void {
    if (this.isSameOrDescendant(sourceDir, targetDir)
      || this.isSameOrDescendant(targetDir, sourceDir)) {
      throw new Error('sourceDir and targetDir must not overlap');
    }
  }

  private isSameOrDescendant(parentDir: string, candidate: string): boolean {
    const relative = path.relative(parentDir, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private async assertDirectory(directory: string, label: string): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(directory);
    } catch {
      throw new Error(`${label} does not exist: ${directory}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${label} is not a directory: ${directory}`);
    }
  }

  private async inspectTarget(
    targetDir: string,
    markerFile: string,
    agentId: string,
  ): Promise<TargetState> {
    let stat;
    try {
      stat = await fs.lstat(targetDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw err;
    }

    if (!stat.isDirectory()) return { kind: 'unmanaged' };

    const entries = await fs.readdir(targetDir);
    if (entries.length === 0) return { kind: 'empty' };

    const marker = await this.readOwnedMarker(
      path.join(targetDir, markerFile),
      agentId,
    );
    return marker ? { kind: 'managed', marker } : { kind: 'unmanaged' };
  }

  private async readOwnedMarker(
    markerPath: string,
    agentId: string,
  ): Promise<DirectoryPluginMarker | undefined> {
    try {
      const value = JSON.parse(await fs.readFile(markerPath, 'utf8')) as Partial<DirectoryPluginMarker>;
      if (
        value.schemaVersion !== MARKER_SCHEMA_VERSION
        || value.owner !== MARKER_OWNER
        || value.agentId !== agentId
        || typeof value.sourceHash !== 'string'
        || !SHA256_PATTERN.test(value.sourceHash)
        || (
          value.activationHash !== undefined
          && (typeof value.activationHash !== 'string' || !SHA256_PATTERN.test(value.activationHash))
        )
      ) {
        return undefined;
      }
      return value as DirectoryPluginMarker;
    } catch {
      return undefined;
    }
  }

  private async hashDirectory(
    directory: string,
    markerFile: string,
    managedSourceDir?: string,
  ): Promise<string> {
    await this.assertDirectory(directory, 'directory');
    const hash = crypto.createHash('sha256');
    await this.hashEntries(hash, directory, directory, markerFile, managedSourceDir);
    return `sha256:${hash.digest('hex')}`;
  }

  private async hashEntries(
    hash: crypto.Hash,
    rootDir: string,
    currentDir: string,
    markerFile: string,
    managedSourceDir?: string,
  ): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => this.compareEntryNames(left.name, right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join('/');
      if (relativePath === markerFile) continue;
      const ignoreRuntimeArtifact =
        managedSourceDir
        && this.isPythonRuntimeArtifact(entry)
        && !await this.sourceEntryExists(managedSourceDir, relativePath);
      if (ignoreRuntimeArtifact) {
        if (entry.isDirectory()) {
          await this.hashEntries(
            hash,
            rootDir,
            absolutePath,
            markerFile,
            managedSourceDir,
          );
        }
        continue;
      }

      if (entry.isDirectory()) {
        this.updateHashRecord(hash, 'directory', relativePath);
        await this.hashEntries(
          hash,
          rootDir,
          absolutePath,
          markerFile,
          managedSourceDir,
        );
      } else if (entry.isFile()) {
        this.updateHashRecord(hash, 'file', relativePath, await fs.readFile(absolutePath));
      } else if (entry.isSymbolicLink()) {
        this.updateHashRecord(
          hash,
          'symlink',
          relativePath,
          Buffer.from(await fs.readlink(absolutePath), 'utf8'),
        );
      } else {
        throw new Error(`unsupported directory entry: ${absolutePath}`);
      }
    }
  }

  private isPythonRuntimeArtifact(entry: { name: string; isDirectory(): boolean; isFile(): boolean }): boolean {
    return (entry.isDirectory() && entry.name === '__pycache__')
      || (entry.isFile() && (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')));
  }

  private async sourceEntryExists(sourceDir: string, relativePath: string): Promise<boolean> {
    try {
      await fs.lstat(path.join(sourceDir, relativePath));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  private updateHashRecord(
    hash: crypto.Hash,
    type: string,
    relativePath: string,
    content: Buffer = Buffer.alloc(0),
  ): void {
    for (const field of [Buffer.from(type, 'utf8'), Buffer.from(relativePath, 'utf8'), content]) {
      const length = Buffer.allocUnsafe(8);
      length.writeBigUInt64BE(BigInt(field.length));
      hash.update(length);
      hash.update(field);
    }
  }

  private compareEntryNames(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  private async replaceExistingTarget(
    targetDir: string,
    stagingDir: string,
    markerFile: string,
    agentId: string,
    expectedKind: 'empty' | 'managed',
  ): Promise<void> {
    const backupDir = `${stagingDir}.previous`;
    let originalMoved = false;
    let replacementInstalled = false;

    try {
      await fs.rename(targetDir, backupDir);
      originalMoved = true;

      const capturedState = await this.inspectTarget(backupDir, markerFile, agentId);
      if (capturedState.kind !== expectedKind) {
        throw new Error(`target directory changed during deployment: ${targetDir}`);
      }

      await fs.rename(stagingDir, targetDir);
      replacementInstalled = true;
    } catch (err) {
      if (originalMoved && !replacementInstalled) {
        try {
          await fs.rename(backupDir, targetDir);
          originalMoved = false;
        } catch (rollbackErr) {
          throw new Error(
            `${String(err)}; rollback failed (${String(rollbackErr)}); original preserved at ${backupDir}`,
          );
        }
      }
      throw err;
    }

    if (originalMoved) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch((err) => {
        logger.warn('failed to clean previous directory plugin', {
          agentId,
          backupDir,
          error: String(err),
        });
      });
    }
  }
}
