//! PI SDK agent identity, registry, and CLI.
//!
//! Wire with `#[path = "pi-sdk/mod.rs"] pub mod pi_sdk;`.

mod pi_sdk_agent_cli;
mod pi_sdk_agent_identity;
mod pi_sdk_agent_registry;

pub use pi_sdk_agent_cli::{handle_pi_sdk_agent_cli, handle_pi_sdk_agent_cli_with, PiSdkCliIo};
pub use pi_sdk_agent_identity::{
    is_reserved_pi_sdk_agent_id, is_valid_pi_sdk_agent_id, validate_pi_sdk_agent_id,
};
pub use pi_sdk_agent_registry::{
    build_pi_sdk_agent_definition, command_matches_registry, doctor_pi_sdk_agent,
    ensure_registered_pi_sdk_wrappers, is_pi_sdk_agent_definition, is_pi_sdk_registry_busy_error,
    list_registered_pi_sdk_agents, pi_sdk_registry_process_patterns, register_pi_sdk_agent,
    render_pi_sdk_wrapper, unregister_pi_sdk_agent, PiSdkAgentDoctorResult,
    PiSdkAgentRegistrationRequest, PiSdkAgentRegistrationResult, PiSdkRegistryBusyError,
    UnregisterResult, PI_SDK_REGISTRY_LOCK_FILE,
};
