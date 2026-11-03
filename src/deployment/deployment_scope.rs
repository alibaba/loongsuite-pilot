//! Recorded deployment scope. Host boot ids never enter recorded mode.

use crate::utils::ContainerIdentity;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeploymentScopeMode {
    Auto,
    Recorded,
}

impl DeploymentScopeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Recorded => "recorded",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeploymentScopeResult {
    pub scope: Option<String>,
    pub identity: Option<String>,
}

/// Recorded only when this process is inside a container and the last named
/// hook install was for this same container. A full-detect result keeps auto.
pub fn resolve_deployment_scope(
    current: &ContainerIdentity,
    result: Option<&DeploymentScopeResult>,
) -> DeploymentScopeMode {
    if current.source.as_str() != "cgroup" {
        return DeploymentScopeMode::Auto;
    }
    let Some(result) = result else {
        return DeploymentScopeMode::Auto;
    };
    if result.scope.as_deref() != Some("named") {
        return DeploymentScopeMode::Auto;
    }
    if result.identity.as_deref() != Some(current.identity.as_str()) {
        return DeploymentScopeMode::Auto;
    }
    DeploymentScopeMode::Recorded
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::ContainerIdentitySource;

    fn container(identity: &str) -> ContainerIdentity {
        ContainerIdentity {
            identity: identity.to_string(),
            source: ContainerIdentitySource::Cgroup,
        }
    }

    #[test]
    fn enters_recorded_only_for_a_named_result_in_the_same_container() {
        let container_id = "a".repeat(64);
        assert_eq!(
            resolve_deployment_scope(
                &container(&container_id),
                Some(&DeploymentScopeResult {
                    scope: Some("detected".into()),
                    identity: Some(container_id.clone()),
                })
            ),
            DeploymentScopeMode::Auto
        );
        assert_eq!(
            resolve_deployment_scope(
                &container(&container_id),
                Some(&DeploymentScopeResult {
                    scope: Some("named".into()),
                    identity: Some(container_id.clone()),
                })
            ),
            DeploymentScopeMode::Recorded
        );
        assert_eq!(
            resolve_deployment_scope(
                &container(&container_id),
                Some(&DeploymentScopeResult {
                    scope: Some("named".into()),
                    identity: Some("b".repeat(64)),
                })
            ),
            DeploymentScopeMode::Auto
        );
        assert_eq!(
            resolve_deployment_scope(
                &ContainerIdentity {
                    identity: "boot-1".into(),
                    source: ContainerIdentitySource::BootId,
                },
                Some(&DeploymentScopeResult {
                    scope: Some("named".into()),
                    identity: Some("boot-1".into()),
                })
            ),
            DeploymentScopeMode::Auto
        );
        assert_eq!(
            resolve_deployment_scope(&container(&container_id), None),
            DeploymentScopeMode::Auto
        );
    }
}

#[cfg(test)]
#[path = "deployment_scope_history_contract_tests.rs"]
mod history_contract_tests;
