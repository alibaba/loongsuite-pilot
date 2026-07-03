export interface SelfCheckAlert {
  alertType: 'DATA_GAP' | 'NEVER_COLLECTED';
  agentId: string;
  agentDisplayName: string;
  agentVersion: string;
  pilotVersion: string;
  userId: string;
  hostname: string;
  message: string;
  timestamp: string;
}

export interface Notifier {
  send(alert: SelfCheckAlert): Promise<void>;
}
