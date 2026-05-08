declare module 'pino-roll' {
  import { WriteStream } from 'node:fs';

  interface PinoRollOptions {
    file: string;
    frequency?: 'daily' | 'hourly' | number;
    size?: string | number;
    dateFormat?: string;
    mkdir?: boolean;
    extension?: string;
    symlink?: boolean;
    limit?: { count?: number };
  }

  function build(options: PinoRollOptions): Promise<WriteStream>;
  export default build;
}
