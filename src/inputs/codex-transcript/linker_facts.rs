//! Indexed canonical linker facts. Scope indexes update with the canonical map,
//! including replacements and eviction; queries never rebuild indexes lazily.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use indexmap::{IndexMap, IndexSet};
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) enum FactScope {
    Parent(String),
    Child(String),
    ParentPath(String, String),
    CreationPath(String, String),
    Invocation(String),
}
pub(super) trait FactValue: PartialEq {
    fn scopes(&self) -> Vec<FactScope>;
}

#[derive(Debug)]
pub(super) struct IndexedFacts<V> {
    values: IndexMap<String, V>,
    scopes: HashMap<FactScope, IndexSet<String>>,
    revision: u64,
    #[cfg(test)]
    access: FactAccess,
}
impl<V> Default for IndexedFacts<V> {
    fn default() -> Self {
        Self {
            values: IndexMap::new(),
            scopes: HashMap::new(),
            revision: 0,
            #[cfg(test)]
            access: FactAccess::default(),
        }
    }
}
impl<V: FactValue> IndexedFacts<V> {
    pub(super) fn insert(&mut self, key: String, value: V) -> Option<V> {
        if self.values.get(&key) == Some(&value) {
            // Preserve both insertion order and the revision for a repeated
            // native fact. The returned equal value is equivalent to the old.
            return Some(value);
        }
        if let Some(old) = self.values.get(&key) {
            let old_scopes = old.scopes();
            self.remove_scopes(&key, old_scopes);
        }
        for scope in value.scopes() {
            self.scopes.entry(scope).or_default().insert(key.clone());
        }
        self.revision = self.revision.wrapping_add(1);
        self.values.insert(key, value)
    }
    fn remove_scopes(&mut self, key: &str, scopes: Vec<FactScope>) {
        for scope in scopes {
            if let std::collections::hash_map::Entry::Occupied(mut entry) = self.scopes.entry(scope)
            {
                entry.get_mut().shift_remove(key);
                if entry.get().is_empty() {
                    entry.remove();
                }
            }
        }
    }
    pub(super) fn shift_remove_index(&mut self, index: usize) -> Option<(String, V)> {
        let (key, value) = self.values.shift_remove_index(index)?;
        self.remove_scopes(&key, value.scopes());
        self.revision = self.revision.wrapping_add(1);
        Some((key, value))
    }
    pub(super) fn get(&self, key: &str) -> Option<&V> {
        self.values.get(key)
    }
    pub(super) fn contains_key(&self, key: &str) -> bool {
        self.values.contains_key(key)
    }
    pub(super) fn len(&self) -> usize {
        self.values.len()
    }
    pub(super) fn revision(&self) -> u64 {
        self.revision
    }
    pub(super) fn values(&self) -> impl Iterator<Item = &V> {
        // Observe at the canonical iterator entrance, before any caller filter.
        // Counting matched records after a global scan would hide regressions.
        #[cfg(test)]
        {
            self.access.global_scans.fetch_add(1, Ordering::Relaxed);
            self.access
                .global_facts
                .fetch_add(self.values.len(), Ordering::Relaxed);
        }
        self.values.values()
    }
    pub(super) fn scoped_values(&self, scopes: &[FactScope]) -> Vec<&V> {
        let mut keys = IndexSet::new();
        for scope in scopes {
            if let Some(local) = self.scopes.get(scope) {
                #[cfg(test)]
                self.access
                    .scoped_facts
                    .fetch_add(local.len(), Ordering::Relaxed);
                keys.extend(local.iter().map(String::as_str));
            }
        }
        // A union of explicit child and unresolved path scopes must retain
        // canonical insertion order, rather than the order of queried scopes.
        let mut positions: Vec<_> = keys
            .into_iter()
            .filter_map(|key| self.values.get_index_of(key))
            .collect();
        positions.sort_unstable();
        positions
            .into_iter()
            .map(|index| self.values.get_index(index).expect("indexed fact").1)
            .collect()
    }
    #[cfg(test)]
    pub(super) fn reset_access(&self) {
        self.access.global_scans.store(0, Ordering::Relaxed);
        self.access.global_facts.store(0, Ordering::Relaxed);
        self.access.scoped_facts.store(0, Ordering::Relaxed);
    }
    #[cfg(test)]
    pub(super) fn access_counts(&self) -> (usize, usize, usize) {
        (
            self.access.global_scans.load(Ordering::Relaxed),
            self.access.global_facts.load(Ordering::Relaxed),
            self.access.scoped_facts.load(Ordering::Relaxed),
        )
    }
    #[cfg(test)]
    pub(super) fn indexed_key_count(&self) -> usize {
        self.scopes.values().map(IndexSet::len).sum()
    }
}
#[cfg(test)]
#[derive(Debug, Default)]
struct FactAccess {
    global_scans: AtomicUsize,
    global_facts: AtomicUsize,
    scoped_facts: AtomicUsize,
}

/// The public API continues to return owned values. This caches actual graph /
/// document construction independently from the unavoidable caller-owned copy.
#[derive(Debug)]
pub(super) struct RevisionCache<R, T> {
    value: Mutex<Option<(R, Arc<T>)>>,
    #[cfg(test)]
    builds: AtomicUsize,
}
impl<R, T> Default for RevisionCache<R, T> {
    fn default() -> Self {
        Self {
            value: Mutex::new(None),
            #[cfg(test)]
            builds: AtomicUsize::new(0),
        }
    }
}
impl<R: Copy + PartialEq, T: Clone> RevisionCache<R, T> {
    pub(super) fn get(&self, revision: R, build: impl FnOnce() -> T) -> T {
        let mut cached = self.value.lock().unwrap_or_else(|error| error.into_inner());
        if let Some((current, value)) = cached.as_ref() {
            if *current == revision {
                return value.as_ref().clone();
            }
        }
        let value = Arc::new(build());
        #[cfg(test)]
        self.builds.fetch_add(1, Ordering::Relaxed);
        let result = value.as_ref().clone();
        *cached = Some((revision, value));
        result
    }
    #[cfg(test)]
    pub(super) fn build_count(&self) -> usize {
        self.builds.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Debug, PartialEq)]
    struct Fact {
        name: &'static str,
        scopes: Vec<FactScope>,
    }
    impl FactValue for Fact {
        fn scopes(&self) -> Vec<FactScope> {
            self.scopes.clone()
        }
    }
    #[test]
    fn global_access_observer_counts_facts_before_a_filter_can_hide_the_scan() {
        let mut facts = IndexedFacts::default();
        for name in ["one", "two", "three"] {
            facts.insert(
                name.into(),
                Fact {
                    name,
                    scopes: vec![FactScope::Parent("parent".into())],
                },
            );
        }
        facts.reset_access();
        assert_eq!(facts.values().filter(|_| false).count(), 0);
        assert_eq!(facts.access_counts(), (1, 3, 0));
        facts.reset_access();
        assert_eq!(
            facts
                .scoped_values(&[FactScope::Parent("parent".into())])
                .len(),
            3
        );
        assert_eq!(facts.access_counts(), (0, 0, 3));
    }
    #[test]
    fn scoped_union_preserves_canonical_order_and_replacement_removes_old_memberships() {
        let mut facts = IndexedFacts::default();
        let parent = FactScope::Parent("parent".into());
        let child = FactScope::Child("child".into());
        facts.insert(
            "one".into(),
            Fact {
                name: "one",
                scopes: vec![parent.clone()],
            },
        );
        facts.insert(
            "two".into(),
            Fact {
                name: "two",
                scopes: vec![child.clone()],
            },
        );
        facts.insert(
            "three".into(),
            Fact {
                name: "three",
                scopes: vec![parent.clone(), child.clone()],
            },
        );
        let result = facts.scoped_values(&[child.clone(), parent.clone()]);
        assert_eq!(
            result.iter().map(|f| f.name).collect::<Vec<_>>(),
            ["one", "two", "three"]
        );
        let before = facts.revision();
        facts.insert(
            "one".into(),
            Fact {
                name: "one",
                scopes: vec![parent.clone()],
            },
        );
        assert_eq!(facts.revision(), before);
        facts.insert(
            "one".into(),
            Fact {
                name: "one",
                scopes: vec![FactScope::Child("moved".into())],
            },
        );
        assert_ne!(facts.revision(), before);
        assert_eq!(
            facts
                .scoped_values(&[parent])
                .iter()
                .map(|f| f.name)
                .collect::<Vec<_>>(),
            ["three"]
        );
        facts.shift_remove_index(0).unwrap();
        assert!(facts
            .scoped_values(&[FactScope::Child("moved".into())])
            .is_empty());
        facts.shift_remove_index(0).unwrap();
        facts.shift_remove_index(0).unwrap();
        assert_eq!(facts.indexed_key_count(), 0);
    }
}
