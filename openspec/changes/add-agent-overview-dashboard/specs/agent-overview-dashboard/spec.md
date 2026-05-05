## ADDED Requirements

### Requirement: Agent-grouped overview
The system SHALL present collection health grouped by user-facing top-level agent instead of internal input implementation names.

#### Scenario: Qoder family tools are separated
- **WHEN** runtime data can distinguish Qoder, Qoder CLI, and Qoder Work activity
- **THEN** the dashboard SHALL show Qoder, Qoder CLI, and Qoder Work as separate top-level agent entries

#### Scenario: Qoder Work is not merged into Qoder
- **WHEN** Qoder Work activity is collected through `qoder-work-hook` or another Qoder Work-specific source
- **THEN** the dashboard SHALL attribute that activity to Qoder Work and SHALL NOT merge it into Qoder or Qoder CLI totals

#### Scenario: Qoder SQLite token usage is attributed to Qoder
- **WHEN** token-usage data is collected from `qoder-sqlite`
- **THEN** the dashboard SHALL attribute that token usage to Qoder

#### Scenario: Qoder CLI input contains distinguishable variants
- **WHEN** records from `qoder-cli-hook` or `qoder-cli-session` contain reliable Qoder or Qoder CLI variant hints
- **THEN** the dashboard SHALL attribute each record to Qoder or Qoder CLI according to those hints

#### Scenario: Qoder CLI input cannot be reliably split
- **WHEN** records from `qoder-cli-hook` or `qoder-cli-session` cannot be reliably attributed to Qoder or Qoder CLI
- **THEN** the dashboard SHALL avoid double counting and SHALL show those records in a combined Qoder / Qoder CLI bucket or equivalent combined status

#### Scenario: Internal input names are hidden from the main view
- **WHEN** the dashboard renders its primary overview
- **THEN** internal names such as `qoder-cli-hook`, `qoder-sqlite`, and `cursor-hook` SHALL NOT appear as top-level cards or primary labels

### Requirement: Service health summary
The system SHALL show whether LoongSuite Pilot is running and provide high-level service metadata useful to a developer user.

#### Scenario: Service is running
- **WHEN** the LoongSuite Pilot PID file points to a live process
- **THEN** the dashboard SHALL show the service as running with available metadata such as version, data directory, enabled reporting channels, and last observed activity

#### Scenario: Service is not running
- **WHEN** the LoongSuite Pilot PID file is missing, stale, or points to a non-running process
- **THEN** the dashboard SHALL show the service as not running and avoid presenting stale collection status as currently active

### Requirement: Agent collection status
The system SHALL summarize collection status for each supported top-level agent.

#### Scenario: Agent is actively producing data
- **WHEN** runtime logs or local output show recent events for an agent
- **THEN** the dashboard SHALL show the agent as Active and display today's event count and last activity time

#### Scenario: Agent is supported but unavailable
- **WHEN** a supported agent has no detected runtime files, no recent output, and no active collector state
- **THEN** the dashboard SHALL show that agent as Not detected without implying an error

#### Scenario: Agent collector starts without event evidence
- **WHEN** service logs show an internal collector started but no actual events or output records exist for that top-level agent
- **THEN** the dashboard SHALL show that agent as Not detected and SHALL NOT show collector startup time as Last activity

#### Scenario: Agent has no recent data
- **WHEN** an agent is enabled or detected but has produced no events within the configured freshness window
- **THEN** the dashboard SHALL show No recent activity distinct from both Active and Not detected

#### Scenario: Qoder Work token metrics are unavailable
- **WHEN** the dashboard renders the Qoder Work token metric
- **THEN** the dashboard SHALL label it in English as "Not supported yet"

### Requirement: Reporting health summary
The system SHALL summarize reporting health without overstating upload success when exact remote success metrics are unavailable.

#### Scenario: Local JSONL backup exists
- **WHEN** normalized output JSONL files exist for the current day
- **THEN** the dashboard SHALL show local backup as normal and display today's processed event count by agent

#### Scenario: SLS reporting is configured
- **WHEN** SLS reporting is enabled in configuration
- **THEN** the dashboard SHALL show SLS as an enabled reporting channel

#### Scenario: No persisted upload failures are found
- **WHEN** `sls-failed-logs` contains no failed upload records for the relevant period
- **THEN** the dashboard SHALL state that no persisted upload failures were detected rather than claiming all remote uploads succeeded

#### Scenario: Upload failures are persisted
- **WHEN** failed upload records exist
- **THEN** the dashboard SHALL show a warning or error count and include recent failure events in the activity timeline

### Requirement: Recent activity timeline
The system SHALL provide a recent activity timeline that uses user-facing language and hides raw implementation noise by default.

#### Scenario: Collection batch is observed
- **WHEN** service logs contain a dispatch event for an internal input
- **THEN** the dashboard SHALL map it to the parent agent and show an activity such as "Cursor collected 11 events"

#### Scenario: Service lifecycle event is observed
- **WHEN** service logs show LoongSuite Pilot startup, shutdown, agent start, or agent stop
- **THEN** the dashboard SHALL include a corresponding timeline item with timestamp and severity

#### Scenario: Diagnostic details are available
- **WHEN** a user opens details for a timeline item
- **THEN** the dashboard MAY show internal method names and file paths needed for troubleshooting while keeping them out of the default summary

#### Scenario: Agent cards are rendered
- **WHEN** the dashboard renders top-level agent cards
- **THEN** the cards SHALL NOT include a collapsed diagnostics section by default

### Requirement: Low-overhead aggregation
The system SHALL keep dashboard aggregation overhead bounded and separate from collection and reporting hot paths.

#### Scenario: Dashboard summary is refreshed repeatedly
- **WHEN** the frontend refreshes the summary at a regular interval
- **THEN** the local API SHALL serve cached aggregate results within a short TTL instead of re-reading and re-parsing all runtime files for every request

#### Scenario: Dashboard page is closed
- **WHEN** no browser page or API client is requesting dashboard endpoints
- **THEN** the dashboard aggregator SHALL NOT poll or scan runtime files on its own

#### Scenario: Runtime logs grow large
- **WHEN** service logs or JSONL output files grow beyond a small size
- **THEN** the aggregator SHALL use bounded reads, current-day defaults, file metadata caching, tail reads, or incremental parsing to avoid unbounded CPU and I/O work

#### Scenario: Collector is processing events
- **WHEN** inputs are collecting entries or flushers are reporting entries
- **THEN** dashboard aggregation SHALL NOT block collection or flusher execution

### Requirement: Sensitive data minimization
The system SHALL avoid exposing raw prompt, output, tool result payload, or transcript content in the overview dashboard.

#### Scenario: Output records contain message bodies
- **WHEN** normalized JSONL output contains user prompts, assistant responses, or tool payloads
- **THEN** the dashboard SHALL use counts, timestamps, event names, agent names, and health metadata without rendering raw message content in the overview

#### Scenario: Diagnostic view is opened
- **WHEN** diagnostic details include paths or internal method metadata
- **THEN** the dashboard SHALL keep message content hidden unless a future explicit diagnostic feature requires and protects it

### Requirement: Process metrics retention
The system SHALL keep process-resource metrics bounded on disk and bounded in dashboard queries.

#### Scenario: Metrics are sampled continuously
- **WHEN** the process monitor records CPU, memory, network, file, or thread samples
- **THEN** it SHALL rotate metrics into hourly CSV files instead of appending indefinitely to one daily CSV

#### Scenario: Metrics exceed retention window
- **WHEN** hourly process metrics files are older than the configured retention window
- **THEN** the monitor SHALL delete them during periodic cleanup

#### Scenario: Dashboard requests process metrics
- **WHEN** the dashboard requests process metrics without specifying a window
- **THEN** the API SHALL return only the default recent window of samples and SHALL keep the CSV column format compatible with existing chart parsing

#### Scenario: Optional monitor is stopped
- **WHEN** the user stops monitor independently of LoongSuite Pilot
- **THEN** LoongSuite Pilot collection and reporting SHALL continue without process metrics sampling or dashboard serving

#### Scenario: Monitor is explicitly started
- **WHEN** the user runs `loongsuite-pilot monitor-start`
- **THEN** the system SHALL start both the process sampler and the local dashboard server and print the dashboard URL

#### Scenario: Core service starts
- **WHEN** the user runs `loongsuite-pilot start`
- **THEN** the system SHALL NOT start monitor unless the user explicitly requests monitor

#### Scenario: Auto-update runs while monitor is stopped
- **WHEN** auto-update installs a new version and monitor is not running
- **THEN** the system SHALL NOT start monitor during the update

#### Scenario: Auto-update runs while monitor is running
- **WHEN** auto-update installs a new version and monitor is already running
- **THEN** the system SHALL restart monitor so the sampler and dashboard use the updated version

### Requirement: Process metrics chart readability
The system SHALL make process-resource charts readable enough to identify current values and historical peaks.

#### Scenario: Resource chart is rendered
- **WHEN** CPU, memory, network, files, or threads history is displayed
- **THEN** the chart SHALL show Y-axis labels or equivalent numeric scale information

#### Scenario: Resource usage has a peak
- **WHEN** a resource series contains multiple samples
- **THEN** the chart SHALL show both the latest value and the peak value for the displayed time window

#### Scenario: Resource chart is inspected
- **WHEN** the user hovers over a process-resource chart sample
- **THEN** the chart SHALL show the sample time and values for the nearest displayed sample

#### Scenario: Network chart is rendered
- **WHEN** the dashboard renders the Network Connections chart
- **THEN** the dashboard SHALL explain that INET means all network connections, EST means established TCP connections, and LISTEN means listening TCP sockets
