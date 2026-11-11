//! Port of `src/inputs/qoder-trace/intercept-token-reader.ts`.

use crate::utils::{create_logger, resolve_home};
use serde_json::Value;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_AGE_MS: i64 = 2 * 60 * 60 * 1000;
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct InterceptTokenData {
    pub id: String,
    pub ts: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub reasoning_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InterceptSystemPrompt {
    pub ts: i64,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct InterceptData {
    pub tokens: Vec<InterceptTokenData>,
    pub system_prompt: Option<InterceptSystemPrompt>,
}

pub fn get_intercept_file(filename: &str) -> String {
    resolve_home(&format!("~/.loongsuite-pilot/logs/{filename}"))
}

pub async fn read_intercept_data(since_ts: Option<i64>, filename: Option<&str>) -> InterceptData {
    read_intercept_file(
        &get_intercept_file(filename.unwrap_or("qodercli-intercept.jsonl")),
        since_ts,
    )
    .await
}

/// An input-owned index, never shared across SDK instances. Reads still pass
/// through the original source capability and whole-source byte budget on every
/// call. Compare exact freshly authorized bytes against one bounded raw snapshot;
/// timestamps and tail witnesses cannot hide middle writes or truncate/regrow.
#[derive(Default)]
pub(crate) struct InterceptTokenIndex {
    cached: Option<IndexedFile>,
    #[cfg(test)]
    rebuilds: usize,
}

struct IndexedFile {
    path: String,
    content: String,
    tokens: HashMap<String, InterceptTokenData>,
    prompts: Vec<InterceptSystemPrompt>,
}

impl IndexedFile {
    fn parse(path: &str, mut content: String) -> Self {
        let mut index = Self {
            path: path.to_owned(),
            content: String::new(),
            tokens: HashMap::new(),
            prompts: Vec::new(),
        };
        index.extend_records(&content);
        // Whole-source IO may grow its temporary buffer geometrically; avoid
        // retaining unused capacity in the instance-owned raw snapshot.
        content.shrink_to_fit();
        index.content = content;
        index
    }

    // Only call with a complete whole-file snapshot, or a suffix starting at
    // a verified newline boundary in that exact snapshot.
    fn extend_records(&mut self, content: &str) {
        for record in content.split('\n').filter_map(parse_record) {
            match record {
                Record::Token(token) => {
                    // Match apply_intercept_usage exactly: latest positive usage
                    // wins by timestamp, with the last physical row breaking ties.
                    if token.id.is_empty()
                        || !(token.prompt_tokens > 0
                            || token.completion_tokens > 0
                            || token.total_tokens > 0)
                    {
                        continue;
                    }
                    if self
                        .tokens
                        .get(&token.id)
                        .is_none_or(|old| token.ts >= old.ts)
                    {
                        self.tokens.insert(token.id.clone(), token);
                    }
                }
                Record::Prompt(prompt) => self.prompts.push(prompt),
            }
        }
    }

    fn for_responses(&self, cutoff: i64, ids: &[String]) -> InterceptData {
        InterceptData {
            tokens: ids
                .iter()
                .filter_map(|id| self.tokens.get(id))
                .filter(|token| token.ts >= cutoff)
                .cloned()
                .collect(),
            // Preserve physical file order, not maximum timestamp. An earlier
            // line may still qualify after a later, older prompt expires.
            system_prompt: self
                .prompts
                .iter()
                .rev()
                .find(|prompt| prompt.ts >= cutoff)
                .cloned(),
        }
    }
}

impl InterceptTokenIndex {
    pub(crate) async fn read_for_responses(
        &mut self,
        file_path: &str,
        since_ts: Option<i64>,
        ids: &[String],
    ) -> InterceptData {
        let Some(mut content) = read_content(file_path).await else {
            self.cached = None;
            return InterceptData::default();
        };
        let cutoff = since_ts.unwrap_or_else(|| now_ms() - MAX_AGE_MS);
        // The previous reader can observe concurrent growth after its metadata
        // check. Preserve its one-call result but never retain an oversized cache.
        if content.len() as u64 > MAX_FILE_SIZE {
            self.cached = None;
            return IndexedFile::parse(file_path, content).for_responses(cutoff, ids);
        }
        // Full authorization and the whole-file budget have already run.
        // Only a strict byte-prefix append after a newline can leave every
        // previously parsed line unchanged. Incomplete or unterminated tails
        // must rebuild because a subsequent append may invalidate their JSON.
        if let Some(cached) = self.cached.as_mut().filter(|cached| {
            cached.path == file_path
                && content.len() > cached.content.len()
                && cached.content.ends_with('\n')
                && content.starts_with(&cached.content)
        }) {
            let previous_len = cached.content.len();
            cached.extend_records(&content[previous_len..]);
            content.shrink_to_fit();
            cached.content = content;
            return cached.for_responses(cutoff, ids);
        }
        if self
            .cached
            .as_ref()
            .is_none_or(|cached| cached.path != file_path || cached.content != content)
        {
            #[cfg(test)]
            {
                self.rebuilds += 1;
            }
            // No references escape this reader: release the prior map/raw bytes
            // before constructing another full index on mutation.
            self.cached = None;
            self.cached = Some(IndexedFile::parse(file_path, content));
        }
        self.cached
            .as_ref()
            .expect("index loaded")
            .for_responses(cutoff, ids)
    }
}

enum Record {
    Token(InterceptTokenData),
    Prompt(InterceptSystemPrompt),
}

fn parse_record(line: &str) -> Option<Record> {
    if line.trim().is_empty() {
        return None;
    }
    let record = serde_json::from_str::<Value>(line).ok()?;
    let ts = record
        .get("ts")
        .and_then(Value::as_i64)
        .or_else(|| record.get("ts").and_then(Value::as_f64).map(|n| n as i64))?;
    match record.get("type").and_then(Value::as_str) {
        Some("token") => Some(Record::Token(InterceptTokenData {
            id: record
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            ts,
            prompt_tokens: num(&record, "prompt_tokens"),
            completion_tokens: num(&record, "completion_tokens"),
            cached_tokens: num(&record, "cached_tokens"),
            reasoning_tokens: num(&record, "reasoning_tokens"),
            total_tokens: num(&record, "total_tokens"),
        })),
        Some("system_prompt") => Some(Record::Prompt(InterceptSystemPrompt {
            ts,
            content: record
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        })),
        _ => None,
    }
}

pub async fn read_intercept_file(file_path: &str, since_ts: Option<i64>) -> InterceptData {
    let Some(content) = read_content(file_path).await else {
        return InterceptData::default();
    };
    let cutoff = since_ts.unwrap_or_else(|| now_ms() - MAX_AGE_MS);
    let mut result = InterceptData::default();
    for record in content.split('\n').filter_map(parse_record) {
        match record {
            Record::Token(token) if token.ts >= cutoff => result.tokens.push(token),
            Record::Prompt(prompt) if prompt.ts >= cutoff => result.system_prompt = Some(prompt),
            _ => {}
        }
    }
    result
}

async fn read_content(file_path: &str) -> Option<String> {
    let logger = create_logger("InterceptTokenReader");
    match tokio::fs::metadata(file_path).await {
        Ok(meta) if meta.len() > MAX_FILE_SIZE => {
            if crate::utils::source_access::current().is_some() {
                return None;
            }
            let old = format!("{file_path}.old");
            let _ = tokio::fs::remove_file(&old).await;
            if tokio::fs::rename(file_path, old).await.is_ok() {
                logger.info("intercept file rotated (exceeded 10MB)", None);
            }
            None
        }
        Ok(_) => crate::utils::source_access::read_to_string(file_path)
            .await
            .ok(),
        Err(_) => None,
    }
}

fn num(record: &Value, key: &str) -> i64 {
    record
        .get(key)
        .and_then(Value::as_i64)
        .or_else(|| record.get(key).and_then(Value::as_f64).map(|n| n as i64))
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
#[cfg(test)]
mod index_tests {
    use super::*;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    fn path(root: &Path, name: &str) -> PathBuf {
        root.canonicalize().unwrap().join(name)
    }
    fn token(ts: i64, id: &str, count: i64) -> Value {
        serde_json::json!({"type":"token","ts":ts,"id":id,"prompt_tokens":count,
            "completion_tokens":0,"cached_tokens":2,"reasoning_tokens":3,"total_tokens":count})
    }
    fn write_rows(path: &Path, rows: &[Value]) {
        std::fs::write(
            path,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
    }
    async fn read(
        index: &mut InterceptTokenIndex,
        path: &Path,
        cutoff: Option<i64>,
        ids: &[&str],
    ) -> InterceptData {
        index
            .read_for_responses(
                path.to_str().unwrap(),
                cutoff,
                &ids.iter().map(|id| (*id).into()).collect::<Vec<_>>(),
            )
            .await
    }
    async fn legacy_for_responses(path: &Path, cutoff: Option<i64>, ids: &[&str]) -> InterceptData {
        let full = read_intercept_file(path.to_str().unwrap(), cutoff).await;
        let mut latest: HashMap<String, InterceptTokenData> = HashMap::new();
        for token in full.tokens {
            if token.id.is_empty()
                || !(token.prompt_tokens > 0
                    || token.completion_tokens > 0
                    || token.total_tokens > 0)
            {
                continue;
            }
            if latest.get(&token.id).is_none_or(|old| token.ts >= old.ts) {
                latest.insert(token.id.clone(), token);
            }
        }
        InterceptData {
            tokens: ids
                .iter()
                .filter_map(|id| latest.get(*id).cloned())
                .collect(),
            system_prompt: full.system_prompt,
        }
    }

    #[tokio::test]
    async fn cache_hits_filter_ids_expire_and_preserve_latest_positive_and_physical_prompt_order() {
        let root = tempfile::tempdir().unwrap();
        let p = path(root.path(), "intercept.jsonl");
        let now = now_ms();
        write_rows(
            &p,
            &[
                token(now - MAX_AGE_MS - 1, "expired", 1),
                token(now, "req", 10),
                token(now, "req", 20),
                token(now - 10, "req", 30),
                token(now + 50, "req", 0),
                token(now, "unrelated", 900),
                token(now, "", 500),
                serde_json::json!({"type":"system_prompt","ts":now,"content":"newer timestamp"}),
                serde_json::json!({"type":"system_prompt","ts":now-1,"content":"last physical row"}),
            ],
        );
        let mut cache = InterceptTokenIndex::default();
        let a = read(&mut cache, &p, None, &["req", "expired"]).await;
        assert_eq!(a, legacy_for_responses(&p, None, &["req", "expired"]).await);
        assert_eq!(a.tokens.len(), 1);
        assert_eq!(a.tokens[0].prompt_tokens, 20);
        assert_eq!(a.system_prompt.unwrap().content, "last physical row");
        let b = read(&mut cache, &p, Some(now), &["req"]).await;
        assert_eq!(b, legacy_for_responses(&p, Some(now), &["req"]).await);
        assert_eq!(b.system_prompt.unwrap().content, "newer timestamp");
        let c = read(&mut cache, &p, Some(now + 1), &["req"]).await;
        assert!(c.tokens.is_empty() && c.system_prompt.is_none());
        let d = read(
            &mut cache,
            &p,
            Some(now - MAX_AGE_MS - 2),
            &["expired", "unrelated"],
        )
        .await;
        assert_eq!(d.tokens.len(), 2);
        assert_eq!(
            cache.rebuilds, 1,
            "cutoff and requested-ID changes must reuse parsed content"
        );
    }

    #[tokio::test]
    async fn append_partial_final_records_and_invalidated_unterminated_tail_match_full_reader() {
        let root = tempfile::tempdir().unwrap();
        let p = path(root.path(), "intercept.jsonl");
        let now = now_ms();
        let first = token(now, "req", 10);
        let second = token(now + 1, "req", 20);
        std::fs::write(&p, first.to_string()).unwrap();
        let mut cache = InterceptTokenIndex::default();
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            10
        );
        let second_text = second.to_string();
        let half = second_text.len() / 2;
        let mut out = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        write!(out, "\n{}", &second_text[..half]).unwrap();
        out.flush().unwrap();
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await,
            legacy_for_responses(&p, Some(0), &["req"]).await
        );
        write!(out, "{}", &second_text[half..]).unwrap();
        out.flush().unwrap();
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            20
        );
        write!(out, "invalid appended without newline").unwrap();
        out.flush().unwrap();
        let a = read(&mut cache, &p, Some(0), &["req"]).await;
        assert_eq!(a, legacy_for_responses(&p, Some(0), &["req"]).await);
        assert_eq!(
            a.tokens[0].prompt_tokens, 10,
            "the formerly valid last JSON is now an invalid combined line"
        );
    }

    #[tokio::test]
    async fn same_length_middle_rewrite_truncate_regrow_rotation_and_path_switch_refresh_content() {
        let root = tempfile::tempdir().unwrap();
        let p = path(root.path(), "intercept.jsonl");
        let other = path(root.path(), "other.jsonl");
        let now = now_ms();
        let initial = [
            token(now, "head", 111),
            token(now, "req", 123),
            token(now, "tail", 222),
        ];
        write_rows(&p, &initial);
        let mut cache = InterceptTokenIndex::default();
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            123
        );
        let original_len = std::fs::metadata(&p).unwrap().len();
        let original_mtime = std::fs::metadata(&p).unwrap().modified().unwrap();
        let mut changed = initial.clone();
        changed[1] = token(now, "req", 456);
        write_rows(&p, &changed);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&p)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(original_mtime))
            .unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().len(), original_len);
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            456
        );
        std::fs::write(&p, "").unwrap();
        assert!(read(&mut cache, &p, Some(0), &["req"])
            .await
            .tokens
            .is_empty());
        write_rows(&p, &[token(now, "req", 900)]);
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            900
        );
        std::fs::rename(&p, p.with_extension("rotated")).unwrap();
        write_rows(&p, &[token(now, "req", 800)]);
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            800
        );
        write_rows(&other, &[token(now, "req", 700)]);
        assert_eq!(
            read(&mut cache, &other, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            700
        );
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            800
        );
    }

    #[tokio::test]
    async fn malformed_utf8_and_missing_sources_clear_cached_usage() {
        let root = tempfile::tempdir().unwrap();
        let p = path(root.path(), "intercept.jsonl");
        let now = now_ms();
        let mut cache = InterceptTokenIndex::default();
        write_rows(&p, &[token(now, "req", 10)]);
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens.len(),
            1
        );
        let mut raw = std::fs::read(&p).unwrap();
        raw.extend_from_slice(&[0xff, b'\n']);
        std::fs::write(&p, raw).unwrap();
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await,
            InterceptData::default()
        );
        assert!(cache.cached.is_none());
        write_rows(&p, &[token(now, "req", 20)]);
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            20
        );
        std::fs::remove_file(&p).unwrap();
        assert!(read(&mut cache, &p, Some(0), &["req"])
            .await
            .tokens
            .is_empty());
        assert!(cache.cached.is_none());
    }

    struct RestoreScope(Option<std::sync::Arc<crate::utils::source_access::SourceScope>>);
    impl Drop for RestoreScope {
        fn drop(&mut self) {
            crate::utils::source_access::install(self.0.take());
        }
    }

    #[tokio::test]
    async fn hits_recheck_scope_and_whole_file_byte_and_open_budgets() {
        use crate::utils::source_access::{self, SourceScope};
        let restore = RestoreScope(source_access::current());
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let p = path(root.path(), "intercept.jsonl");
        write_rows(&p, &[token(now_ms(), "req", 10)]);
        let size = std::fs::metadata(&p).unwrap().len() as usize;
        let mut cache = InterceptTokenIndex::default();
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens.len(),
            1
        );
        source_access::install(Some(SourceScope::new(
            vec![root.path().canonicalize().unwrap()],
            1,
            size,
        )));
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens.len(),
            1
        );
        assert_eq!(cache.rebuilds, 1);
        source_access::install(Some(SourceScope::new(
            vec![other.path().canonicalize().unwrap()],
            1,
            size,
        )));
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await,
            InterceptData::default()
        );
        assert!(cache.cached.is_none());
        source_access::install(Some(SourceScope::new(
            vec![root.path().canonicalize().unwrap()],
            1,
            size - 1,
        )));
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await,
            InterceptData::default()
        );
        source_access::install(Some(SourceScope::new(
            vec![root.path().canonicalize().unwrap()],
            0,
            size,
        )));
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await,
            InterceptData::default()
        );
        drop(restore);
    }

    #[tokio::test]
    async fn ten_megabyte_limit_keeps_existing_rotation_and_sdk_no_write_behavior() {
        use crate::utils::source_access::{self, SourceScope};
        let root = tempfile::tempdir().unwrap();
        let p = path(root.path(), "intercept.jsonl");
        let mut bytes = (token(now_ms(), "req", 10).to_string() + "\n").into_bytes();
        bytes.resize(MAX_FILE_SIZE as usize, b' ');
        std::fs::write(&p, &bytes).unwrap();
        let mut cache = InterceptTokenIndex::default();
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens.len(),
            1
        );
        assert!(cache.cached.is_some());
        bytes.push(b' ');
        std::fs::write(&p, &bytes).unwrap();
        assert!(read(&mut cache, &p, Some(0), &["req"])
            .await
            .tokens
            .is_empty());
        assert!(cache.cached.is_none());
        assert!(!p.exists());
        assert_eq!(
            std::fs::metadata(format!("{}.old", p.display()))
                .unwrap()
                .len(),
            MAX_FILE_SIZE + 1
        );
        std::fs::write(&p, &bytes).unwrap();
        let restore = RestoreScope(source_access::current());
        source_access::install(Some(SourceScope::new(
            vec![root.path().canonicalize().unwrap()],
            1,
            bytes.len(),
        )));
        assert!(read(&mut cache, &p, Some(0), &["req"])
            .await
            .tokens
            .is_empty());
        assert!(p.exists());
        drop(restore);
    }

    #[tokio::test]
    async fn separate_readers_own_separate_indexes_and_never_share_lifetime() {
        let root = tempfile::tempdir().unwrap();
        let a = path(root.path(), "a.jsonl");
        let b = path(root.path(), "b.jsonl");
        write_rows(&a, &[token(now_ms(), "req", 10)]);
        write_rows(&b, &[token(now_ms(), "req", 20)]);
        let mut first = InterceptTokenIndex::default();
        let mut second = InterceptTokenIndex::default();
        assert_eq!(
            read(&mut first, &a, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            10
        );
        assert_eq!(
            read(&mut second, &b, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            20
        );
        drop(first);
        assert_eq!(
            read(&mut second, &b, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            20
        );
        assert_eq!(second.rebuilds, 1);
    }
    #[tokio::test]
    async fn newline_append_preserves_latest_positive_ties_and_prompt_physical_order() {
        let root = tempfile::tempdir().unwrap();
        let p = path(root.path(), "intercept.jsonl");
        let now = now_ms();
        write_rows(
            &p,
            &[
                token(now, "req", 10),
                serde_json::json!({"type":"system_prompt","ts":now,"content":"first"}),
            ],
        );
        let mut cache = InterceptTokenIndex::default();
        let _ = read(&mut cache, &p, Some(0), &["req"]).await;
        let mut out = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        for row in [
            token(now, "req", 20),
            token(now - 1, "req", 99),
            token(now + 1, "req", 0),
            token(now, "second", 30),
            serde_json::json!({"type":"system_prompt","ts":now-1,"content":"last physical"}),
        ] {
            writeln!(out, "{row}").unwrap();
        }
        out.flush().unwrap();
        for cutoff in [0, now, now + 1, now - MAX_AGE_MS] {
            assert_eq!(
                read(&mut cache, &p, Some(cutoff), &["req", "second"]).await,
                legacy_for_responses(&p, Some(cutoff), &["req", "second"]).await
            );
        }
        assert_eq!(
            cache.rebuilds, 1,
            "strict newline append must preserve the existing index"
        );
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            20
        );
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"])
                .await
                .system_prompt
                .unwrap()
                .content,
            "last physical"
        );
        assert_eq!(
            read(&mut cache, &p, Some(now), &["req"])
                .await
                .system_prompt
                .unwrap()
                .content,
            "first"
        );
    }

    #[tokio::test]
    async fn append_partial_then_complete_without_newline_then_invalidate_rebuilds() {
        let root = tempfile::tempdir().unwrap();
        let p = path(root.path(), "intercept.jsonl");
        let now = now_ms();
        write_rows(&p, &[token(now, "req", 10)]);
        let mut cache = InterceptTokenIndex::default();
        let _ = read(&mut cache, &p, Some(0), &["req"]).await;
        let later = token(now + 1, "req", 20).to_string();
        let half = later.len() / 2;
        let mut out = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        write!(out, "{}", &later[..half]).unwrap();
        out.flush().unwrap();
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await,
            legacy_for_responses(&p, Some(0), &["req"]).await
        );
        assert_eq!(
            cache.rebuilds, 1,
            "initial complete newline permits parsing only the partial suffix"
        );
        write!(out, "{}", &later[half..]).unwrap();
        out.flush().unwrap();
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            20
        );
        assert_eq!(
            cache.rebuilds, 2,
            "a previously incomplete tail must be reparsed in full"
        );
        // This complete JSON has no newline, and the old contract accepts it.
        // Appending non-whitespace without a delimiter must undo that usage.
        write!(out, "corrupt").unwrap();
        out.flush().unwrap();
        let broken = read(&mut cache, &p, Some(0), &["req"]).await;
        assert_eq!(broken, legacy_for_responses(&p, Some(0), &["req"]).await);
        assert_eq!(broken.tokens[0].prompt_tokens, 10);
        assert_eq!(
            cache.rebuilds, 3,
            "valid but unterminated JSON is not a safe append boundary"
        );
        writeln!(out).unwrap();
        writeln!(out, "{}", token(now + 2, "req", 30)).unwrap();
        out.flush().unwrap();
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            30
        );
        assert_eq!(cache.rebuilds, 4, "old corrupt tail also has no newline");
        writeln!(out, "{}", token(now + 2, "req", 40)).unwrap();
        out.flush().unwrap();
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            40
        );
        assert_eq!(
            cache.rebuilds, 4,
            "newline boundary restores the append path"
        );
    }

    #[tokio::test]
    async fn longer_middle_rewrite_and_same_bytes_different_path_force_full_rebuild() {
        let root = tempfile::tempdir().unwrap();
        let p = path(root.path(), "intercept.jsonl");
        let other = path(root.path(), "other.jsonl");
        let now = now_ms();
        write_rows(&p, &[token(now, "req", 111)]);
        let mut cache = InterceptTokenIndex::default();
        let _ = read(&mut cache, &p, Some(0), &["req"]).await;
        write_rows(&p, &[token(now, "req", 222), token(now, "new", 999)]);
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req", "new"]).await,
            legacy_for_responses(&p, Some(0), &["req", "new"]).await
        );
        assert_eq!(
            cache.rebuilds, 2,
            "greater length is insufficient when the old bytes changed"
        );
        std::fs::copy(&p, &other).unwrap();
        assert_eq!(
            read(&mut cache, &other, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            222
        );
        assert_eq!(
            cache.rebuilds, 3,
            "identical bytes at a different path belong to a new source"
        );
        std::fs::write(&other, "").unwrap();
        assert!(read(&mut cache, &other, Some(0), &["req"])
            .await
            .tokens
            .is_empty());
        assert_eq!(cache.rebuilds, 4);
        write_rows(&other, &[token(now, "req", 333)]);
        assert_eq!(
            read(&mut cache, &other, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            333
        );
        assert_eq!(
            cache.rebuilds, 5,
            "empty old content has no newline append boundary"
        );
    }

    #[tokio::test]
    async fn append_checks_the_new_whole_file_budget_before_reusing_old_map() {
        use crate::utils::source_access::{self, SourceScope};
        let _restore = RestoreScope(source_access::current());
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().canonicalize().unwrap();
        let p = dir.join("intercept.jsonl");
        let now = now_ms();
        write_rows(&p, &[token(now, "req", 10)]);
        let old_size = std::fs::metadata(&p).unwrap().len() as usize;
        source_access::install(Some(SourceScope::new(vec![dir.clone()], 1, old_size)));
        let mut cache = InterceptTokenIndex::default();
        let _ = read(&mut cache, &p, Some(0), &["req"]).await;
        writeln!(
            std::fs::OpenOptions::new().append(true).open(&p).unwrap(),
            "{}",
            token(now, "req", 20)
        )
        .unwrap();
        assert_eq!(read(&mut cache, &p, Some(0), &["req"]).await, InterceptData::default(),
            "the append suffix may fit the old budget while the complete authorized source does not");
        assert!(cache.cached.is_none());
        let new_size = std::fs::metadata(&p).unwrap().len() as usize;
        source_access::install(Some(SourceScope::new(vec![dir.clone()], 1, new_size)));
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
            20
        );
        assert_eq!(
            cache.rebuilds, 2,
            "failed authorized read must clear the prior index"
        );
        source_access::install(Some(SourceScope::new(vec![dir], 0, new_size)));
        assert_eq!(
            read(&mut cache, &p, Some(0), &["req"]).await,
            InterceptData::default()
        );
        assert!(cache.cached.is_none());
    }
    #[tokio::test]
    async fn newline_append_exact_max_then_one_byte_retains_native_rotation_and_sdk_read_only() {
        use crate::utils::source_access::{self, SourceScope};
        let _restore = RestoreScope(source_access::current());
        for sdk_scoped in [false, true] {
            source_access::install(None);
            let root = tempfile::tempdir().unwrap();
            let dir = root.path().canonicalize().unwrap();
            let p = dir.join("intercept.jsonl");
            write_rows(&p, &[token(now_ms(), "req", 10)]);
            if sdk_scoped {
                source_access::install(Some(SourceScope::new(
                    vec![dir],
                    1,
                    MAX_FILE_SIZE as usize + 1,
                )));
            }
            let mut cache = InterceptTokenIndex::default();
            assert_eq!(
                read(&mut cache, &p, Some(0), &["req"]).await.tokens[0].prompt_tokens,
                10
            );
            let initial = std::fs::metadata(&p).unwrap().len() as usize;
            let remaining = MAX_FILE_SIZE as usize - initial;
            // One whitespace-only line keeps the source valid without creating
            // millions of tiny lines, and makes the new snapshot LF-terminated.
            let mut out = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
            out.write_all(&vec![b' '; remaining - 1]).unwrap();
            out.write_all(b"\n").unwrap();
            out.flush().unwrap();
            assert_eq!(std::fs::metadata(&p).unwrap().len(), MAX_FILE_SIZE);
            let exact = read(&mut cache, &p, Some(0), &["req"]).await;
            assert_eq!(exact, legacy_for_responses(&p, Some(0), &["req"]).await);
            assert_eq!(exact.tokens[0].prompt_tokens, 10);
            assert_eq!(
                cache.rebuilds, 1,
                "exact MAX newline append must use the existing index"
            );
            assert_eq!(
                cache.cached.as_ref().unwrap().content.len(),
                MAX_FILE_SIZE as usize
            );
            out.write_all(b" ").unwrap();
            out.flush().unwrap();
            drop(out);
            assert_eq!(std::fs::metadata(&p).unwrap().len(), MAX_FILE_SIZE + 1);
            assert_eq!(
                read(&mut cache, &p, Some(0), &["req"]).await,
                InterceptData::default()
            );
            assert!(
                cache.cached.is_none(),
                "over-limit sources must release any previously cached snapshot"
            );
            let rotated = PathBuf::from(format!("{}.old", p.display()));
            if sdk_scoped {
                assert_eq!(std::fs::metadata(&p).unwrap().len(), MAX_FILE_SIZE + 1);
                assert!(
                    !rotated.exists(),
                    "SDK must not rotate the Agent-owned source"
                );
            } else {
                assert!(!p.exists());
                assert_eq!(std::fs::metadata(rotated).unwrap().len(), MAX_FILE_SIZE + 1);
            }
        }
    }
}
