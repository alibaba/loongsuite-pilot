export declare function sendAlarm(topic: string, data: Record<string, unknown>): void;
export declare function postAlarm(
  topic: string,
  data: Record<string, unknown>,
  timeoutMs: number,
): Promise<boolean>;
export declare function sendStatus(topic: string, data: Record<string, unknown>): void;
