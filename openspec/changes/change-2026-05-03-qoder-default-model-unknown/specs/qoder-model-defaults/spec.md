## ADDED Requirements

### Requirement: Qoder transcript outputs include model defaults
The system SHALL emit `request.model` and `response.model` for every Qoder non-CLI transcript hook entry, defaulting both fields to `unknown` when no reliable model is available.

#### Scenario: Qoder transcript request has unknown model fields
- **WHEN** a Qoder transcript hook row emits an entry with `agent.type = qoder` and `event.name = llm.request`
- **THEN** the emitted entry contains `request.model = unknown` and `response.model = unknown`

#### Scenario: Qoder transcript response has unknown model fields
- **WHEN** a Qoder transcript hook row emits an entry with `agent.type = qoder` and `event.name = llm.response`
- **THEN** the emitted entry contains `request.model = unknown` and `response.model = unknown`

#### Scenario: Qoder transcript tool event has unknown model fields
- **WHEN** a Qoder transcript hook row emits an entry with `agent.type = qoder` and `event.name` equal to `tool.call` or `tool.result`
- **THEN** the emitted entry contains `request.model = unknown` and `response.model = unknown`

### Requirement: Qoder SQLite outputs include model defaults
The system SHALL emit `request.model` and `response.model` for every Qoder SQLite token usage entry, defaulting both fields to `unknown`.

#### Scenario: Qoder SQLite token usage has unknown model fields
- **WHEN** `QoderSqliteInput` emits an entry with `attributes.source = qoder-sqlite-chat-message`
- **THEN** the emitted entry contains `request.model = unknown` and `response.model = unknown`

### Requirement: Qoder CLI model values remain unchanged
The system SHALL emit model fields for every Qoder CLI entry and SHALL NOT overwrite real Qoder CLI model values with `unknown`.

#### Scenario: Qoder CLI transcript keeps real model
- **WHEN** a Qoder CLI transcript hook row contains a real model value
- **THEN** the emitted entry keeps the real `request.model` and `response.model` values instead of `unknown`

#### Scenario: Qoder CLI session segment keeps real model
- **WHEN** a Qoder CLI session segment row contains a real model value
- **THEN** the emitted entry keeps the real `request.model` and `response.model` values instead of `unknown`

#### Scenario: Qoder CLI transcript missing model uses unknown
- **WHEN** a Qoder CLI transcript hook row lacks a model value
- **THEN** the emitted entry contains `request.model = unknown` and `response.model = unknown`

#### Scenario: Qoder CLI session segment missing model uses unknown
- **WHEN** a Qoder CLI session segment row lacks a model value
- **THEN** the emitted entry contains `request.model = unknown` and `response.model = unknown`

### Requirement: Cursor outputs include model defaults
The system SHALL emit `request.model` and `response.model` for every Cursor hook entry, preserving real model values when available and defaulting missing values to `unknown`.

#### Scenario: Cursor hook row keeps real model
- **WHEN** a Cursor hook row contains a real model value
- **THEN** the emitted entry keeps the real `request.model` and `response.model` values instead of `unknown`

#### Scenario: Cursor hook row missing model uses unknown
- **WHEN** a Cursor hook row lacks a model value
- **THEN** the emitted entry contains `request.model = unknown` and `response.model = unknown`
