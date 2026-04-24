declare module '@alicloud/log' {
  interface LogClientConfig {
    accessKeyId: string;
    accessKeySecret: string;
    region: string;
    net?: string;
    endpoint?: string;
    securityToken?: string;
  }

  interface LogContent {
    [key: string]: string;
  }

  interface LogEntry {
    timestamp: number;
    content: LogContent;
  }

  interface LogGroup {
    logs: LogEntry[];
    topic?: string;
    source?: string;
    tags?: Array<Record<string, string>>;
  }

  class Client {
    constructor(config: LogClientConfig);

    postLogStoreLogs(
      projectName: string,
      logstoreName: string,
      data: LogGroup,
      options?: Record<string, unknown>,
    ): Promise<string>;

    getProject(projectName: string): Promise<unknown>;
    listLogStore(projectName: string, data?: Record<string, unknown>): Promise<unknown>;
    createLogStore(
      projectName: string,
      logstoreName: string,
      data?: Record<string, unknown>,
    ): Promise<unknown>;
    getLogs(
      projectName: string,
      logstoreName: string,
      from: Date,
      to: Date,
      data?: Record<string, unknown>,
    ): Promise<unknown[]>;
  }

  export = Client;
}
