//! Measure serialized payload budgets without allocating a second JSON document.
use serde::Serialize;
use std::io::{self, Write};

#[derive(Default)]
struct Counter(usize);

impl Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("JSON size overflow"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn serialized_json_size<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<usize> {
    let mut counter = Counter::default();
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn budgets_match_wire_bytes_for_escaped_unicode_and_large_contexts() {
        for value in [
            json!(null),
            json!([true, false, 0, -1, 0.5, 1e-20]),
            json!({"研发🚀":"引号\"、反斜杠\\、换行\n、制表符\t", "nested":[{},[]]}),
            json!([{"content":"x".repeat(1024 * 1024)}]),
        ] {
            assert_eq!(
                serialized_json_size(&value).unwrap(),
                serde_json::to_vec(&value).unwrap().len()
            );
        }
        let source = json!({"key":"a"});
        let contexts = vec![source.clone(), json!({"turn":2})];
        assert_eq!(
            serialized_json_size(&(&source, &contexts)).unwrap(),
            serde_json::to_vec(&json!([source, contexts]))
                .unwrap()
                .len()
        );
        let payload = vec![json!({"content":"x".repeat(1024 * 1024 - 16)})];
        assert_eq!(serialized_json_size(&payload).unwrap(), 1024 * 1024);
    }
}

// Append this module to src/utils/json_size.rs.
#[cfg(test)]
mod cpu_optimization_json_size_boundary_tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn counter_matches_legacy_bytes_for_scalars_slices_and_qoder_reference_tuple() {
        let mut cases = vec![
            json!([u64::MAX, i64::MIN, i64::MAX]),
            json!([
                -0.0,
                0.0,
                1e-300,
                -1e-300,
                1e300,
                f64::MAX,
                f64::MIN_POSITIVE
            ]),
            json!([[], {}, null, true, false]),
            json!({"\u{10000}":"\0\u{1}\u{8}\u{b}\u{c}\u{1f}\t\n\r\"\\/研发🚀", "é":"e\u{301}"}),
        ];
        let mut nested = json!("leaf");
        for _ in 0..64 {
            nested = json!({"level":[nested]});
        }
        cases.push(nested);
        for value in &cases {
            assert_eq!(
                serialized_json_size(value).unwrap(),
                serde_json::to_vec(value).unwrap().len()
            );
        }
        assert_eq!(
            serialized_json_size(cases.as_slice()).unwrap(),
            serde_json::to_vec(&Value::Array(cases.clone()))
                .unwrap()
                .len()
        );
        let source = json!({"key":"session", "name":"研发🚀", "version":u64::MAX});
        let contexts = cases;
        let legacy = serde_json::to_vec(&json!([source, contexts]))
            .unwrap()
            .len();
        assert_eq!(serialized_json_size(&(&source, &contexts)).unwrap(), legacy);
        const BUDGET: usize = 1024 * 1024;
        for target in [BUDGET - 1, BUDGET, BUDGET + 1] {
            let messages = vec![Value::String("x".repeat(target - 4))];
            let legacy = serde_json::to_vec(&Value::Array(messages.clone()))
                .unwrap()
                .len();
            assert_eq!(legacy, target);
            assert_eq!(serialized_json_size(&messages).unwrap(), legacy);
            assert_eq!(serialized_json_size(messages.as_slice()).unwrap(), legacy);
        }
    }
}
