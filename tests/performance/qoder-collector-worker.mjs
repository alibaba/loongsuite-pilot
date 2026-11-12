import { pathToFileURL } from 'node:url';
const { QoderTranscriptCollector } = await import(pathToFileURL(process.argv[2]).href);
const collector = new QoderTranscriptCollector({ dataDir: process.env.QODER_PERF_CASE,
  agentId: process.argv[3], stableMs: 0 });
let state = {};
process.on('message', async message => {
  try {
    if (message === 'stop') { collector.stop(); process.disconnect(); return; }
    await collector.acknowledge(state);
    const before = process.cpuUsage();
    const start = performance.now();
    const batch = await collector.collect(state); state = batch.state;
    process.send({ records: batch.records, metrics: batch.metrics, elapsedMs: performance.now() - start,
      cpu: process.cpuUsage(before), rssMiB: process.memoryUsage().rss / 1048576 });
  } catch (error) { process.send({ error: String(error.stack) }); }
});
process.send({ ready: true });
