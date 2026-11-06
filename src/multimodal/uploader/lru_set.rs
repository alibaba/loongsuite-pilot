//! String-key LRU map. `get` / `set` refresh recency. Iteration order is
//! least-recently-used first, matching JavaScript `Map`.

pub const MULTIMODAL_LRU_LIMIT: usize = 2048;

#[derive(Clone, Debug)]
pub struct LruMap<V> {
    capacity: usize,
    order: Vec<String>,
    values: std::collections::HashMap<String, V>,
}

impl<V> LruMap<V> {
    pub fn new(capacity: usize) -> Result<Self, String> {
        if capacity < 1 {
            return Err("LruMap capacity must be >= 1".to_string());
        }
        Ok(Self {
            capacity,
            order: Vec::new(),
            values: std::collections::HashMap::new(),
        })
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    pub fn has(&mut self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn get(&mut self, key: &str) -> Option<&V> {
        if !self.values.contains_key(key) {
            return None;
        }
        self.order.retain(|existing| existing != key);
        self.order.push(key.to_string());
        self.values.get(key)
    }

    pub fn get_copied(&mut self, key: &str) -> Option<V>
    where
        V: Clone,
    {
        self.get(key).cloned()
    }

    pub fn set(&mut self, key: impl Into<String>, value: V) {
        let key = key.into();
        if self.values.contains_key(&key) {
            self.order.retain(|existing| existing != &key);
        }
        self.order.push(key.clone());
        self.values.insert(key, value);
        while self.values.len() > self.capacity {
            let Some(oldest) = self.order.first().cloned() else {
                break;
            };
            self.order.remove(0);
            self.values.remove(&oldest);
        }
    }

    pub fn clear(&mut self) {
        self.order.clear();
        self.values.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::LruMap;

    #[test]
    fn evicts_the_least_recently_used_entry() {
        let mut lru = LruMap::new(2).unwrap();
        lru.set("a", 1);
        lru.set("b", 2);
        assert_eq!(lru.get_copied("a"), Some(1));
        lru.set("c", 3);
        assert_eq!(lru.get_copied("b"), None);
        assert_eq!(lru.get_copied("a"), Some(1));
        assert_eq!(lru.get_copied("c"), Some(3));
        assert_eq!(lru.len(), 2);
    }

    #[test]
    fn works_as_a_membership_set() {
        let mut lru = LruMap::<bool>::new(2).unwrap();
        lru.set("a", true);
        lru.set("b", true);
        assert!(lru.has("a"));
        lru.set("c", true);
        assert!(!lru.has("b"));
        assert!(lru.has("a"));
        assert!(lru.has("c"));
    }

    #[test]
    fn rejects_non_positive_capacity() {
        let err = LruMap::<bool>::new(0).unwrap_err();
        assert!(err.contains("capacity must be >= 1"));
    }

    #[test]
    fn overwrites_the_same_key_without_growing() {
        let mut lru = LruMap::new(2).unwrap();
        lru.set("a", 1);
        lru.set("a", 2);
        assert_eq!(lru.len(), 1);
        assert_eq!(lru.get_copied("a"), Some(2));
    }

    #[test]
    fn clear_removes_all_entries() {
        let mut lru = LruMap::<bool>::new(2).unwrap();
        lru.set("a", true);
        lru.set("b", true);
        lru.clear();
        assert_eq!(lru.len(), 0);
        assert!(!lru.has("a"));
    }
}
