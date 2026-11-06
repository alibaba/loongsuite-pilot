//! Native Doubao Work adapter. All checkpoint branches are content-free.
mod budget;
mod content;
mod execution;
mod input;
mod log;
mod native;
mod paths;
mod reader;
mod rounds;
mod source_ownership;
mod state;
mod types;
mod util;
pub use budget::{DoubaoWorkBudgetOptions, DoubaoWorkError};
pub use input::{DoubaoWorkBody, DoubaoWorkInput, DoubaoWorkInputOptions};
pub use paths::{resolve_doubao_work_paths, resolve_doubao_work_paths_with, DoubaoWorkPaths};

#[cfg(test)]
mod golden_tests;

#[cfg(test)]
mod native_fs_tests;

// Public, deterministic evidence helpers support onboarding and fixture validation.
pub use execution::{read_native_executions, NativeExecution};
pub use log::doubao_root_agent_span_id;
pub use native::{read_native_graph, read_native_profile_graph, NativeEdge, NativeGraph};

pub use content::{NativeAssignment, NativeCallContent, NativeContent, NativeLastAnswer};
