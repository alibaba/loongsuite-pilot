PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
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
      CREATE TABLE IF NOT EXISTS index_migrations(name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS ignored_interactions(session TEXT, id TEXT, reason TEXT, PRIMARY KEY(session,id));
      CREATE TABLE IF NOT EXISTS deferred_spans(session TEXT,id TEXT,interaction TEXT,trace TEXT,path TEXT,identity TEXT,offset INTEGER,bytes INTEGER,checked INTEGER DEFAULT 0,
            PRIMARY KEY(session,id));
      CREATE INDEX IF NOT EXISTS deferred_span_trace ON deferred_spans(session,trace);
      CREATE INDEX IF NOT EXISTS deferred_span_interaction ON deferred_spans(session,interaction);
      CREATE INDEX IF NOT EXISTS deferred_span_path ON deferred_spans(path);
      CREATE TABLE IF NOT EXISTS sequence(value INTEGER); INSERT INTO sequence SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM sequence);