//! QoderCN SQLite chat_message collector.

mod qoder_cn_sqlite_input;

pub use qoder_cn_sqlite_input::{
    resolve_qoder_cn_db_path, QoderCnSqliteInput, QoderCnSqliteOptions,
};

mod source_ownership;
