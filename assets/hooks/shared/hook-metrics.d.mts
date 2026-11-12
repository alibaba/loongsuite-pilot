export declare const HOOK_METRICS_SPOOL_MAX_BYTES: number;
export declare function isHookMetricName(value: unknown): value is string;
export declare function hookMetricsSpoolDir(dataDir: string): string;
export declare function recordHookTiming(opts: { agentId: string; hookEvent: string; durationMs?: number }): void;
export declare function rotateHookTimingSpool(spoolFile: string, drainingFile: string): boolean;
