// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import sqlite3 from 'sqlite3';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
const EVENT_TYPES = new Set(['session.start', 'session.shutdown', 'user.message', 'system.message',
    'assistant.turn_start', 'assistant.message', 'assistant.turn_end', 'tool.execution_start',
    'tool.execution_complete', 'permission.completed', 'abort']);
const READ_BUDGET = 4 * 1024 * 1024;
/** Durable source/correlation index. It stores source records, never output batches.
 * Reading and delivery are independent transactions; only markDelivered is a
 * delivery checkpoint. SQLite keeps historical records and IDs out of JS memory.
 */
export class CopilotSourceIndex {
    private db?: sqlite3.Database;
    constructor(private readonly file: string) { }
    async open(): Promise<void> {
        if (this.db)
            return;
        await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        this.db = await new Promise<sqlite3.Database>((resolve, reject) => {
            const db = new sqlite3.Database(this.file, e => e ? reject(e) : resolve(db));
        });
        await fsp.chmod(this.file, 0o600);
        this.db.configure('busyTimeout', 5000);
        await this.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      PRAGMA cache_size=-4096; PRAGMA temp_store=FILE;
      CREATE TABLE IF NOT EXISTS sources(path TEXT PRIMARY KEY, kind TEXT, identity TEXT, offset INTEGER, session TEXT, active TEXT, anchor TEXT);
      CREATE TABLE IF NOT EXISTS records(kind TEXT, session TEXT, id TEXT, interaction TEXT, type TEXT, trace TEXT, stamp TEXT, body TEXT,
        PRIMARY KEY(kind,session,id));
      CREATE INDEX IF NOT EXISTS record_interaction ON records(session,interaction,kind);
      CREATE INDEX IF NOT EXISTS record_trace ON records(session,trace,kind);
      CREATE INDEX IF NOT EXISTS record_history ON records(session,kind,type,stamp);
      CREATE TABLE IF NOT EXISTS interactions(session TEXT, id TEXT, checked INTEGER DEFAULT 0, PRIMARY KEY(session,id));
      CREATE TABLE IF NOT EXISTS delivered(key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS sequence(value INTEGER); INSERT INTO sequence SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM sequence);`);
    }
    exec(sql: string): Promise<void> { return new Promise((resolve, reject) => this.db!.exec(sql, e => e ? reject(e) : resolve())); }
    run(sql: string, args: unknown[] = []): Promise<void> {
        return new Promise((resolve, reject) => this.db!.run(sql, args, e => e ? reject(e) : resolve()));
    }
    all<T = any>(sql: string, args: unknown[] = []): Promise<T[]> {
        return new Promise((resolve, reject) => this.db!.all(sql, args, (e, rows) => e ? reject(e) : resolve(rows as T[])));
    }
    async close(): Promise<void> {
        if (!this.db)
            return;
        const db = this.db;
        this.db = undefined;
        await new Promise<void>((resolve, reject) => db.close(e => e ? reject(e) : resolve()));
    }
    async ingest(file: string, kind: 'event' | 'span'): Promise<void> {
        const handle = await fsp.open(file, 'r');
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size === 0)
                return;
            const identity = `${stat.dev}:${stat.ino}`;
            const previous = (await this.all('SELECT * FROM sources WHERE path=?', [file]))[0];
            const anchorAt = async (end: number) => {
                const buffer = Buffer.alloc(Math.min(64, end));
                await handle.read(buffer, 0, buffer.length, end - buffer.length);
                return createHash('sha256').update(buffer).digest('hex');
            };
            const reset = !previous || previous.identity !== identity || stat.size < previous.offset
                || previous.anchor !== await anchorAt(previous.offset);
            let offset = reset ? 0 : previous.offset;
            let session = reset ? '' : previous.session;
            let active = reset ? '' : previous.active;
            if (offset === stat.size)
                return;
            const begin = offset;
            // Stop at a complete record boundary. A line may cross any number of
            // 64 KiB chunks; a partial EOF is re-read, never committed as a record.
            let position = offset;
            let fragments: Buffer[] = [];
            await this.exec('BEGIN IMMEDIATE');
            try {
                outer: while (position < stat.size) {
                    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - position));
                    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
                    if (!bytesRead)
                        break;
                    position += bytesRead;
                    const buffer = chunk.subarray(0, bytesRead);
                    let start = 0;
                    for (let end = buffer.indexOf(10, start); end >= 0; end = buffer.indexOf(10, start)) {
                        const tail = buffer.subarray(start, end + 1);
                        const line = fragments.length ? Buffer.concat([...fragments, tail]) : tail;
                        fragments = [];
                        const raw = line.toString('utf8').trim();
                        if (raw) {
                            const record = JSON.parse(raw);
                            if (kind === 'event') {
                                if (record.type === 'session.start')
                                    session = record.data?.sessionId || session;
                                if (record.data?.interactionId)
                                    active = record.data.interactionId;
                                else if (record.type === 'user.message')
                                    active = record.id;
                                if (session && EVENT_TYPES.has(record.type) && typeof record.id === 'string') {
                                    const interaction = record.type === 'session.shutdown' ? `summary:${record.id}` : active;
                                    await this.run('INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?,?)', [kind, session, record.id, interaction, record.type, '', record.timestamp || '', raw]);
                                    if (interaction)
                                        await this.run('INSERT OR IGNORE INTO interactions(session,id) VALUES(?,?)', [session, interaction]);
                                }
                            }
                            else if (record.type === 'span' && record.attributes?.['gen_ai.conversation.id'] && record.spanId) {
                                const a = record.attributes;
                                const sid = a['gen_ai.conversation.id'];
                                const interaction = a['github.copilot.interaction_id'] || '';
                                await this.run('INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?,?)', [kind, sid, record.spanId, interaction, a['gen_ai.operation.name'] || '', record.traceId || '', '', raw]);
                                if (interaction)
                                    await this.run('INSERT OR IGNORE INTO interactions(session,id) VALUES(?,?)', [sid, interaction]);
                            }
                        }
                        offset += line.length;
                        start = end + 1;
                        if (offset - begin >= READ_BUDGET)
                            break outer;
                    }
                    if (start < buffer.length)
                        fragments.push(buffer.subarray(start));
                }
                await this.run('INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?,?,?)', [file, kind, identity, offset, session, active, await anchorAt(offset)]);
                await this.exec('COMMIT');
            }
            catch (e) {
                await this.exec('ROLLBACK');
                throw e;
            }
        }
        finally {
            await handle.close();
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
    async context(session: string, last: string): Promise<any[]> {
        // Fetch history only after an interaction is ready. Irrelevant hook/native
        // history stays on disk; memory is proportional to the emitted LLM context.
        const history = await this.all(`SELECT body FROM records WHERE kind='event' AND session=? AND stamp<=?
      AND type IN ('user.message','system.message','assistant.message','tool.execution_complete') ORDER BY stamp,rowid`, [session, last]);
        return history.map(r => JSON.parse(r.body));
    }
    async hasNative(session: string): Promise<boolean> {
        return (await this.all('SELECT 1 FROM records WHERE kind=\'span\' AND session=? LIMIT 1', [session])).length > 0;
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
