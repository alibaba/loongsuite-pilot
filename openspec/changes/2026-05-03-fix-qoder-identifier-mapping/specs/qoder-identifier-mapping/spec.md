## ADDED Requirements

### Requirement: Qoder CLI segment source identifiers
The system SHALL keep Qoder CLI session segment source identifiers out of standard request and response id fields unless their standard semantics are known.

#### Scenario: Segment request id remains diagnostic metadata
- **WHEN** a Qoder CLI session segment `model.response.completed` row contains `request_id`
- **THEN** the emitted `AgentActivityEntry` preserves that value in attributes

#### Scenario: Segment request id is not request id
- **WHEN** a Qoder CLI session segment `model.response.completed` row contains `request_id`
- **THEN** the emitted `AgentActivityEntry` does not contain `request.id`

#### Scenario: Segment request id is not response id
- **WHEN** a Qoder CLI session segment `model.response.completed` row contains `request_id`
- **THEN** the emitted `AgentActivityEntry` does not contain `response.id`

### Requirement: Qoder CLI segment omits unsupported turn and step identifiers
The system SHALL omit standard turn and step identifiers for Qoder CLI session segment rows when the raw fields are not canonical standard identifiers.

#### Scenario: Segment turn id is omitted
- **WHEN** a Qoder CLI session segment `model.response.completed` row contains raw `turn_id`
- **THEN** the emitted `AgentActivityEntry` does not contain `turn.id`

#### Scenario: Segment loop id is omitted
- **WHEN** a Qoder CLI session segment `model.response.completed` row contains raw `loop_id`
- **THEN** the emitted `AgentActivityEntry` does not contain `step.id`

### Requirement: Qoder transcript response identifiers
The system SHALL promote Qoder transcript assistant message identifiers to response identifiers when they represent assistant model output.

#### Scenario: Assistant message id becomes response id
- **WHEN** a Qoder transcript hook assistant response row contains `message.id`
- **THEN** the emitted `AgentActivityEntry` contains `response.id` equal to `message.id`

#### Scenario: Assistant message id remains diagnostic metadata
- **WHEN** a Qoder transcript hook assistant response row contains `message.id`
- **THEN** the emitted entry may also preserve the raw message id in attributes for diagnostics

### Requirement: Qoder transcript request identifiers are conservative
The system SHALL omit `request.id` for Qoder transcript rows unless a canonical request identifier is available.

#### Scenario: Qoder IDE request id is omitted
- **WHEN** a Qoder IDE transcript row is emitted with `agent.type = qoder`
- **THEN** the emitted `AgentActivityEntry` does not contain `request.id`

#### Scenario: CLI transcript request id is not synthesized
- **WHEN** a Qoder CLI transcript row lacks a canonical request identifier
- **THEN** the emitted `AgentActivityEntry` does not synthesize `request.id` from prompt, parent, message, or response identifiers

### Requirement: Qoder SQLite request identifiers are diagnostic
The system SHALL keep Qoder SQLite `chat_message.request_id` out of standard request id fields unless its standard semantics are known.

#### Scenario: SQLite request id remains diagnostic metadata
- **WHEN** a Qoder SQLite token usage row contains `request_id`
- **THEN** the emitted `AgentActivityEntry` preserves that value in attributes

#### Scenario: SQLite request id is not request id
- **WHEN** a Qoder SQLite token usage row contains `request_id`
- **THEN** the emitted `AgentActivityEntry` does not contain `request.id`
