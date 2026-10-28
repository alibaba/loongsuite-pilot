// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import { loadDatabaseSync, type DatabaseSyncInstance } from '../../utils/node-sqlite.js';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createLogger } from '../../utils/logger.js';
const EVENT_TYPES = new Set(['session.start', 'session.shutdown', 'user.message', 'system.message',
    'assistant.turn_start', 'assistant.message', 'assistant.turn_end', 'tool.execution_start',
    'tool.execution_complete', 'permission.completed', 'abort']);
const READ_BUDGET = 4 * 1024 * 1024;
const logger = createLogger('CopilotSourceIndex');
/** Durable source/correlation index. It stores source records, never output batches.
 * Reading and delivery are independent transactions; only markDelivered is a
 * delivery checkpoint. SQLite keeps historical records and IDs out of JS memory.
 */
export class CopilotSourceIndex {
    private db?: DatabaseSyncInstance;
    private collectionStartMs?: number;
    constructor(private readonly file: string, private readonly onMalformed?: (file: string, offset: number) => void) { }
    async open(): Promise<void> {
        if (this.db)
            return;
        await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const DatabaseSync = loadDatabaseSync();
        if (!DatabaseSync) throw new Error('Copilot source indexing requires unflagged node:sqlite (Node.js >= 22.13 or >= 23.4)');
        this.db = new DatabaseSync(this.file);
        try {
            await fsp.chmod(this.file, 0o600);
            await this.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          PRAGMA cache_size=-4096; PRAGMA temp_store=FILE;
      CREATE TABLE IF NOT EXISTS sources(path TEXT PRIMARY KEY, kind TEXT, identity TEXT, offset INTEGER, session TEXT, active TEXT, anchor TEXT);
      CREATE TABLE IF NOT EXISTS records(kind TEXT, session TEXT, id TEXT, interaction TEXT, type TEXT, trace TEXT, stamp TEXT, body TEXT,
            PRIMARY KEY(kind,session,id));
      CREATE INDEX IF NOT EXISTS record_interaction ON records(session,interaction,kind);
      CREATE INDEX IF NOT EXISTS record_trace ON records(session,trace,kind);
      CREATE INDEX IF NOT EXISTS record_history ON records(session,kind,type,stamp);
      CREATE TABLE IF NOT EXISTS interactions(session TEXT, id TEXT, checked INTEGER DEFAULT 0, PRIMARY KEY(session,id));
      CREATE TABLE IF NOT EXISTS delivered(key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS partial_sources(path TEXT PRIMARY KEY, position INTEGER, anchor TEXT);
      CREATE TABLE IF NOT EXISTS partial_chunks(path TEXT, position INTEGER, body BLOB, PRIMARY KEY(path,position));
      CREATE TABLE IF NOT EXISTS native_wait(session TEXT, interaction TEXT, since INTEGER, PRIMARY KEY(session,interaction));
      CREATE TABLE IF NOT EXISTS collection_policy(start_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ignored_interactions(session TEXT, id TEXT, reason TEXT, PRIMARY KEY(session,id));
      CREATE TABLE IF NOT EXISTS deferred_spans(session TEXT,id TEXT,interaction TEXT,trace TEXT,path TEXT,identity TEXT,offset INTEGER,bytes INTEGER,checked INTEGER DEFAULT 0,
            PRIMARY KEY(session,id));
      CREATE INDEX IF NOT EXISTS deferred_span_trace ON deferred_spans(session,trace);
      CREATE INDEX IF NOT EXISTS deferred_span_interaction ON deferred_spans(session,interaction);
      CREATE INDEX IF NOT EXISTS deferred_span_path ON deferred_spans(path);
      CREATE TABLE IF NOT EXISTS sequence(value INTEGER); INSERT INTO sequence SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM sequence);`);
        } catch (err) {
            await this.close().catch(() => {});
            throw err;
        }
    }
    async exec(sql: string): Promise<void> { this.db!.exec(sql); }
    async run(sql: string, args: unknown[] = []): Promise<void> { this.db!.prepare(sql).run(...args); }
    async all<T = any>(sql: string, args: unknown[] = []): Promise<T[]> { return this.db!.prepare(sql).all(...args) as T[]; }
    async historyStartTime(): Promise<number | undefined> {
        const rows = await this.all<{start_ms: number}>('SELECT start_ms FROM collection_policy');
        if (!rows.length) return undefined;
        if (rows.length !== 1 || !Number.isSafeInteger(rows[0].start_ms) || rows[0].start_ms < 0) {
            throw new Error('Invalid Copilot source-index collection policy');
        }
        return rows[0].start_ms;
    }
    /** Adopt the policy once, including pending history indexed by an older release. */
    async applyHistoryPolicy(startMs: number): Promise<void> {
        if (!Number.isSafeInteger(startMs) || startMs < 0) throw new RangeError('Invalid Copilot history boundary');
        const previous = await this.historyStartTime();
        if (previous !== undefined && previous !== startMs) throw new Error('Copilot source-index history boundary changed');
        this.collectionStartMs = startMs;
        if (previous !== undefined) return;
        await this.exec('BEGIN IMMEDIATE');
        try {
            await this.run('INSERT INTO collection_policy VALUES(?)', [startMs]);
            let cursor = 0;
            for (;;) {
                const page = await this.all<{rowid: number; session: string; id: string}>(
                    'SELECT rowid,session,id FROM interactions WHERE rowid>? ORDER BY rowid LIMIT 256', [cursor]);
                if (!page.length) break;
                for (const row of page) {
                    cursor = row.rowid;
                    await this.isEligible(row.session, row.id);
                }
                if (page.length === 256) await new Promise<void>(resolve => setImmediate(resolve));
            }
            await this.run("DELETE FROM records AS r WHERE r.kind='span' AND r.interaction='' AND NOT EXISTS(SELECT 1 FROM records c WHERE c.kind='span' AND c.session=r.session AND c.trace=r.trace AND c.interaction<>'')");
            await this.exec('COMMIT');
        } catch (err) { await this.exec('ROLLBACK'); throw err; }
    }
    private async ignored(session: string, id: string): Promise<boolean> {
        return (await this.all('SELECT 1 FROM ignored_interactions WHERE session=? AND id=?', [session, id])).length > 0;
    }
    private async ignore(session: string, id: string, reason: string, purge = true): Promise<void> {
        await this.run(`INSERT INTO ignored_interactions VALUES(?,?,?) ON CONFLICT(session,id) DO UPDATE SET reason=excluded.reason
            WHERE ignored_interactions.reason LIKE 'native-%' AND excluded.reason NOT LIKE 'native-%'`, [session, id, reason]);
        if (!purge) return;
        await this.run('DELETE FROM records WHERE session=? AND interaction=?', [session, id]);
        await this.run('DELETE FROM interactions WHERE session=? AND id=?', [session, id]);
        await this.run('DELETE FROM native_wait WHERE session=? AND interaction=?', [session, id]);
        await this.run('DELETE FROM deferred_spans WHERE session=? AND interaction=?', [session, id]);
    }
    /** A valid user boundary wins over native timestamps; missing evidence never authorizes replay. */
    async isEligible(session: string, id: string): Promise<boolean> {
        if (this.collectionStartMs === undefined) return true;
        if (await this.ignored(session, id)) return false;
        const eventType = id.startsWith('summary:') ? 'session.shutdown' : 'user.message';
        let rows = await this.all<{stamp: string}>(
            "SELECT stamp FROM records WHERE session=? AND interaction=? AND kind='event' AND type=? ORDER BY rowid LIMIT 1", [session, id, eventType]);
        const nativeOnly = !rows.length && eventType !== 'session.shutdown';
        if (!rows.length && eventType !== 'session.shutdown') rows = await this.all<{stamp: string}>(
            "SELECT stamp FROM records WHERE session=? AND interaction=? AND kind='span' AND type='chat' ORDER BY rowid LIMIT 1", [session, id]);
        if (!rows.length) return false;
        const stamp = Date.parse(rows[0].stamp);
        if (!Number.isFinite(stamp) || stamp < this.collectionStartMs) {
            const reason = Number.isFinite(stamp) ? 'before-activation' : 'invalid-event-time';
            // A transcript may still arrive after this provisional native-only
            // decision. Keep its correlation records until a user boundary wins.
            await this.ignore(session, id, nativeOnly ? `native-${reason}` : reason, !nativeOnly);
            return false;
        }
        return true;
    }
    async close(): Promise<void> {
        const db = this.db;
        this.db = undefined;
        db?.close();
    }
    async ingest(file: string, kind: 'event' | 'span'): Promise<void> {
        const handle = await fsp.open(file, 'r');
        try {
            const stat = await handle.stat();
            if (!stat.isFile()) return;
            const identity = `${stat.dev}:${stat.ino}`;
            const previous = (await this.all('SELECT * FROM sources WHERE path=?', [file]))[0];
            const partial = (await this.all('SELECT * FROM partial_sources WHERE path=?', [file]))[0];
            const anchorAt = async (end: number) => {
                const buffer = Buffer.alloc(Math.min(64, end));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, end - buffer.length);
                return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
            };
            const reset = !previous || previous.identity !== identity || stat.size < previous.offset
                || previous.anchor !== await anchorAt(previous.offset)
                || (partial && (stat.size < partial.position || partial.anchor !== await anchorAt(partial.position)));
            let offset = reset ? 0 : previous.offset;
            let session = reset ? '' : previous.session;
            let active = reset ? '' : previous.active;
            let position = reset ? 0 : partial?.position ?? offset;
            if (!reset && position === stat.size) return;
            // Persist unfinished line fragments on disk, separately from complete
            // record offsets. Each poll reads at most READ_BUDGET, including tails.
            // Only a completed record is materialized for JSON parsing.
            const limit = Math.min(stat.size, position + READ_BUDGET);
            await this.exec('BEGIN IMMEDIATE');
            try {
                if (reset) {
                    await this.run('DELETE FROM partial_chunks WHERE path=?', [file]);
                    await this.run('DELETE FROM partial_sources WHERE path=?', [file]);
                    await this.run('DELETE FROM deferred_spans WHERE path=?', [file]);
                }
                while (position < limit) {
                    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - position));
                    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
                    if (!bytesRead) break;
                    const chunkStart = position;
                    position += bytesRead;
                    const buffer = chunk.subarray(0, bytesRead);
                    let start = 0;
                    for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, start)) {
                        const tail = buffer.subarray(start, end + 1);
                        let line = tail;
                        if (offset < chunkStart + start) {
                            const stored = await this.all<{body: Uint8Array}>('SELECT body FROM partial_chunks WHERE path=? ORDER BY position', [file]);
                            line = Buffer.concat([...stored.map(r => r.body), tail]);
                            await this.run('DELETE FROM partial_chunks WHERE path=?', [file]);
                        }
                        const raw = line.toString('utf8').trim();
                        let record: any;
                        if (raw) {
                            try {
                                record = JSON.parse(raw);
                                if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('not an object');
                            } catch {
                                // Complete malformed records are isolated. Never log raw prompts.
                                this.onMalformed?.(file, offset);
                                record = undefined;
                                // An unreadable event may have been a session/user boundary.
                                // Do not attach later records to the preceding interaction.
                                if (kind === 'event') active = '';
                            }
                        }
                        if (record && kind === 'event') {
                            if (record.type === 'session.start') {
                                session = typeof record.data?.sessionId === 'string' ? record.data.sessionId : '';
                                active = '';
                            }
                            if (typeof record.data?.interactionId === 'string') active = record.data.interactionId;
                            else if (record.type === 'user.message') active = typeof record.id === 'string' ? record.id : '';
                            if (session && EVENT_TYPES.has(record.type) && typeof record.id === 'string') {
                                const interaction = record.type === 'session.shutdown' ? `summary:${record.id}` : active;
                                let retain = true;
                                if (this.collectionStartMs !== undefined && interaction) {
                                    if (record.type === 'user.message' || record.type === 'session.shutdown') {
                                        const stamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
                                        if (!Number.isFinite(stamp) || stamp < this.collectionStartMs) {
                                            await this.ignore(session, interaction, Number.isFinite(stamp) ? 'before-activation' : 'invalid-event-time');
                                        } else if (record.type === 'user.message') {
                                            await this.run("DELETE FROM ignored_interactions WHERE session=? AND id=? AND reason IN ('native-before-activation','native-invalid-event-time')", [session, interaction]);
                                        }
                                    }
                                    retain = !await this.ignored(session, interaction);
                                }
                                if (retain && (interaction || record.type === 'session.start')) {
                                    await this.run('INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?,?)', [kind, session, record.id, interaction, record.type, '', typeof record.timestamp === 'string' ? record.timestamp : '', raw]);
                                    if (interaction) await this.run('INSERT OR IGNORE INTO interactions(session,id) VALUES(?,?)', [session, interaction]);
                                }
                            }
                        } else if (record?.type === 'span' && typeof record.attributes?.['gen_ai.conversation.id'] === 'string' && typeof record.spanId === 'string') {
                            const a = record.attributes;
                            const sid = a['gen_ai.conversation.id'];
                            const interaction = typeof a['github.copilot.interaction_id'] === 'string' ? a['github.copilot.interaction_id'] : '';
                            const stampMs = Array.isArray(record.startTime) && record.startTime.length === 2
                                && Number.isSafeInteger(record.startTime[0]) && Number.isSafeInteger(record.startTime[1])
                                && record.startTime[0] >= 0 && record.startTime[1] >= 0 && record.startTime[1] < 1_000_000_000
                                ? record.startTime[0] * 1000 + Math.floor(record.startTime[1] / 1_000_000) : NaN;
                            const validStamp = Number.isFinite(stampMs) && Number.isFinite(new Date(stampMs).getTime());
                            let retain = true;
                            if (this.collectionStartMs !== undefined) {
                                let authoritativeUser = false;
                                if (interaction) {
                                    const [user] = await this.all<{stamp: string}>("SELECT stamp FROM records WHERE kind='event' AND session=? AND interaction=? AND type='user.message' ORDER BY rowid LIMIT 1", [sid, interaction]);
                                    authoritativeUser = !!user && Number.isFinite(Date.parse(user.stamp))
                                        && Date.parse(user.stamp) >= this.collectionStartMs;
                                } else {
                                    // Root/tool spans have no interaction id. Only
                                    // a chat in this trace may link them to a new
                                    // user; a different turn in the same session
                                    // must not authorize historical native bodies.
                                    authoritativeUser = (await this.all(`SELECT 1 FROM records c JOIN records u
                                      ON u.session=c.session AND u.interaction=c.interaction
                                      WHERE c.kind='span' AND c.session=? AND c.trace=? AND c.interaction<>''
                                        AND u.kind='event' AND u.type='user.message' LIMIT 1`, [sid, record.traceId])).length > 0;
                                }
                                retain = validStamp && (authoritativeUser || stampMs >= this.collectionStartMs)
                                    && (!interaction || !await this.ignored(sid, interaction));
                            }
                            if (retain) {
                                const stamp = validStamp ? new Date(stampMs).toISOString() : '';
                                await this.run('INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?,?)', [kind, sid, record.spanId, interaction, typeof a['gen_ai.operation.name'] === 'string' ? a['gen_ai.operation.name'] : '', typeof record.traceId === 'string' ? record.traceId : '', stamp, raw]);
                                if (interaction) await this.run('INSERT OR IGNORE INTO interactions(session,id) VALUES(?,?)', [sid, interaction]);
                            } else if (validStamp && (!interaction || !await this.ignored(sid, interaction))) {
                                // A skewed native clock can precede its user event
                                // by several polls. Save only an exact byte locator,
                                // never the historical native message body.
                                await this.run('INSERT OR REPLACE INTO deferred_spans(session,id,interaction,trace,path,identity,offset,bytes) VALUES(?,?,?,?,?,?,?,?)',
                                    [sid, record.spanId, interaction, typeof record.traceId === 'string' ? record.traceId : '', file, identity, offset, line.length]);
                            }
                        }
                        offset = chunkStart + end + 1;
                        start = end + 1;
                    }
                    if (start < buffer.length) {
                        await this.run('INSERT OR REPLACE INTO partial_chunks VALUES(?,?,?)', [file, chunkStart + start, buffer.subarray(start)]);
                    }
                }
                await this.run('INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?,?,?)', [file, kind, identity, offset, session, active, await anchorAt(offset)]);
                if (position > offset) {
                    await this.run('INSERT OR REPLACE INTO partial_sources VALUES(?,?,?)', [file, position, await anchorAt(position)]);
                } else await this.run('DELETE FROM partial_sources WHERE path=?', [file]);
                await this.exec('COMMIT');
            } catch (err) {
                await this.exec('ROLLBACK');
                throw err;
            }
        } finally { await handle.close(); }
    }
    /** Persist the unknown-capability grace window across collector restarts. */
    async awaitingNative(session: string, interaction: string, now: number, graceMs: number): Promise<boolean> {
        await this.run('INSERT OR IGNORE INTO native_wait VALUES(?,?,?)', [session, interaction, now]);
        const [row] = await this.all<{since:number}>('SELECT since FROM native_wait WHERE session=? AND interaction=?', [session, interaction]);
        return now - row.since < graceMs;
    }
    async hasUnreadSource(): Promise<boolean> {
        const sources = await this.all('SELECT s.path,s.offset,p.position FROM sources s LEFT JOIN partial_sources p ON p.path=s.path');
        for (const source of sources) {
            try { if ((await fsp.stat(source.path)).size > (source.position ?? source.offset)) return true; }
            catch { /* Temporary source failure is handled by its ingest call. */ }
        }
        return false;
    }
    /** Restore only native records authorized by a retained user boundary. */
    async restoreDeferredSpans(): Promise<void> {
        const traces = await this.all<{session: string; trace: string}>(`SELECT session,trace FROM (SELECT d.session,d.trace,MIN(d.checked) AS checked FROM records u
          JOIN deferred_spans d ON d.session=u.session AND d.interaction=u.interaction
          WHERE u.kind='event' AND u.type='user.message' AND d.interaction<>''
          GROUP BY d.session,d.trace
          UNION SELECT d.session,d.trace,MIN(d.checked) AS checked FROM records u
          JOIN records c ON c.session=u.session AND c.interaction=u.interaction
          JOIN deferred_spans d ON d.session=c.session AND d.trace=c.trace
          WHERE u.kind='event' AND u.type='user.message' AND c.kind='span' AND c.interaction<>''
          GROUP BY d.session,d.trace) GROUP BY session,trace ORDER BY MIN(checked),session,trace LIMIT 8`);
        let readBytes = 0;
        const unavailable = new Set<string>();
        for (const trace of traces) {
            await this.exec('UPDATE sequence SET value=value+1');
            const locators = await this.all<{session: string; id: string; interaction: string; trace: string; path: string; identity: string; offset: number; bytes: number}>(
                'SELECT * FROM deferred_spans WHERE session=? AND trace=? ORDER BY checked,path,offset LIMIT 256', [trace.session, trace.trace]);
            for (const locator of locators) {
                if (readBytes && readBytes + locator.bytes > READ_BUDGET) return;
                const remove = () => this.run('DELETE FROM deferred_spans WHERE session=? AND id=?', [locator.session, locator.id]);
                if ((await this.all("SELECT 1 FROM records WHERE kind='span' AND session=? AND id=?", [locator.session, locator.id])).length) {
                    await remove(); continue;
                }
                await this.run('UPDATE deferred_spans SET checked=(SELECT value FROM sequence) WHERE session=? AND id=?', [locator.session, locator.id]);
                if (unavailable.has(locator.path)) continue;
                let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
                try {
                    handle = await fsp.open(locator.path, 'r');
                    const stat = await handle.stat();
                    if (`${stat.dev}:${stat.ino}` !== locator.identity || stat.size < locator.offset + locator.bytes) {
                        await remove(); continue;
                    }
                    const bytes = Buffer.allocUnsafe(locator.bytes);
                    let position = 0;
                    while (position < bytes.length) {
                        const part = await handle.read(bytes, position, bytes.length - position, locator.offset + position);
                        if (!part.bytesRead) break;
                        position += part.bytesRead;
                    }
                    readBytes += position;
                    if (position !== locator.bytes) continue;
                    let span: any;
                    try { span = JSON.parse(bytes.subarray(0, position).toString('utf8').trim()); }
                    catch { this.onMalformed?.(locator.path, locator.offset); await remove(); continue; }
                    // Identity also detects same-inode copy-truncate/regrowth.
                    if (span?.type !== 'span' || span.spanId !== locator.id || span.traceId !== locator.trace
                        || span.attributes?.['gen_ai.conversation.id'] !== locator.session) {
                        await remove(); continue;
                    }
                    const stampMs = Array.isArray(span.startTime) && span.startTime.length === 2
                        && Number.isSafeInteger(span.startTime[0]) && Number.isSafeInteger(span.startTime[1])
                        && span.startTime[0] >= 0 && span.startTime[1] >= 0 && span.startTime[1] < 1_000_000_000
                        ? span.startTime[0] * 1000 + Math.floor(span.startTime[1] / 1_000_000) : NaN;
                    if (!Number.isFinite(new Date(stampMs).getTime())) {
                        this.onMalformed?.(locator.path, locator.offset); await remove(); continue;
                    }
                    await this.run('INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?,?)', [
                        'span', locator.session, locator.id, locator.interaction, span.attributes['gen_ai.operation.name'] || '',
                        locator.trace, new Date(stampMs).toISOString(), JSON.stringify(span),
                    ]);
                    if (locator.interaction) await this.run('INSERT OR IGNORE INTO interactions(session,id) VALUES(?,?)', [locator.session, locator.interaction]);
                    await remove();
                } catch (err) {
                    unavailable.add(locator.path);
                    logger.warn('Copilot deferred native source unavailable; retaining locator', { file: locator.path, error: String(err) });
                } finally { await handle?.close(); }
            }
        }
    }
    async pending(): Promise<Array<{
        session: string;
        id: string;
    }>> {
        const rows = await this.all<{
            session: string;
            id: string;
        }>(`SELECT i.session,i.id FROM interactions i
      WHERE NOT EXISTS(SELECT 1 FROM delivered d WHERE d.key='copilot:'||i.session||':'||i.id)
        AND NOT EXISTS(SELECT 1 FROM ignored_interactions h WHERE h.session=i.session AND h.id=i.id)
      ORDER BY checked,rowid LIMIT 8`);
        await this.exec('UPDATE sequence SET value=value+1');
        for (const row of rows)
            await this.run('UPDATE interactions SET checked=(SELECT value FROM sequence) WHERE session=? AND id=?', [row.session, row.id]);
        return rows;
    }
    async load(session: string, interaction: string): Promise<{
        events: any[];
        spans: any[];
    }> {
        const rows = await this.all(`SELECT body FROM records WHERE kind='event' AND session=?
      AND (interaction=? OR type='session.start') ORDER BY stamp,rowid`, [session, interaction]);
        const chats = await this.all(`SELECT body FROM records WHERE kind='span' AND session=? AND interaction=?`, [session, interaction]);
        const traces = [...new Set(chats.map(r => JSON.parse(r.body).traceId).filter(Boolean))];
        const spans = [];
        for (const trace of traces)
            spans.push(...await this.all(`SELECT body FROM records WHERE kind='span' AND session=? AND trace=?`, [session, trace]));
        const events = rows.map(r => JSON.parse(r.body));
        return { events, spans: spans.map(r => JSON.parse(r.body)) };
    }
    async hasNative(session: string): Promise<boolean> {
        return (await this.all(`SELECT 1 FROM records WHERE kind='span' AND session=?
          UNION ALL SELECT 1 FROM deferred_spans d JOIN records u ON u.session=d.session AND u.interaction=d.interaction
            WHERE d.session=? AND u.kind='event' AND u.type='user.message' LIMIT 1`, [session, session])).length > 0;
    }
    async markDelivered(keys: string[]): Promise<void> {
        await this.exec('BEGIN IMMEDIATE');
        try {
            for (const key of keys)
                await this.run('INSERT OR IGNORE INTO delivered VALUES(?)', [key]);
            await this.exec('COMMIT');
        }
        catch (e) {
            await this.exec('ROLLBACK');
            throw e;
        }
    }
    async pruneDeletedSessions(files: string[]): Promise<void> {
        const sources = await this.all("SELECT path,session FROM sources WHERE kind='event'");
        const live = new Set(files);
        for (const source of sources) {
            if (live.has(source.path))
                continue;
            const sameSession = sources.some(s => s.session === source.session && live.has(s.path));
            if (!sameSession && source.session) {
                await this.exec('BEGIN IMMEDIATE');
                try {
                    await this.run('DELETE FROM records WHERE session=?', [source.session]);
                    await this.run('DELETE FROM interactions WHERE session=?', [source.session]);
                    await this.run('DELETE FROM delivered WHERE substr(key,1,?)=?', [`copilot:${source.session}:`.length, `copilot:${source.session}:`]);
                    await this.run('DELETE FROM partial_chunks WHERE path=?', [source.path]);
                    await this.run('DELETE FROM partial_sources WHERE path=?', [source.path]);
                    await this.run('DELETE FROM native_wait WHERE session=?', [source.session]);
                    await this.run('DELETE FROM ignored_interactions WHERE session=?', [source.session]);
                    await this.run('DELETE FROM deferred_spans WHERE session=?', [source.session]);
                    await this.run('DELETE FROM sources WHERE path=?', [source.path]);
                    await this.exec('COMMIT');
                }
                catch (e) {
                    await this.exec('ROLLBACK');
                    throw e;
                }
            }
        }
    }
}
