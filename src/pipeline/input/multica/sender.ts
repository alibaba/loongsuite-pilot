import type { SlsMode } from '../../../types/index.js';
import type { PipelineSlsFlusherConfig } from '../../types.js';
import {
  postApiKeyLogStoreLogs,
  postWebtracking,
  splitForWebtracking,
  WEBTRACKING_MAX_BODY_BYTES,
} from '../../../flushers/sls-transport.js';
import type { MulticaRecord } from './types.js';

type Destination = PipelineSlsFlusherConfig & {
  mode: SlsMode;
  apiKey?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
};

/** Resolve only after every request is acknowledged; the pipeline owns durable retries. */
export async function sendMulticaRecords(destination: Destination, records: MulticaRecord[], source: string): Promise<void> {
  if (!records.length) return;
  const target = {endpoint: destination.Endpoint, project: destination.Project, logstore: destination.Logstore};
  const tags = {pipeline_type: 'multica', schema_version: 'multica.v1'};
  if (destination.mode === 'webtracking') {
    await postWebtracking(target, records, {topic: 'multica', source, tags});
    return;
  }
  if (destination.mode !== 'apiKey') throw new Error('Unsupported Multica SLS authentication mode');
  if (!destination.apiKey?.trim()) throw new Error('Missing Multica SLS API Key');

  // Keep protobuf requests well below the SLS body limit. A single oversized
  // record must fail durably rather than be silently truncated or acknowledged.
  if (records.some(record => Buffer.byteLength(JSON.stringify(record)) > WEBTRACKING_MAX_BODY_BYTES)) {
    throw new Error('Multica SLS record exceeds the batch size limit');
  }
  const now = Math.floor(Date.now() / 1000);
  for (const chunk of splitForWebtracking(records)) {
    await postApiKeyLogStoreLogs({...target, apiKey: destination.apiKey}, {
      logs: chunk.map(content => {
        const observed = Date.parse(content.observed_at);
        return {timestamp: Number.isFinite(observed) && observed >= 0 ? Math.floor(observed / 1000) : now, content};
      }),
      topic: 'multica', source, tags: [tags],
    });
  }
}
