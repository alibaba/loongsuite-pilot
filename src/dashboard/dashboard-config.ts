import { createHash } from 'node:crypto';
import * as path from 'node:path';

// Shared by the collector and the lightweight browser launcher.
export const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
export const DEFAULT_DASHBOARD_PORT = 8_765;
export const DASHBOARD_ID_HEADER = 'x-loongsuite-pilot-dashboard';
export const DASHBOARD_ID_VALUE = 'metrics-summary-v1';
export const DASHBOARD_INSTANCE_HEADER = 'x-loongsuite-pilot-instance';

export function resolveDashboardPort(port: unknown): number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : DEFAULT_DASHBOARD_PORT;
}

export function dashboardInstanceId(dataDir: string): string {
  return createHash('sha256').update(path.resolve(dataDir)).digest('hex');
}
