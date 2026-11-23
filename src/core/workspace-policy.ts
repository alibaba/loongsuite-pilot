import type { AgentActivityEntry } from '../types/index.js';

// One implementation is shared by the collector and standalone hook runtimes.
export { WorkspacePolicy, validateExcludedWorkspaces } from '../../assets/hooks/shared/workspace-policy.mjs';

/** Native roots needed by the trace journal to reapply exclusions on replay. */
export const retainedWorkspaceRoots = Symbol('retainedWorkspaceRoots');
export type WorkspaceScopedEntry = AgentActivityEntry & { [retainedWorkspaceRoots]?: string[] };
