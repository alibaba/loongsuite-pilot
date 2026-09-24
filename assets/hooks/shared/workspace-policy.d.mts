export declare function validateExcludedWorkspaces(value: unknown): string[];
export declare class WorkspacePolicy {
  constructor(excluded?: string[], stateDirectory?: string);
  readonly enabled: boolean;
  excludes(directory: string): boolean;
  allows(record: Record<string, unknown>, fallbackAgent?: string): boolean;
  filter<T extends Record<string, unknown>>(records: T[], agent?: string): T[];
}
