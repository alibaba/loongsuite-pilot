## ADDED Requirements

### Requirement: Normalize shared Qoder transcript hook rows
The system SHALL consume Qoder transcript hook history rows from the existing compatibility channel and emit standard dotted `AgentActivityEntry` records.

#### Scenario: Existing history channel remains consumable
- **WHEN** a Qoder transcript row is appended to `logs/qoder-cli/history/qoder-cli-YYYY-MM-DD.jsonl`
- **THEN** the Qoder transcript hook input processes the row without requiring a history path rename

#### Scenario: Standard fields are emitted
- **WHEN** a supported Qoder transcript row is processed
- **THEN** the emitted entry uses dotted fields such as `event.name`, `session.id`, `agent.type`, `message.role`, and `attributes`

### Requirement: Infer Qoder product variant from transcript row shape
The system SHALL infer whether a supported transcript row came from Qoder CLI or Qoder IDE based on row contents rather than the hook command argument.

#### Scenario: CLI row emits qoder-cli agent type
- **WHEN** a supported transcript row includes CLI-only markers such as `entrypoint: "cli"`, `promptId`, `permissionMode`, or `userType`
- **THEN** the emitted entry has `agent.type` equal to `qoder-cli`

#### Scenario: IDE row emits qoder agent type
- **WHEN** a supported transcript row lacks CLI-only markers and matches the Qoder IDE transcript shape
- **THEN** the emitted entry has `agent.type` equal to `qoder`

### Requirement: Map user prompt rows
The system SHALL map user-authored prompt rows into `llm.request` entries.

#### Scenario: CLI user string content maps to input messages
- **WHEN** a CLI-style `user` row has `message.content` as a string
- **THEN** the emitted entry has `event.name = llm.request`, `message.role = user`, and `input.messages_delta` containing the user message

#### Scenario: IDE user string content maps to input messages
- **WHEN** an IDE-style `user` row has `message.content` as a string
- **THEN** the emitted entry has `event.name = llm.request`, `message.role = user`, and `input.messages_delta` containing the user message

### Requirement: Map assistant response rows
The system SHALL map assistant text and thinking rows into `llm.response` entries.

#### Scenario: Assistant text content maps to output messages
- **WHEN** an `assistant` row has a text content block
- **THEN** the emitted entry has `event.name = llm.response`, `message.role = assistant`, and `output.messages` containing the text block

#### Scenario: Assistant thinking content maps to output messages
- **WHEN** an `assistant` row has a thinking content block
- **THEN** the emitted entry has `event.name = llm.response`, `message.role = assistant`, and `output.messages` containing a reasoning-style block

#### Scenario: Assistant model metadata is preserved
- **WHEN** an `assistant` row contains message model or stop reason metadata
- **THEN** the emitted entry maps available model and finish reason fields to standard response fields

### Requirement: Map tool call rows
The system SHALL map assistant tool use content blocks into `tool.call` entries.

#### Scenario: CLI tool use maps to tool call
- **WHEN** a CLI-style assistant row contains a `tool_use` content block with `id`, `name`, and `input`
- **THEN** the emitted entry has `event.name = tool.call`, `tool.call.id`, `tool.name`, and `tool.arguments`

#### Scenario: IDE tool use maps to tool call
- **WHEN** an IDE-style assistant row contains a `tool_use` content block with `id`, `name`, and `input`
- **THEN** the emitted entry has `event.name = tool.call`, `tool.call.id`, `tool.name`, and `tool.arguments`

### Requirement: Map tool result rows
The system SHALL map tool result content blocks into `tool.result` entries.

#### Scenario: CLI tool result maps to tool result
- **WHEN** a CLI-style user row contains a `tool_result` content block
- **THEN** the emitted entry has `event.name = tool.result`, `message.role = tool`, `tool.call.id`, `tool.result.payload`, and `is_error` when available

#### Scenario: IDE tool result maps to tool result
- **WHEN** an IDE-style user row contains a `tool_result` content block
- **THEN** the emitted entry has `event.name = tool.result`, `message.role = tool`, `tool.call.id`, `tool.result.payload`, and `is_error` when available

### Requirement: Ignore low-value metadata rows
The system SHALL ignore transcript metadata rows that do not represent prompt, response, tool call, or tool result activity.

#### Scenario: Title and last prompt rows are ignored
- **WHEN** a transcript row has type `ai-title` or `last-prompt`
- **THEN** no `AgentActivityEntry` is emitted

#### Scenario: IDE metadata and hook progress rows are ignored
- **WHEN** a transcript row has type `session_meta` or `progress`
- **THEN** no `AgentActivityEntry` is emitted

### Requirement: Preserve source diagnostics
The system SHALL preserve useful source metadata in `attributes` for supported rows.

#### Scenario: Source metadata is attached
- **WHEN** a supported Qoder transcript row is emitted
- **THEN** the entry attributes include source channel, inferred variant, raw row type, cwd, parent identifiers when available, and transcript-specific metadata when available

### Requirement: Keep hook processor lightweight
The Qoder hook processor SHALL remain a fail-open transcript forwarder and SHALL NOT perform semantic `AgentActivityEntry` mapping.

#### Scenario: Processor forwards transcript rows
- **WHEN** the hook processor receives a Stop hook payload with a transcript path
- **THEN** it appends incremental raw transcript rows to the configured history file without requiring semantic field mapping
