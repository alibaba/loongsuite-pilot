import { object, safeScalar } from './records.js';
import type { MulticaRecord } from './types.js';

/** Explicitly opted-in display metadata; never copy descriptions or arbitrary metadata. */
export function entityLabels(recordType: string, value: unknown): MulticaRecord {
  const row = object(value);
  const fields: Record<string, Record<string, unknown>> = {
    agent_snapshot: {agent_name: row.name},
    runtime_snapshot: {runtime_name: typeof row.custom_name === 'string' && row.custom_name.trim() ? row.custom_name : row.name},
    issue_snapshot: {issue_identifier: row.identifier, issue_title: row.title},
    autopilot_snapshot: {autopilot_title: row.title},
    project_snapshot: {project_id: row.id, project_title: row.title},
    workspace_snapshot: {workspace_name: row.name, workspace_slug: row.slug},
  };
  const labels: MulticaRecord = {};
  for (const [key, value] of Object.entries(fields[recordType] ?? {})) {
    const label = safeScalar(value);
    if (label?.trim()) labels[key] = label;
  }
  return labels;
}
