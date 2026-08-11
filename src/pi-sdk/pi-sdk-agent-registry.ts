import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType } from '../types/index.js';
import type { AgentDefinition } from '../types/index.js';
import { detectAgent } from '../deployment/detect-utils.js';
import { PluginInjectStrategy } from '../deployment/plugin-inject-strategy.js';
import {
  ensureDir,
  fileExists,
  readJsonFile,
  resolveHome,
  writeJsonFile,
  writeTextFileAtomic,
} from '../utils/fs-utils.js';

const AGENT_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const RESERVED_AGENT_IDS = new Set<string>([
  ...Object.values(ClientType),
  // Definition ids that intentionally differ from their emitted ClientType.
  'hermes-agent',
  'qoder-jetbrains',
]);
const PI_SDK_INPUT_TYPE = 'pi-sdk-jsonl';

export interface PiSdkAgentRegistrationRequest {
  dataDir: string;
  id: string;
  name: string;
  agentDir: string;
  detectionPaths?: string[];
  detectionCommands?: string[];
}

export interface PiSdkAgentRegistrationResult {
  definition: AgentDefinition;
  definitionPath: string;
  wrapperPath: string;
  settingsPath: string;
  warnings: string[];
}

export interface PiSdkAgentDoctorResult {
  id: string;
  name: string;
  agentDir: string;
  detected: boolean;
  wrapperPresent: boolean;
  runtimePresent: boolean;
  injectionPresent: boolean;
  healthy: boolean;
}

export function validatePiSdkAgentId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!AGENT_ID_RE.test(id)) {
    throw new Error('agent id must be 1-64 lowercase letters, digits, dots, underscores, or hyphens');
  }
  if (RESERVED_AGENT_IDS.has(id)) {
    throw new Error(`agent id is reserved by the built-in integration: ${id}`);
  }
  return id;
}

export function buildPiSdkAgentDefinition(
  request: Omit<PiSdkAgentRegistrationRequest, 'dataDir'>,
): AgentDefinition {
  const id = validatePiSdkAgentId(request.id);
  const name = request.name.trim();
  if (!name) throw new Error('agent name is required');
  if (name.length > 128) throw new Error('agent name must not exceed 128 characters');

  const agentDir = resolveAbsolutePath(request.agentDir, 'agent directory');
  const suppliedPaths = (request.detectionPaths ?? []).map(value =>
    resolveAbsolutePath(value, 'detection path', true),
  );
  const commands = uniqueStrings(request.detectionCommands ?? [], 'detection command');
  if (suppliedPaths.length === 0 && commands.length === 0) {
    throw new Error('at least one --detect-path or --detect-command is required');
  }

  // agentDir is configuration, not proof that the Agent is installed: Pilot
  // may create it while injecting settings.json. Keep detection based only on
  // the explicit signals supplied by the Agent integrator.
  const detectionPaths = [...new Set(suppliedPaths)];
  const settingsPath = path.join(agentDir, 'settings.json');
  const relativeWrapperPath = `plugins/pi-coding-agent/agents/${id}.mjs`;

  return {
    id,
    displayName: name,
    deployMode: 'plugin-inject',
    detection: {
      paths: detectionPaths,
      commands,
    },
    piSdk: {
      schemaVersion: 1,
      agentDir,
    },
    pluginInject: {
      configPaths: [settingsPath],
      pluginSpec: `$PILOT_DATA/${relativeWrapperPath}`,
      pluginId: `loongsuite-pilot-pi-sdk-${id}`,
      configKey: 'extensions',
      createIfMissing: true,
    },
    input: {
      type: PI_SDK_INPUT_TYPE,
      logDir: '$PILOT_DATA/logs/pi-coding-agent',
    },
  };
}

export async function registerPiSdkAgent(
  request: PiSdkAgentRegistrationRequest,
): Promise<PiSdkAgentRegistrationResult> {
  const dataDir = resolveAbsolutePath(request.dataDir, 'Pilot data directory');
  const definition = buildPiSdkAgentDefinition(request);
  const definitionPath = getDefinitionPath(dataDir, definition.id);
  const wrapperPath = getWrapperPath(dataDir, definition.id);
  const settingsPath = definition.pluginInject!.configPaths[0];
  const warnings: string[] = [];

  const existing = await readJsonFile<AgentDefinition>(definitionPath);
  if (existing && !isPiSdkAgentDefinition(existing)) {
    throw new Error(`local Agent definition already exists and is not managed as PI SDK: ${definition.id}`);
  }
  await assertDedicatedAgentDir(dataDir, definition);

  await ensureDir(path.dirname(wrapperPath));
  await ensureDir(path.dirname(definitionPath));

  const missingRuntimeAssets = await findMissingRuntimeAssets(dataDir);
  if (missingRuntimeAssets.length > 0) {
    throw new Error(`Pilot PI extension runtime is missing; reinstall or repair Pilot: ${missingRuntimeAssets.join(', ')}`);
  }

  let previousWrapper: string | null = null;
  try {
    previousWrapper = await fs.readFile(wrapperPath, 'utf8');
  } catch {
    previousWrapper = null;
  }

  await writeTextFileAtomic(wrapperPath, renderPiSdkWrapper(definition));
  await tightenPrivateFile(wrapperPath);

  const strategy = new PluginInjectStrategy(dataDir, dataDir);
  const deployResult = await strategy.deploy(definition);
  if (!deployResult.success) {
    await restoreWrapper(wrapperPath, previousWrapper);
    throw new Error(deployResult.error ?? `failed to inject PI SDK extension for ${definition.id}`);
  }

  try {
    await writeJsonFile(definitionPath, definition);
    await tightenPrivateFile(definitionPath);
  } catch (err) {
    // If this was a new settings location, undo only that new injection. For an
    // in-place update the existing registration already owns the same entry.
    if (!existing || existing.pluginInject?.configPaths[0] !== settingsPath) {
      await strategy.undeploy(definition).catch(() => false);
    }
    await restoreWrapper(wrapperPath, previousWrapper);
    throw err;
  }

  // Persist the new registration before removing the old entry. A failed
  // definition write then leaves the previous, fully working registration
  // intact rather than switching the Agent into an unmanaged half-state.
  if (existing && existing.pluginInject?.configPaths[0] !== settingsPath) {
    const cleaned = await strategy.undeploy(existing);
    if (!cleaned) warnings.push(`old PI settings entry could not be removed: ${existing.pluginInject?.configPaths[0]}`);
  }

  return { definition, definitionPath, wrapperPath, settingsPath, warnings };
}

export async function unregisterPiSdkAgent(
  dataDirValue: string,
  idValue: string,
): Promise<{ id: string; injectionRemoved: boolean; definitionRemoved: boolean }> {
  const dataDir = resolveAbsolutePath(dataDirValue, 'Pilot data directory');
  const id = validatePiSdkAgentId(idValue);
  const definitionPath = getDefinitionPath(dataDir, id);
  const definition = await readJsonFile<AgentDefinition>(definitionPath);
  if (!definition || !isPiSdkAgentDefinition(definition)) {
    throw new Error(`registered PI SDK Agent not found: ${id}`);
  }

  const strategy = new PluginInjectStrategy(dataDir, dataDir);
  const injectionRemoved = await strategy.undeploy(definition);
  if (!injectionRemoved) {
    // Keep the durable definition and generated wrapper together with the
    // still-live settings reference. A later retry can then complete cleanup;
    // deleting either asset here would strand an extension reference that the
    // registry can no longer diagnose or repair.
    throw new Error(
      `failed to remove PI SDK extension from ${definition.pluginInject!.configPaths.join(', ')}; registration preserved for retry`,
    );
  }
  await fs.unlink(definitionPath);
  await fs.unlink(getWrapperPath(dataDir, id)).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  });

  return { id, injectionRemoved: true, definitionRemoved: true };
}

export async function listRegisteredPiSdkAgents(dataDirValue: string): Promise<AgentDefinition[]> {
  const dataDir = resolveAbsolutePath(dataDirValue, 'Pilot data directory');
  const definitionsDir = path.join(dataDir, 'agents.d.local');
  let names: string[];
  try {
    names = await fs.readdir(definitionsDir);
  } catch {
    return [];
  }

  const definitions: AgentDefinition[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const definition = await readJsonFile<AgentDefinition>(path.join(definitionsDir, name));
    if (definition && isPiSdkAgentDefinition(definition)) definitions.push(definition);
  }
  return definitions;
}

/**
 * Recreate generated wrappers after an upgrade or non-purge reinstall. The
 * durable registration lives in agents.d.local; wrapper modules are derived
 * artifacts under the Pilot-managed plugins directory.
 */
export async function ensureRegisteredPiSdkWrappers(dataDirValue: string): Promise<number> {
  const dataDir = resolveAbsolutePath(dataDirValue, 'Pilot data directory');
  const definitions = await listRegisteredPiSdkAgents(dataDir);
  if (definitions.length === 0) return 0;

  const missingRuntimeAssets = await findMissingRuntimeAssets(dataDir);
  if (missingRuntimeAssets.length > 0) {
    throw new Error(`Pilot PI extension runtime is missing; reinstall or repair Pilot: ${missingRuntimeAssets.join(', ')}`);
  }

  let restored = 0;
  for (const definition of definitions) {
    // Never derive a filesystem path from a hand-edited local definition until
    // the identifier has passed the same validation used at registration time.
    validatePiSdkAgentId(definition.id);
    const wrapperPath = getWrapperPath(dataDir, definition.id);
    const expected = renderPiSdkWrapper(definition);
    let current: string | null = null;
    try {
      current = await fs.readFile(wrapperPath, 'utf8');
    } catch {
      current = null;
    }
    if (current === expected) continue;

    await ensureDir(path.dirname(wrapperPath));
    await writeTextFileAtomic(wrapperPath, expected);
    await tightenPrivateFile(wrapperPath);
    restored += 1;
  }
  return restored;
}

export async function doctorPiSdkAgent(
  dataDirValue: string,
  idValue: string,
): Promise<PiSdkAgentDoctorResult> {
  const dataDir = resolveAbsolutePath(dataDirValue, 'Pilot data directory');
  const id = validatePiSdkAgentId(idValue);
  const definition = await readJsonFile<AgentDefinition>(getDefinitionPath(dataDir, id));
  if (!definition || !isPiSdkAgentDefinition(definition)) {
    throw new Error(`registered PI SDK Agent not found: ${id}`);
  }

  const strategy = new PluginInjectStrategy(dataDir, dataDir);
  const [detected, wrapperPresent, missingRuntimeAssets, needsDeploy] = await Promise.all([
    detectAgent(definition.detection),
    fileExists(getWrapperPath(dataDir, id)),
    findMissingRuntimeAssets(dataDir),
    strategy.needsDeploy(definition),
  ]);
  const runtimePresent = missingRuntimeAssets.length === 0;
  const injectionPresent = !needsDeploy;

  return {
    id,
    name: definition.displayName,
    agentDir: definition.piSdk.agentDir,
    detected,
    wrapperPresent,
    runtimePresent,
    injectionPresent,
    healthy: detected && runtimePresent && wrapperPresent && injectionPresent,
  };
}

export function isPiSdkAgentDefinition(definition: AgentDefinition): definition is AgentDefinition & {
  piSdk: NonNullable<AgentDefinition['piSdk']>;
} {
  const id = definition.id;
  const pluginInject = definition.pluginInject;
  return definition.deployMode === 'plugin-inject'
    && typeof id === 'string'
    && AGENT_ID_RE.test(id)
    && !RESERVED_AGENT_IDS.has(id)
    && definition.piSdk?.schemaVersion === 1
    && typeof definition.piSdk.agentDir === 'string'
    && definition.piSdk.agentDir.length > 0
    && pluginInject?.configKey === 'extensions'
    && pluginInject.pluginId === `loongsuite-pilot-pi-sdk-${id}`
    && pluginInject.pluginSpec === `$PILOT_DATA/plugins/pi-coding-agent/agents/${id}.mjs`;
}

function getDefinitionPath(dataDir: string, id: string): string {
  return path.join(dataDir, 'agents.d.local', `${id}.json`);
}

function getWrapperPath(dataDir: string, id: string): string {
  return path.join(dataDir, 'plugins', 'pi-coding-agent', 'agents', `${id}.mjs`);
}

function renderPiSdkWrapper(definition: AgentDefinition): string {
  const identity = {
    agentType: definition.id,
    agentId: definition.id,
    agentName: definition.displayName,
    agentSystem: 'pi',
    framework: 'pi',
  };
  return [
    '// Generated by loongsuite-pilot. Re-register the Agent instead of editing this file.',
    "import { createPiTelemetryExtension } from '../index.mjs';",
    '',
    `export default createPiTelemetryExtension(${JSON.stringify(identity, null, 2)});`,
    '',
  ].join('\n');
}

function resolveAbsolutePath(rawValue: string, label: string, allowGlob = false): string {
  const value = rawValue?.trim();
  if (!value) throw new Error(`${label} is required`);
  if (value.includes('\0')) throw new Error(`${label} contains an invalid null byte`);
  if (!allowGlob && (value.includes('*') || value.includes('?'))) {
    throw new Error(`${label} must not contain glob characters`);
  }
  const expanded = resolveHome(value);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded);
}

function uniqueStrings(values: string[], label: string): string[] {
  const out = new Set<string>();
  for (const raw of values) {
    const value = raw?.trim();
    if (!value) throw new Error(`${label} must not be empty`);
    if (value.includes('\0')) throw new Error(`${label} contains an invalid null byte`);
    if (value.length > 512) throw new Error(`${label} is too long`);
    out.add(value);
  }
  return [...out];
}

async function tightenPrivateFile(filePath: string): Promise<void> {
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
}

async function restoreWrapper(wrapperPath: string, previous: string | null): Promise<void> {
  if (previous === null) {
    await fs.unlink(wrapperPath).catch(() => {});
    return;
  }
  await writeTextFileAtomic(wrapperPath, previous);
  await tightenPrivateFile(wrapperPath);
}

async function findMissingRuntimeAssets(dataDir: string): Promise<string[]> {
  const candidates = [
    path.join(dataDir, 'plugins', 'pi-coding-agent', 'index.mjs'),
    path.join(dataDir, 'plugins', 'shared', 'resource-context.mjs'),
  ];
  const present = await Promise.all(candidates.map(candidate => fileExists(candidate)));
  return candidates.filter((_, index) => !present[index]);
}

async function assertDedicatedAgentDir(dataDir: string, definition: AgentDefinition): Promise<void> {
  const agentDir = comparablePath(definition.piSdk!.agentDir);
  const defaultPiAgentDir = comparablePath(resolveHome('~/.pi/agent'));
  if (agentDir === defaultPiAgentDir) {
    throw new Error(
      'agentDir must be dedicated to this custom Agent; ~/.pi/agent is owned by the built-in PI integration',
    );
  }

  const registered = await listRegisteredPiSdkAgents(dataDir);
  const conflict = registered.find(candidate =>
    candidate.id !== definition.id
    && comparablePath(candidate.piSdk!.agentDir) === agentDir,
  );
  if (conflict) {
    throw new Error(`agentDir is already registered to PI SDK Agent ${conflict.id}: ${agentDir}`);
  }

  // Also catch retained/orphaned Pilot PI wrappers in an existing settings
  // file. Loading two telemetry extensions in one AgentSession duplicates all
  // events and assigns conflicting Agent identities.
  const settingsPath = definition.pluginInject!.configPaths[0];
  const settings = await readJsonFile<{ extensions?: unknown[] }>(settingsPath);
  const extensions = Array.isArray(settings?.extensions) ? settings.extensions : [];
  const ownWrapper = comparablePath(getWrapperPath(dataDir, definition.id));
  for (const entry of extensions) {
    if (typeof entry !== 'string') continue;
    const normalized = comparablePath(entry.replace(/^file:\/\//, ''));
    const isBuiltIn = normalized.endsWith(comparablePath('plugins/pi-coding-agent/index.mjs'));
    const isAnotherManagedWrapper = normalized.includes(comparablePath('plugins/pi-coding-agent/agents/'))
      && normalized !== ownWrapper;
    if (isBuiltIn || isAnotherManagedWrapper) {
      throw new Error(`agentDir already loads another Pilot PI telemetry extension: ${entry}`);
    }
  }
}

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
