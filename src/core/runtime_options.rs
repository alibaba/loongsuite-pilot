//! Process-owned services are separate from the reusable collector runtime.
//! The HCD adapter must still supply source admission and path authorization.

use std::path::Path;
use std::sync::Arc;

use crate::flushers::BaseFlusher;

#[derive(Clone)]
pub struct CollectorRuntimeOptions {
    pub(crate) manage_host_services: bool,
    pub(crate) resource_dir: Option<String>,
    pub(crate) flusher: Option<Arc<dyn BaseFlusher>>,
}

impl Default for CollectorRuntimeOptions {
    fn default() -> Self {
        Self {
            manage_host_services: true,
            resource_dir: None,
            flusher: None,
        }
    }
}

impl CollectorRuntimeOptions {
    /// The embedding host owns deployment, updates and presentation. Its output
    /// is mandatory: never fall back to configured network/business flushers.
    pub fn embedded(
        resource_dir: impl Into<String>,
        flusher: Arc<dyn BaseFlusher>,
    ) -> anyhow::Result<Self> {
        let resource_dir = resource_dir.into();
        anyhow::ensure!(
            Path::new(&resource_dir).is_absolute(),
            "embedded runtime requires an absolute resource directory"
        );
        Ok(Self {
            manage_host_services: false,
            resource_dir: Some(resource_dir),
            flusher: Some(flusher),
        })
    }
}
