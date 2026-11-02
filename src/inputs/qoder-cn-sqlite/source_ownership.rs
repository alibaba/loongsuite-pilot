//! Durable exclusion boundary for the one currently selected SQLite source.
//! This head contains source ownership, never a delivered/output cursor.
use crate::checkpoints::source_ownership::{
    create_small_record, persist_small_record, read_small_record,
};
use crate::inputs::base::InputRuntime;
use crate::utils::file_identity::identity_from_open;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

const EXTENSION: &str = "qoderCnSqliteSource";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    device: u64,
    inode: u64,
    birthtime_nanos: Option<String>,
    generation: Option<u64>,
}
impl Identity {
    fn valid(&self) -> bool {
        self.inode != 0
            && (self.birthtime_nanos.is_some() || self.generation.is_some())
            && self
                .birthtime_nanos
                .as_ref()
                .is_none_or(|v| v.parse::<i128>().is_ok_and(|n| n.to_string() == *v))
    }
}
#[cfg(target_os = "linux")]
fn inode_generation(file: &std::fs::File) -> Option<u64> {
    use std::os::fd::AsRawFd;
    let mut generation: libc::c_long = 0;
    // Read-only inode generation, from the same opened source handle.
    let result = unsafe { libc::ioctl(file.as_raw_fd(), libc::FS_IOC_GETVERSION, &mut generation) };
    (result == 0).then_some(generation as u64)
}
#[cfg(not(target_os = "linux"))]
fn inode_generation(_file: &std::fs::File) -> Option<u64> {
    None
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Head {
    schema: u8,
    epoch: String,
    identity: Identity,
    floor: f64,
}
impl Head {
    fn validate(&self) -> Result<()> {
        if self.schema != 1
            || uuid::Uuid::parse_str(&self.epoch).is_err()
            || !self.identity.valid()
            || !self.floor.is_finite()
        {
            return Err(anyhow!("invalid QoderCN SQLite source boundary"));
        }
        Ok(())
    }
    fn decode(value: serde_json::Value) -> Result<Self> {
        let value: Self = serde_json::from_value(value)?;
        value.validate()?;
        Ok(value)
    }
}
#[derive(Clone)]
struct Snapshot {
    identity: Identity,
}
impl Snapshot {
    async fn capture(path: &str) -> Result<Self> {
        let path = PathBuf::from(path);
        tokio::task::spawn_blocking(move || -> Result<Self> {
            // Existing configured database links remain supported explicitly:
            // resolve their target, then capture identity from that exact file.
            // Retargeting a link changes identity and therefore the source epoch.
            let canonical = std::fs::canonicalize(&path)?;
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(
                    windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
                );
            }
            let file = options.open(canonical)?;
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if file.metadata()?.file_attributes()
                    & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                    != 0
                {
                    return Err(anyhow!("SQLite source changed to a reparse point"));
                }
            }
            let id = identity_from_open(&file)?;
            let birthtime_nanos = file.metadata()?.created().ok().map(|time| {
                match time.duration_since(std::time::UNIX_EPOCH) {
                    Ok(delta) => delta.as_nanos().to_string(),
                    Err(before) => format!("-{}", before.duration().as_nanos()),
                }
            });
            let identity = Identity {
                device: id.dev,
                inode: id.ino,
                birthtime_nanos,
                generation: inode_generation(&file),
            };
            if !identity.valid() {
                return Err(anyhow!(
                    "SQLite source lacks precise creation time and inode generation"
                ));
            }
            Ok(Self { identity })
        })
        .await?
    }
}
pub(super) struct Prepared {
    pub cursor: f64,
    pub reset: bool,
    head: Head,
}
impl Prepared {
    pub(super) async fn verify_source(&self, path: &str, recovery: &SourceRecovery) -> Result<()> {
        if Snapshot::capture(path).await?.identity != self.head.identity
            || recovery.read().await?.as_ref() != Some(&self.head)
        {
            return Err(anyhow!("QoderCN SQLite source changed while reading rows"));
        }
        Ok(())
    }
}
pub(super) struct SourceRecovery {
    directory: PathBuf,
    gate: Mutex<()>,
}
impl SourceRecovery {
    pub(super) fn new(state_path: &Path) -> Self {
        let absolute = if state_path.is_absolute() {
            state_path.to_owned()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(state_path)
        };
        let mut normalized = PathBuf::new();
        for component in absolute.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                other => normalized.push(other.as_os_str()),
            }
        }
        let key = hex::encode(Sha256::digest(normalized.as_os_str().as_encoded_bytes()));
        let parent = normalized
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        Self {
            directory: parent
                .join(".pilot-source-ownership")
                .join(key)
                .join("qoder-cn-sqlite"),
            gate: Mutex::new(()),
        }
    }
    async fn read(&self) -> Result<Option<Head>> {
        read_small_record(self.directory.join("active.json"))
            .await?
            .map(Head::decode)
            .transpose()
    }
    pub(super) async fn prepare(
        &self,
        rt: &InputRuntime,
        path: &str,
        previous: f64,
    ) -> Result<Prepared> {
        let _gate = self.gate.lock().await;
        let snapshot = Snapshot::capture(path).await?;
        let state = rt.state();
        let binding = state.get_field(EXTENSION).map(Head::decode).transpose()?;
        let existing = self.read().await?;
        let selected = if let Some(head) = existing
            .as_ref()
            .filter(|h| h.identity == snapshot.identity)
        {
            // Same source epoch: exclusion floor is immutable. In particular,
            // another input's save must never turn a fresh tail into history.
            head.clone()
        } else {
            let candidate = if existing.is_none() {
                if let Some(known) = binding.as_ref().filter(|h| h.identity == snapshot.identity) {
                    // Rebuild missing recovery metadata from a known binding,
                    // preserving its exclusion floor instead of its ACK cursor.
                    known.clone()
                } else {
                    let floor = if binding.is_none() {
                        state.last_row_id().filter(|v| v.is_finite())
                    } else {
                        None
                    };
                    Head {
                        schema: 1,
                        epoch: uuid::Uuid::new_v4().to_string(),
                        identity: snapshot.identity.clone(),
                        floor: match floor {
                            Some(legacy) => legacy,
                            None => super::qoder_cn_sqlite_input::read_max_eligible_row_id(path)
                                .await
                                .map_err(anyhow::Error::msg)?,
                        },
                    }
                }
            } else {
                // A different physical source, including an older file put
                // back, starts a fresh activation epoch. Existing rows are
                // excluded; reset-to-zero would replay copied history.
                Head {
                    schema: 1,
                    epoch: uuid::Uuid::new_v4().to_string(),
                    identity: snapshot.identity.clone(),
                    floor: super::qoder_cn_sqlite_input::read_max_eligible_row_id(path)
                        .await
                        .map_err(anyhow::Error::msg)?,
                }
            };
            candidate.validate()?;
            if Snapshot::capture(path).await?.identity != snapshot.identity {
                return Err(anyhow!(
                    "QoderCN SQLite source changed before boundary persistence"
                ));
            }
            let value = serde_json::to_value(&candidate)?;
            if existing.is_none() {
                if create_small_record(self.directory.clone(), "active.json".into(), value).await? {
                    candidate
                } else {
                    let accepted = self
                        .read()
                        .await?
                        .ok_or_else(|| anyhow!("lost QoderCN SQLite source boundary"))?;
                    if accepted.identity != snapshot.identity {
                        return Err(anyhow!("concurrent QoderCN SQLite source boundary changed"));
                    }
                    accepted
                }
            } else {
                persist_small_record(self.directory.clone(), "active.json".into(), value).await?;
                candidate
            }
        };
        if Snapshot::capture(path).await?.identity != snapshot.identity {
            return Err(anyhow!(
                "QoderCN SQLite source changed after boundary persistence"
            ));
        }
        let same_binding = binding.as_ref().is_some_and(|known| known == &selected);
        if binding
            .as_ref()
            .is_some_and(|known| known.epoch == selected.epoch && known != &selected)
        {
            return Err(anyhow!(
                "QoderCN SQLite checkpoint exclusion floor differs from durable boundary"
            ));
        }
        let cursor = if same_binding {
            state
                .last_row_id()
                .filter(|v| v.is_finite())
                .unwrap_or(selected.floor)
                .max(selected.floor)
        } else {
            selected.floor
        };
        if !same_binding || state.last_row_id() != Some(cursor) {
            rt.state_store.set(
                rt.id.as_str(),
                state
                    .with_last_row_id(cursor)
                    .with_checkpoint_extension(EXTENSION, serde_json::to_value(&selected)?),
            );
        }
        // SqliteAdapter captured previous before calling read_new_rows. If a
        // replacement lowers that threshold, return an empty binding cycle so
        // its old max initializer cannot overwrite the new source's cursor.
        Ok(Prepared {
            cursor,
            reset: previous != cursor,
            head: selected,
        })
    }
}
