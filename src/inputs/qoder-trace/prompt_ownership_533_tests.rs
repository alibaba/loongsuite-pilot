use super::*;
use rusqlite::Connection;
use std::collections::HashSet;
use std::sync::Mutex;
fn fixture(path: &Path, rows: &[(&str, Value)], session: &str) {
    let db = Connection::open(path).unwrap();
    db.execute_batch(
        "CREATE TABLE chat_message(session_id TEXT,request_id TEXT,role TEXT,gmt_create NUMERIC)",
    )
    .unwrap();
    for (request, at) in rows {
        let at = match at {
            Value::String(s) => rusqlite::types::Value::Text(s.clone()),
            Value::Number(n) => rusqlite::types::Value::Real(n.as_f64().unwrap()),
            _ => panic!("fixture timestamp"),
        };
        db.execute(
            "INSERT INTO chat_message VALUES (?1,?2,'user',?3)",
            rusqlite::params![session, request, at],
        )
        .unwrap();
    }
}
fn paths(root: &Path) -> Vec<String> {
    (0..9)
        .map(|i| {
            root.join(format!("cache-{i}.db"))
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}
async fn read(
    r: &NativeQoderPromptOwnershipResolver,
    agent: &str,
    request: &str,
    cursor: Option<&QoderOwnershipCursor>,
    search: &mut QoderOwnershipSearch,
) -> Option<QoderPromptOwnership> {
    r.resolve(agent, "native-session", request, cursor, search)
        .await
}
fn take_queries(r: &NativeQoderPromptOwnershipResolver) -> Vec<(String, String, Vec<Value>)> {
    std::mem::take(&mut *r.queries.lock().unwrap())
}
#[tokio::test]
async fn source_l23_complete_inventory_is_exact_request_anchored_and_metadata_only() {
    for agent in ["qoder", "qoder-cn"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("synthetic.db");
        fixture(
            &path,
            &[("second", json!(200)), ("first", json!("100"))],
            "native-session",
        );
        let resolver = NativeQoderPromptOwnershipResolver::with_paths(vec![path
            .to_string_lossy()
            .into_owned()]);
        let proof = read(&resolver, agent, "second", None, &mut Default::default())
            .await
            .unwrap();
        assert_eq!(
            proof.rows,
            vec![
                QoderOwnershipRow {
                    request_id: "first".into(),
                    at: 100.0
                },
                QoderOwnershipRow {
                    request_id: "second".into(),
                    at: 200.0
                }
            ]
        );
        assert!(proof.complete);
        assert_eq!(proof.inventory_id.len(), 64);
        assert!(proof.reset.is_none());
        let encoded = serde_json::to_value(&proof).unwrap();
        assert_eq!(
            encoded
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<HashSet<_>>(),
            HashSet::from(["inventoryId".into(), "rows".into(), "complete".into()])
        );
        let queries = take_queries(&resolver);
        assert_eq!(queries[0].2, vec![json!("native-session"), json!("second")]);
        for (_, sql, _) in queries {
            let sql = sql.to_ascii_lowercase();
            assert!(
                !sql.contains("select *")
                    && !sql.contains("content")
                    && !sql.contains("question")
                    && !sql.contains("answer")
            );
        }
        assert_eq!(number(&json!("100")), Some(100.0));
    }
}
#[tokio::test]
async fn source_l30_tied_duplicate_and_corrupt_metadata_never_establish_ownership() {
    for agent in ["qoder", "qoder-cn"] {
        for rows in [
            vec![("owned", json!(100)), ("other", json!(100))],
            vec![("owned", json!(100)), ("owned", json!(200))],
            vec![("owned", json!("invalid"))],
        ] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("synthetic.db");
            fixture(&path, &rows, "native-session");
            let resolver = NativeQoderPromptOwnershipResolver::with_paths(vec![path
                .to_string_lossy()
                .into_owned()]);
            assert!(
                read(&resolver, agent, "owned", None, &mut Default::default())
                    .await
                    .is_none()
            );
        }
    }
}
#[tokio::test]
async fn source_l38_streams_1025_turns_in_keyset_pages_without_duplicates() {
    for agent in ["qoder", "qoder-cn"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("synthetic.db");
        let names = (0..1025).map(|i| format!("owned-{i}")).collect::<Vec<_>>();
        let rows = names
            .iter()
            .enumerate()
            .map(|(i, id)| (id.as_str(), json!(i + 1)))
            .collect::<Vec<_>>();
        fixture(&path, &rows, "native-session");
        let resolver = NativeQoderPromptOwnershipResolver::with_paths(vec![path
            .to_string_lossy()
            .into_owned()]);
        let mut cursor = None;
        let mut delivered = Vec::new();
        for _ in 0..6 {
            let page = read(
                &resolver,
                agent,
                "owned-1024",
                cursor.as_ref(),
                &mut Default::default(),
            )
            .await
            .unwrap();
            assert!(page.rows.len() <= 256);
            delivered.extend(page.rows.clone());
            if page.complete {
                break;
            }
            let last = page.rows.last().unwrap();
            cursor = Some(QoderOwnershipCursor {
                at: last.at,
                request_id: last.request_id.clone(),
                inventory_id: page.inventory_id,
            });
        }
        assert_eq!(delivered.len(), 1025);
        assert_eq!(
            delivered
                .iter()
                .map(|r| &r.request_id)
                .collect::<HashSet<_>>()
                .len(),
            1025
        );
        assert!(take_queries(&resolver)
            .iter()
            .filter(|(_, sql, _)| sql.contains("ORDER BY"))
            .all(|(_, sql, _)| sql.contains("LIMIT 257")));
    }
}
#[tokio::test]
async fn source_l51_inventory_or_anchor_change_returns_reset_without_rows() {
    for agent in ["qoder", "qoder-cn"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("synthetic.db");
        fixture(&path, &[("owned", json!(100))], "native-session");
        let resolver = NativeQoderPromptOwnershipResolver::with_paths(vec![path
            .to_string_lossy()
            .into_owned()]);
        let wrong = QoderOwnershipCursor {
            at: 99.0,
            request_id: "owned".into(),
            inventory_id: "old-file".into(),
        };
        let reset = read(
            &resolver,
            agent,
            "owned",
            Some(&wrong),
            &mut Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(reset.reset, Some(true));
        assert!(reset.rows.is_empty() && !reset.complete);
        let mut cursor = wrong;
        cursor.inventory_id = reset.inventory_id;
        cursor.at = 100.0;
        let db = Connection::open(&path).unwrap();
        db.execute("UPDATE chat_message SET gmt_create=101", [])
            .unwrap();
        drop(db);
        let reset = read(
            &resolver,
            agent,
            "owned",
            Some(&cursor),
            &mut Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(reset.reset, Some(true));
        assert!(reset.rows.is_empty());
    }
}
#[tokio::test]
async fn source_l55_real_temporary_exclusive_lock_retries_without_false_baseline() {
    for agent in ["qoder", "qoder-cn"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("synthetic.db");
        fixture(&path, &[("owned", json!(100))], "native-session");
        let resolver = NativeQoderPromptOwnershipResolver::with_paths(vec![path
            .to_string_lossy()
            .into_owned()]);
        let db = Connection::open(&path).unwrap();
        db.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let mut search = QoderOwnershipSearch::default();
        assert!(tokio::time::timeout(
            std::time::Duration::from_secs(2),
            read(&resolver, agent, "owned", None, &mut search)
        )
        .await
        .unwrap()
        .is_none());
        db.execute_batch("COMMIT").unwrap();
        drop(db);
        let proof = read(&resolver, agent, "owned", None, &mut search)
            .await
            .unwrap();
        assert_eq!(
            proof.rows,
            vec![QoderOwnershipRow {
                request_id: "owned".into(),
                at: 100.0
            }]
        );
        assert!(proof.complete);
    }
}
#[tokio::test]
async fn source_l61_search_rotation_persists_and_prefers_verified_ninth_database() {
    for agent in ["qoder", "qoder-cn"] {
        let root = tempfile::tempdir().unwrap();
        let paths = paths(root.path());
        for (i, path) in paths.iter().enumerate() {
            fixture(
                Path::new(path),
                &[("owned", json!(100))],
                if i == 8 {
                    "native-session"
                } else {
                    "other-session"
                },
            );
        }
        let resolver = NativeQoderPromptOwnershipResolver::with_paths(paths.clone());
        let mut search = QoderOwnershipSearch::default();
        for _ in 0..2 {
            assert!(read(&resolver, agent, "owned", None, &mut search)
                .await
                .is_none());
            assert_eq!(take_queries(&resolver).len(), 4);
            search = serde_json::from_value(serde_json::to_value(&search).unwrap()).unwrap();
        }
        let proof = read(&resolver, agent, "owned", None, &mut search)
            .await
            .unwrap();
        assert_eq!(proof.rows[0].request_id, "owned");
        assert!(take_queries(&resolver)
            .iter()
            .all(|(path, _, _)| path == &paths[8]));
        assert!(serde_json::to_string(&search).unwrap().len() < 1024);
        assert!(read(&resolver, agent, "owned", None, &mut search)
            .await
            .is_some());
        assert!(take_queries(&resolver)
            .iter()
            .all(|(path, _, _)| path == &paths[8]));
    }
}
#[tokio::test]
async fn source_l82_removed_preferred_path_is_never_queried_and_order_reversal_cannot_starve() {
    for agent in ["qoder", "qoder-cn"] {
        let root = tempfile::tempdir().unwrap();
        let paths = paths(root.path());
        for (i, path) in paths.iter().enumerate() {
            fixture(
                Path::new(path),
                &[("owned", json!(100))],
                if i == 8 {
                    "native-session"
                } else {
                    "other-session"
                },
            );
        }
        let removed = root.path().join("removed.db");
        fixture(&removed, &[("owned", json!(100))], "native-session");
        let dynamic = Arc::new(Mutex::new(paths));
        let resolver = NativeQoderPromptOwnershipResolver::with_discovery({
            let dynamic = Arc::clone(&dynamic);
            Arc::new(move |_| dynamic.lock().unwrap().clone())
        });
        let mut search = QoderOwnershipSearch {
            preferred_path: Some(removed.to_string_lossy().into_owned()),
            next_index: Some(4),
        };
        let mut found = false;
        for _ in 0..3 {
            dynamic.lock().unwrap().reverse();
            let proof = read(&resolver, agent, "owned", None, &mut search).await;
            let queried = take_queries(&resolver)
                .into_iter()
                .map(|(p, _, _)| p)
                .collect::<HashSet<_>>();
            assert!(!queried.contains(&removed.to_string_lossy().into_owned()));
            assert!(queried.len() <= 4);
            if let Some(proof) = proof {
                assert_eq!(proof.rows[0].request_id, "owned");
                found = true;
                break;
            }
        }
        assert!(
            found,
            "last authorized candidate must eventually be queried"
        );
    }
}
#[tokio::test]
async fn source_l97_preferred_database_physical_generation_is_revalidated() {
    for agent in ["qoder", "qoder-cn"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("synthetic.db");
        fixture(&path, &[("owned", json!(100))], "native-session");
        let resolver = NativeQoderPromptOwnershipResolver::with_paths(vec![path
            .to_string_lossy()
            .into_owned()]);
        let mut search = QoderOwnershipSearch::default();
        let first = read(&resolver, agent, "owned", None, &mut search)
            .await
            .unwrap();
        std::fs::rename(&path, path.with_extension("old")).unwrap();
        fixture(&path, &[("owned", json!(100))], "native-session");
        let cursor = QoderOwnershipCursor {
            at: 100.0,
            request_id: "owned".into(),
            inventory_id: first.inventory_id.clone(),
        };
        let page = read(&resolver, agent, "owned", Some(&cursor), &mut search)
            .await
            .unwrap();
        assert_eq!(page.reset, Some(true));
        assert_ne!(page.inventory_id, first.inventory_id);
    }
}
