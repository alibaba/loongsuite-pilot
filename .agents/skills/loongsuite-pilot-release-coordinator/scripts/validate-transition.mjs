#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STAGES = [
  "EXTERNAL_0",
  "EXTERNAL_5",
  "EXTERNAL_15",
  "EXTERNAL_40",
  "EXTERNAL_60",
  "PROMOTE",
];

const NEXT_STAGE = new Map([
  ["EXTERNAL_0", "EXTERNAL_5"],
  ["EXTERNAL_5", "EXTERNAL_15"],
  ["EXTERNAL_15", "EXTERNAL_40"],
  ["EXTERNAL_40", "EXTERNAL_60"],
  ["EXTERNAL_60", "PROMOTE"],
]);

const CHANGE_DECISIONS = new Set([
  "RELEASE",
  "NO_RELEASE",
  "NEED_HUMAN_REVIEW",
]);
const OBSERVATION_RECOMMENDATIONS = new Set([
  "CONTINUE_REVIEW_READY",
  "PAUSE_RECOMMENDED",
  "KEEP_OBSERVING",
]);
const EXECUTION_MODES = new Set(["PLAN", "EXECUTE"]);
const EXECUTION_OUTCOMES = new Set([
  "PLAN_READY",
  "SUCCEEDED",
  "FAILED",
  "NOT_EXECUTED",
]);
const REPORT_EVENT_TYPES = new Set([
  "CHANGE_REPORT",
  "EXECUTION_REPORT",
  "OBSERVATION_REPORT",
  "RELEASE_NOTE_REPORT",
]);
const RISK_LEVELS = new Set(["LOW", "MEDIUM", "HIGH", "UNKNOWN"]);
const PAUSABLE_PHASES = new Set([
  "AWAIT_HUMAN_ROLLOUT_DECISION",
  "AWAIT_HUMAN_PLAN_FAILURE_DECISION",
  "AWAIT_HUMAN_EXECUTION_FAILURE_DECISION",
  "AWAIT_HUMAN_GITHUB_FAILURE_DECISION",
]);

function result(snapshot, overrides) {
  const output = {
    validation_mode: snapshot.validation_mode === true,
    current_phase: snapshot.phase ?? "",
    current_stage: snapshot.stage ?? "",
    event_type: snapshot.event?.type ?? "",
    allowed_action: "INVALID",
    next_phase: snapshot.phase ?? "",
    requires_human: false,
    reason: "",
    ...overrides,
  };
  if (output.allowed_action.startsWith("NOTIFY_")) {
    const event = snapshot.event ?? {};
    const eventId = event.child_id ?? event.comment_id ?? event.type ?? "unknown";
    output.idempotency_key = [
      snapshot.workflow_version ?? "unknown",
      snapshot.phase ?? "unknown",
      event.type ?? "unknown",
      eventId,
      output.allowed_action,
    ].join(":");
    if ((snapshot.notification_keys ?? []).includes(output.idempotency_key)) {
      output.allowed_action = "WAIT";
      output.next_phase = snapshot.phase ?? "";
      output.requires_human = false;
      output.reason = "notification was already sent for this event";
    }
  }
  return output;
}

function invalid(snapshot, reason) {
  return result(snapshot, { allowed_action: "INVALID", reason });
}

function requireFields(value, fields) {
  return fields.filter((field) => {
    const item = value?.[field];
    return item === undefined || item === null || item === "";
  });
}

function missingProperties(value, fields) {
  return fields.filter(
    (field) => !value || !Object.prototype.hasOwnProperty.call(value, field),
  );
}

function isDuplicate(snapshot) {
  const event = snapshot.event ?? {};
  const consumed = new Set(snapshot.consumed_event_ids ?? []);
  if (event.child_id && consumed.has(event.child_id)) {
    return "child report was already consumed";
  }
  if (event.comment_id && consumed.has(event.comment_id)) {
    return "approval comment was already consumed";
  }
  if (
    event.child_id &&
    snapshot.last_consumed_child_id &&
    event.child_id === snapshot.last_consumed_child_id
  ) {
    return "child report was already consumed";
  }
  if (
    event.comment_id &&
    snapshot.last_approval_comment_id &&
    event.comment_id === snapshot.last_approval_comment_id
  ) {
    return "approval comment was already consumed";
  }
  return "";
}

function validateApproval(snapshot, expectedAction, options = {}) {
  if (!snapshot.event?.comment_id) {
    return "approval comment_id is required for idempotency";
  }
  const approval = snapshot.event?.approval;
  const missing = requireFields(approval, [
    "actor_type",
    "target",
    "target_version",
    "action",
    "evidence_id",
  ]);
  if (missing.length > 0) {
    return `approval missing fields: ${missing.join(", ")}`;
  }
  if (approval.actor_type !== "member") {
    return "only a human member comment can approve an action";
  }
  if (approval.target !== "external") {
    return "approval target must be external";
  }
  if (approval.target_version !== snapshot.target_version) {
    return "approval target_version does not match current workflow version";
  }
  if (approval.action !== expectedAction) {
    return `approval action must be ${expectedAction}`;
  }
  if (!snapshot.latest_evidence_id) {
    return "workflow latest_evidence_id is required before approval";
  }
  if (approval.evidence_id !== snapshot.latest_evidence_id) {
    return "approval is not bound to the latest plan or observation evidence";
  }
  if (
    options.requireBump &&
    !new Set(["patch", "minor", "major"]).has(approval.bump)
  ) {
    return "approval bump must be patch, minor, or major";
  }
  return "";
}

function validateChangeReport(report) {
  const missingKeys = missingProperties(report, [
    "report_type",
    "decision",
    "recommended_bump",
    "previous_version",
    "suggested_version",
    "features",
    "bugfixes",
    "risks",
    "blockers",
    "no_release_reason",
    "evidence_url",
    "notification_copy",
  ]);
  if (missingKeys.length > 0) {
    return `change report missing properties: ${missingKeys.join(", ")}`;
  }
  const missing = requireFields(report, [
    "report_type",
    "decision",
    "previous_version",
    "evidence_url",
    "notification_copy",
  ]);
  if (missing.length > 0) {
    return `change report missing fields: ${missing.join(", ")}`;
  }
  if (report.report_type !== "change-report") {
    return "report_type must be change-report";
  }
  if (!CHANGE_DECISIONS.has(report.decision)) {
    return "invalid change decision";
  }
  if (report.decision === "RELEASE") {
    const releaseMissing = requireFields(report, [
      "recommended_bump",
      "suggested_version",
    ]);
    if (releaseMissing.length > 0) {
      return `release decision missing fields: ${releaseMissing.join(", ")}`;
    }
  } else if (!report.no_release_reason) {
    return "non-release decision requires no_release_reason";
  }
  if (!Array.isArray(report.features) || !Array.isArray(report.bugfixes)) {
    return "features and bugfixes must be arrays";
  }
  if (!Array.isArray(report.risks) || !Array.isArray(report.blockers)) {
    return "risks and blockers must be arrays";
  }
  return "";
}

function validateExecutionReport(report) {
  const missingKeys = missingProperties(report, [
    "report_type",
    "mode",
    "requested_action",
    "outcome",
    "target",
    "target_version",
    "executed_stage",
    "plan_id",
    "evidence_url",
    "error",
  ]);
  if (missingKeys.length > 0) {
    return `execution report missing properties: ${missingKeys.join(", ")}`;
  }
  const missing = requireFields(report, [
    "report_type",
    "mode",
    "requested_action",
    "outcome",
    "target",
    "target_version",
    "evidence_url",
  ]);
  if (missing.length > 0) {
    return `execution report missing fields: ${missing.join(", ")}`;
  }
  if (report.report_type !== "execution-report") {
    return "report_type must be execution-report";
  }
  if (report.target !== "external") {
    return "execution target must be external";
  }
  if (!EXECUTION_MODES.has(report.mode)) {
    return "invalid execution mode";
  }
  if (!EXECUTION_OUTCOMES.has(report.outcome)) {
    return "invalid execution outcome";
  }
  if (
    !new Set([...STAGES, "GITHUB_RELEASE"]).has(report.requested_action)
  ) {
    return "invalid requested_action";
  }
  if ("next_action" in report) {
    return "execution report must not decide next_action";
  }
  return "";
}

function validateObservationReport(report) {
  const missingKeys = missingProperties(report, [
    "report_type",
    "target",
    "target_version",
    "stable_version",
    "observed_stage",
    "observe_since",
    "observe_until",
    "minimum_window_satisfied",
    "sample",
    "summary",
    "risk_level",
    "key_errors",
    "limitations",
    "evidence_url",
    "recommendation",
    "next_check_at",
  ]);
  if (missingKeys.length > 0) {
    return `observation report missing properties: ${missingKeys.join(", ")}`;
  }
  const missing = requireFields(report, [
    "report_type",
    "target",
    "target_version",
    "stable_version",
    "observed_stage",
    "observe_since",
    "observe_until",
    "minimum_window_satisfied",
    "sample",
    "summary",
    "risk_level",
    "key_errors",
    "limitations",
    "evidence_url",
    "recommendation",
  ]);
  if (missing.length > 0) {
    return `observation report missing fields: ${missing.join(", ")}`;
  }
  if (report.report_type !== "observation-report") {
    return "report_type must be observation-report";
  }
  if (report.target !== "external") {
    return "observation target must be external";
  }
  if (!STAGES.slice(0, -1).includes(report.observed_stage)) {
    return "invalid observed_stage";
  }
  if (!OBSERVATION_RECOMMENDATIONS.has(report.recommendation)) {
    return "invalid observation recommendation";
  }
  if (!RISK_LEVELS.has(report.risk_level)) {
    return "invalid observation risk_level";
  }
  if (!Array.isArray(report.key_errors)) {
    return "observation key_errors must be an array";
  }
  if (!Array.isArray(report.limitations)) {
    return "observation limitations must be an array";
  }
  const sampleMissing = requireFields(report.sample, [
    "target_active_instances",
    "stable_active_instances",
    "target_error_count",
    "stable_error_count",
  ]);
  if (sampleMissing.length > 0) {
    return `observation sample missing fields: ${sampleMissing.join(", ")}`;
  }
  if (
    Object.values(report.sample).some(
      (value) => typeof value !== "number" || value < 0,
    )
  ) {
    return "observation sample values must be non-negative numbers";
  }
  if (
    report.minimum_window_satisfied !== true &&
    report.recommendation !== "KEEP_OBSERVING"
  ) {
    return "an incomplete observation window can only KEEP_OBSERVING";
  }
  if (report.recommendation === "KEEP_OBSERVING" && !report.next_check_at) {
    return "KEEP_OBSERVING requires next_check_at";
  }
  return "";
}

export function evaluateTransition(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return invalid({}, "snapshot must be an object");
  }
  if (snapshot.workflow_version !== 1) {
    return invalid(snapshot, "workflow_version must be 1");
  }
  if (snapshot.validation_mode !== true) {
    return invalid(snapshot, "PRODUCTION_APPLY_DISABLED");
  }
  if (snapshot.target !== "external") {
    return invalid(snapshot, "INVALID_TARGET: only external is supported");
  }
  if (!snapshot.phase || !snapshot.event?.type) {
    return invalid(snapshot, "phase and event.type are required");
  }
  if (
    (snapshot.consumed_event_ids !== undefined &&
      !Array.isArray(snapshot.consumed_event_ids)) ||
    (snapshot.notification_keys !== undefined &&
      !Array.isArray(snapshot.notification_keys))
  ) {
    return invalid(
      snapshot,
      "consumed_event_ids and notification_keys must be arrays",
    );
  }
  if (
    REPORT_EVENT_TYPES.has(snapshot.event.type) &&
    !snapshot.event.child_id
  ) {
    return invalid(snapshot, "report event child_id is required for idempotency");
  }

  const duplicateReason = isDuplicate(snapshot);
  if (duplicateReason) {
    return result(snapshot, {
      allowed_action: "WAIT",
      reason: duplicateReason,
    });
  }

  const { phase, event } = snapshot;

  if (phase === "CANDIDATE_CHECK" && event.type === "START") {
    if (snapshot.change_child_id) {
      return result(snapshot, {
        allowed_action: "WAIT",
        reason: "the single Change child issue already exists",
      });
    }
    return result(snapshot, {
      allowed_action: "CREATE_CHANGE_ISSUE",
      next_phase: "CHANGE_ANALYSIS",
      reason: "candidate validation can simulate one Change child issue",
    });
  }

  if (phase === "CHANGE_ANALYSIS" && event.type === "CHANGE_REPORT") {
    const error = validateChangeReport(event.report);
    if (error) {
      return result(snapshot, {
        allowed_action: "NOTIFY_CHANGE_ANALYSIS_BLOCKED",
        next_phase: "CHANGE_ANALYSIS_BLOCKED",
        requires_human: true,
        reason: error,
      });
    }
    const decision = event.report.decision;
    if (decision === "RELEASE") {
      return result(snapshot, {
        allowed_action: "NOTIFY_RELEASE_RECOMMENDATION",
        next_phase: "AWAIT_HUMAN_RELEASE_DECISION",
        requires_human: true,
        reason: "complete RELEASE report is ready for a human decision",
      });
    }
    if (decision === "NO_RELEASE") {
      return result(snapshot, {
        allowed_action: "NOTIFY_NO_RELEASE",
        next_phase: "NO_RELEASE_HOLD",
        requires_human: true,
        reason: "NO_RELEASE starts the 24-hour override window",
      });
    }
    return result(snapshot, {
      allowed_action: "NOTIFY_HUMAN_REVIEW",
      next_phase: "CHANGE_ANALYSIS_BLOCKED",
      requires_human: true,
      reason: "Change evidence requires human input",
    });
  }

  if (phase === "NO_RELEASE_HOLD" && event.type === "HOLD_EXPIRED") {
    if (
      typeof event.elapsed_hours !== "number" ||
      !Number.isFinite(event.elapsed_hours) ||
      typeof event.human_override !== "boolean"
    ) {
      return invalid(
        snapshot,
        "HOLD_EXPIRED requires elapsed_hours and human_override",
      );
    }
    if (event.elapsed_hours < 24 || event.human_override === true) {
      return result(snapshot, {
        allowed_action: "WAIT",
        reason: "NO_RELEASE override window is still open",
      });
    }
    return result(snapshot, {
      allowed_action: "CLOSE_NO_RELEASE",
      next_phase: "NO_RELEASE_CLOSED",
      reason: "24-hour override window expired without an override",
    });
  }

  if (phase === "NO_RELEASE_HOLD" && event.type === "HUMAN_APPROVAL") {
    if (
      typeof event.elapsed_hours !== "number" ||
      !Number.isFinite(event.elapsed_hours) ||
      event.elapsed_hours >= 24
    ) {
      return invalid(snapshot, "NO_RELEASE override window has expired");
    }
    const error = validateApproval(snapshot, "CREATE_PLAN", {
      requireBump: true,
    });
    if (error) return invalid(snapshot, error);
    return result(snapshot, {
      allowed_action: "CREATE_PLAN_ISSUE",
      next_phase: "APPROVED_TO_PLAN",
      reason: "human overrode NO_RELEASE within the 24-hour window",
    });
  }

  if (
    phase === "AWAIT_HUMAN_RELEASE_DECISION" &&
    event.type === "HUMAN_APPROVAL"
  ) {
    const error = validateApproval(snapshot, "CREATE_PLAN", {
      requireBump: true,
    });
    if (error) return invalid(snapshot, error);
    return result(snapshot, {
      allowed_action: "CREATE_PLAN_ISSUE",
      next_phase: "APPROVED_TO_PLAN",
      reason: "human approved external plan generation",
    });
  }

  if (phase === "APPROVED_TO_PLAN" && event.type === "EXECUTION_REPORT") {
    const error = validateExecutionReport(event.report);
    if (error) return invalid(snapshot, error);
    if (
      event.report.mode !== "PLAN" ||
      event.report.requested_action !== "EXTERNAL_0" ||
      !event.report.plan_id
    ) {
      return invalid(
        snapshot,
        "plan report must use mode=PLAN, requested_action=EXTERNAL_0, and plan_id",
      );
    }
    if (event.report.target_version !== snapshot.target_version) {
      return invalid(snapshot, "plan report target_version mismatch");
    }
    if (event.report.outcome !== "PLAN_READY") {
      return result(snapshot, {
        allowed_action: "NOTIFY_EXECUTION_FAILURE",
        next_phase: "AWAIT_HUMAN_PLAN_FAILURE_DECISION",
        requires_human: true,
        reason: "external release plan was not produced",
      });
    }
    return result(snapshot, {
      allowed_action: "NOTIFY_PLAN_READY",
      next_phase: "AWAIT_EXTERNAL_START_CONFIRMATION",
      requires_human: true,
      reason: "plan is ready but does not authorize rollout 0",
    });
  }

  if (
    phase === "AWAIT_EXTERNAL_START_CONFIRMATION" &&
    event.type === "HUMAN_APPROVAL"
  ) {
    const error = validateApproval(snapshot, "EXTERNAL_0");
    if (error) return invalid(snapshot, error);
    return result(snapshot, {
      allowed_action: "DISPATCH_EXECUTION",
      next_phase: "ROLLING_OUT",
      reason: "human approved external rollout 0",
    });
  }

  if (phase === "ROLLING_OUT" && event.type === "EXECUTION_REPORT") {
    const error = validateExecutionReport(event.report);
    if (error) return invalid(snapshot, error);
    if (event.report.mode !== "EXECUTE") {
      return invalid(snapshot, "rollout report mode must be EXECUTE");
    }
    if (event.report.target_version !== snapshot.target_version) {
      return invalid(snapshot, "execution report target_version mismatch");
    }
    if (event.report.requested_action !== snapshot.stage) {
      return invalid(snapshot, "execution report action does not match current stage");
    }
    if (event.report.outcome !== "SUCCEEDED") {
      return result(snapshot, {
        allowed_action: "NOTIFY_EXECUTION_FAILURE",
        next_phase: "AWAIT_HUMAN_EXECUTION_FAILURE_DECISION",
        requires_human: true,
        reason: "execution failed; report facts and wait for a human",
      });
    }
    if (event.report.requested_action === "PROMOTE") {
      return result(snapshot, {
        allowed_action: "CREATE_RELEASE_NOTE_ISSUE",
        next_phase: "RELEASE_NOTE_PREPARING",
        reason: "external promote succeeded; prepare the public release note",
      });
    }
    if (event.report.executed_stage !== event.report.requested_action) {
      return invalid(snapshot, "successful rollout must report the executed stage");
    }
    if (
      snapshot.observation_child_id &&
      snapshot.observation_child_stage === snapshot.stage
    ) {
      return result(snapshot, {
        allowed_action: "CONTINUE_OBSERVATION_ISSUE",
        next_phase: "OBSERVING",
        reason: "the observation child for this stage already exists",
      });
    }
    return result(snapshot, {
      allowed_action: "CREATE_OBSERVATION_ISSUE",
      next_phase: "OBSERVING",
      reason: "rollout stage succeeded and requires a 30-minute observation",
    });
  }

  if (phase === "OBSERVING" && event.type === "OBSERVATION_REPORT") {
    const error = validateObservationReport(event.report);
    if (error) return invalid(snapshot, error);
    if (event.report.target_version !== snapshot.target_version) {
      return invalid(snapshot, "observation report target_version mismatch");
    }
    if (event.report.observed_stage !== snapshot.stage) {
      return invalid(snapshot, "observation report stage mismatch");
    }
    if (event.report.recommendation === "KEEP_OBSERVING") {
      return result(snapshot, {
        allowed_action: "SCHEDULE_OBSERVATION",
        next_phase: "OBSERVING",
        reason: "observation needs more evidence",
      });
    }
    if (event.report.recommendation === "PAUSE_RECOMMENDED") {
      return result(snapshot, {
        allowed_action: "NOTIFY_HUMAN_RISK_DECISION",
        next_phase: "AWAIT_HUMAN_ROLLOUT_DECISION",
        requires_human: true,
        reason: "risk found; do not freeze, roll back, or continue automatically",
      });
    }
    return result(snapshot, {
      allowed_action: "NOTIFY_HUMAN_ROLLOUT_DECISION",
      next_phase: "AWAIT_HUMAN_ROLLOUT_DECISION",
      requires_human: true,
      reason: "observation evidence is ready for a human decision",
    });
  }

  if (
    phase === "AWAIT_HUMAN_ROLLOUT_DECISION" &&
    event.type === "HUMAN_APPROVAL"
  ) {
    if (event.approval?.action === "KEEP_OBSERVING") {
      const error = validateApproval(snapshot, "KEEP_OBSERVING");
      if (error) return invalid(snapshot, error);
      return result(snapshot, {
        allowed_action: "SCHEDULE_OBSERVATION",
        next_phase: "OBSERVING",
        reason: "human explicitly requested more observation",
      });
    }
    const expected = NEXT_STAGE.get(snapshot.stage);
    if (!expected) return invalid(snapshot, "current stage has no allowed next stage");
    const error = validateApproval(snapshot, expected);
    if (error) return invalid(snapshot, error);
    return result(snapshot, {
      allowed_action: "DISPATCH_EXECUTION",
      next_phase: "ROLLING_OUT",
      reason: `human approved ${expected}`,
    });
  }

  if (
    phase === "AWAIT_HUMAN_PLAN_FAILURE_DECISION" &&
    event.type === "HUMAN_APPROVAL"
  ) {
    const error = validateApproval(snapshot, "RETRY_PLAN");
    if (error) return invalid(snapshot, error);
    return result(snapshot, {
      allowed_action: "DISPATCH_PLAN",
      next_phase: "APPROVED_TO_PLAN",
      reason: "human approved retry of external plan generation",
    });
  }

  if (
    phase === "AWAIT_HUMAN_EXECUTION_FAILURE_DECISION" &&
    event.type === "HUMAN_APPROVAL"
  ) {
    if (!STAGES.includes(snapshot.stage)) {
      return invalid(snapshot, "failed execution stage is invalid");
    }
    const error = validateApproval(snapshot, snapshot.stage);
    if (error) return invalid(snapshot, error);
    return result(snapshot, {
      allowed_action: "DISPATCH_EXECUTION",
      next_phase: "ROLLING_OUT",
      reason: `human approved retry of ${snapshot.stage}`,
    });
  }

  if (
    PAUSABLE_PHASES.has(phase) &&
    event.type === "HUMAN_PAUSE"
  ) {
    const missing = requireFields(event, [
      "comment_id",
      "actor_type",
      "target",
      "target_version",
      "evidence_id",
      "reason",
    ]);
    if (missing.length > 0) {
      return invalid(snapshot, `human pause missing fields: ${missing.join(", ")}`);
    }
    if (
      event.actor_type !== "member" ||
      event.target !== "external" ||
      event.target_version !== snapshot.target_version ||
      event.evidence_id !== snapshot.latest_evidence_id
    ) {
      return invalid(snapshot, "human pause must bind external and latest evidence");
    }
    return result(snapshot, {
      allowed_action: "MARK_PAUSED",
      next_phase: "PAUSED",
      reason: "human explicitly requested a pause",
    });
  }

  if (phase === "RELEASE_NOTE_PREPARING" && event.type === "RELEASE_NOTE_REPORT") {
    const missing = requireFields(event.report, [
      "report_type",
      "target",
      "target_version",
      "summary",
      "evidence_url",
    ]);
    if (missing.length > 0) {
      return invalid(snapshot, `release note missing fields: ${missing.join(", ")}`);
    }
    if (
      event.report.report_type !== "release-note-report" ||
      event.report.target !== "external" ||
      event.report.target_version !== snapshot.target_version
    ) {
      return invalid(snapshot, "release note target does not match workflow");
    }
    return result(snapshot, {
      allowed_action: "NOTIFY_GITHUB_RELEASE_DECISION",
      next_phase: "AWAIT_GITHUB_RELEASE_CONFIRMATION",
      requires_human: true,
      reason: "public release note is ready for GitHub approval",
    });
  }

  if (
    phase === "AWAIT_GITHUB_RELEASE_CONFIRMATION" &&
    event.type === "HUMAN_APPROVAL"
  ) {
    const error = validateApproval(snapshot, "GITHUB_RELEASE");
    if (error) return invalid(snapshot, error);
    return result(snapshot, {
      allowed_action: "DISPATCH_GITHUB_RELEASE",
      next_phase: "GITHUB_RELEASING",
      reason: "human approved the GitHub release",
    });
  }

  if (phase === "GITHUB_RELEASING" && event.type === "EXECUTION_REPORT") {
    const error = validateExecutionReport(event.report);
    if (error) return invalid(snapshot, error);
    if (event.report.mode !== "EXECUTE") {
      return invalid(snapshot, "GitHub report mode must be EXECUTE");
    }
    if (event.report.target_version !== snapshot.target_version) {
      return invalid(snapshot, "GitHub report target_version mismatch");
    }
    if (event.report.requested_action !== "GITHUB_RELEASE") {
      return invalid(snapshot, "expected a GitHub release report");
    }
    if (event.report.outcome === "SUCCEEDED") {
      return result(snapshot, {
        allowed_action: "NOTIFY_RELEASE_COMPLETED",
        next_phase: "RELEASE_COMPLETED",
        reason: "external and GitHub release validation completed",
      });
    }
    return result(snapshot, {
      allowed_action: "NOTIFY_EXECUTION_FAILURE",
      next_phase: "AWAIT_HUMAN_GITHUB_FAILURE_DECISION",
      requires_human: true,
      reason: "GitHub release failed and needs human handling",
    });
  }

  if (
    phase === "AWAIT_HUMAN_GITHUB_FAILURE_DECISION" &&
    event.type === "HUMAN_APPROVAL"
  ) {
    const error = validateApproval(snapshot, "GITHUB_RELEASE");
    if (error) return invalid(snapshot, error);
    return result(snapshot, {
      allowed_action: "DISPATCH_GITHUB_RELEASE",
      next_phase: "GITHUB_RELEASING",
      reason: "human approved retry of the GitHub release",
    });
  }

  return invalid(snapshot, "transition is not allowed");
}

function parseArgs(argv) {
  const args = { input: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input") {
      args.input = argv[index + 1] ?? "";
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  if (!args.input) throw new Error("--input is required");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(process.cwd(), args.input);
  const snapshot = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const output = evaluateTransition(snapshot);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (output.allowed_action === "INVALID") process.exitCode = 2;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main();
}
