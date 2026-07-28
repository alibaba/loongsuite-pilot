import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTransition } from "../../../skills/loongsuite-pilot-release-coordinator/scripts/validate-transition.mjs";

function base(overrides = {}) {
  return {
    workflow_version: 1,
    validation_mode: true,
    target: "external",
    target_version: "v1.1.20",
    phase: "CANDIDATE_CHECK",
    stage: "",
    latest_evidence_id: "",
    event: { type: "START" },
    ...overrides,
  };
}

function observation(recommendation) {
  return {
    report_type: "observation-report",
    target: "external",
    target_version: "v1.1.20",
    stable_version: "v1.1.19",
    observed_stage: "EXTERNAL_15",
    observe_since: "2026-07-28T10:00:00+08:00",
    observe_until: "2026-07-28T10:30:00+08:00",
    minimum_window_satisfied: true,
    sample: {
      target_active_instances: 1,
      stable_active_instances: 1,
      target_error_count: 0,
      stable_error_count: 0,
    },
    summary: "fixture observation",
    risk_level: recommendation === "PAUSE_RECOMMENDED" ? "HIGH" : "LOW",
    key_errors: [],
    limitations: [],
    evidence_url: "fixture://observation-15",
    recommendation,
    next_check_at:
      recommendation === "KEEP_OBSERVING"
        ? "2026-07-28T10:35:00+08:00"
        : "",
  };
}

function execution(overrides = {}) {
  return {
    report_type: "execution-report",
    mode: "EXECUTE",
    requested_action: "EXTERNAL_15",
    outcome: "SUCCEEDED",
    target: "external",
    target_version: "v1.1.20",
    executed_stage: "EXTERNAL_15",
    plan_id: "plan-1",
    evidence_url: "fixture://execution-15",
    error: "",
    ...overrides,
  };
}

test("rejects internal target", () => {
  const result = evaluateTransition(base({ target: "internal" }));
  assert.equal(result.allowed_action, "INVALID");
  assert.match(result.reason, /only external/);
});

test("rejects production apply mode", () => {
  const result = evaluateTransition(base({ validation_mode: false }));
  assert.equal(result.allowed_action, "INVALID");
  assert.equal(result.reason, "PRODUCTION_APPLY_DISABLED");
});

test("valid RELEASE report requests a human decision", () => {
  const result = evaluateTransition(
    base({
      phase: "CHANGE_ANALYSIS",
      event: {
        type: "CHANGE_REPORT",
        child_id: "change-1",
        report: {
          report_type: "change-report",
          decision: "RELEASE",
          recommended_bump: "patch",
          previous_version: "v1.1.19",
          suggested_version: "v1.1.20",
          features: ["feature"],
          bugfixes: [],
          risks: [],
          blockers: [],
          no_release_reason: "",
          evidence_url: "fixture://change",
          notification_copy: {},
        },
      },
    }),
  );
  assert.equal(result.allowed_action, "NOTIFY_RELEASE_RECOMMENDATION");
  assert.equal(result.next_phase, "AWAIT_HUMAN_RELEASE_DECISION");
  assert.equal(result.requires_human, true);
});

test("an incomplete Change report maps to CHANGE_ANALYSIS_BLOCKED", () => {
  const result = evaluateTransition(
    base({
      phase: "CHANGE_ANALYSIS",
      event: {
        type: "CHANGE_REPORT",
        child_id: "change-incomplete",
        report: {
          report_type: "change-report",
          decision: "RELEASE",
        },
      },
    }),
  );
  assert.equal(result.allowed_action, "NOTIFY_CHANGE_ANALYSIS_BLOCKED");
  assert.equal(result.next_phase, "CHANGE_ANALYSIS_BLOCKED");
  assert.equal(result.requires_human, true);
});

test("NO_RELEASE closes as a non-release outcome after 24 hours", () => {
  const result = evaluateTransition(
    base({
      phase: "NO_RELEASE_HOLD",
      event: {
        type: "HOLD_EXPIRED",
        elapsed_hours: 24,
        human_override: false,
      },
    }),
  );
  assert.equal(result.allowed_action, "CLOSE_NO_RELEASE");
  assert.equal(result.next_phase, "NO_RELEASE_CLOSED");
  assert.notEqual(result.next_phase, "RELEASE_COMPLETED");
});

test("NO_RELEASE does not close without a valid hold timer", () => {
  const result = evaluateTransition(
    base({
      phase: "NO_RELEASE_HOLD",
      event: { type: "HOLD_EXPIRED" },
    }),
  );
  assert.equal(result.allowed_action, "INVALID");
  assert.match(result.reason, /elapsed_hours/);
});

test("risk recommendation informs a human without auto-pausing", () => {
  const result = evaluateTransition(
    base({
      phase: "OBSERVING",
      stage: "EXTERNAL_15",
      event: {
        type: "OBSERVATION_REPORT",
        child_id: "observe-15",
        report: observation("PAUSE_RECOMMENDED"),
      },
    }),
  );
  assert.equal(result.allowed_action, "NOTIFY_HUMAN_RISK_DECISION");
  assert.equal(result.next_phase, "AWAIT_HUMAN_ROLLOUT_DECISION");
  assert.notEqual(result.next_phase, "PAUSED");
  assert.match(result.reason, /do not freeze/);
});

test("fuzzy or agent approval cannot start rollout", () => {
  const result = evaluateTransition(
    base({
      phase: "AWAIT_EXTERNAL_START_CONFIRMATION",
      latest_evidence_id: "plan-1",
      event: {
        type: "HUMAN_APPROVAL",
        comment_id: "comment-1",
        approval: {
          actor_type: "agent",
          target: "external",
          target_version: "v1.1.20",
          action: "EXTERNAL_0",
          evidence_id: "plan-1",
        },
      },
    }),
  );
  assert.equal(result.allowed_action, "INVALID");
  assert.match(result.reason, /human member/);
});

test("only the exact next rollout stage is accepted", () => {
  const result = evaluateTransition(
    base({
      phase: "AWAIT_HUMAN_ROLLOUT_DECISION",
      stage: "EXTERNAL_15",
      latest_evidence_id: "observe-15",
      event: {
        type: "HUMAN_APPROVAL",
        comment_id: "comment-2",
        approval: {
          actor_type: "member",
          target: "external",
          target_version: "v1.1.20",
          action: "EXTERNAL_60",
          evidence_id: "observe-15",
        },
      },
    }),
  );
  assert.equal(result.allowed_action, "INVALID");
  assert.match(result.reason, /EXTERNAL_40/);
});

test("a human can choose to keep observing after a risk notification", () => {
  const result = evaluateTransition(
    base({
      phase: "AWAIT_HUMAN_ROLLOUT_DECISION",
      stage: "EXTERNAL_15",
      latest_evidence_id: "observe-15",
      event: {
        type: "HUMAN_APPROVAL",
        comment_id: "comment-observe",
        approval: {
          actor_type: "member",
          target: "external",
          target_version: "v1.1.20",
          action: "KEEP_OBSERVING",
          evidence_id: "observe-15",
        },
      },
    }),
  );
  assert.equal(result.allowed_action, "SCHEDULE_OBSERVATION");
  assert.equal(result.next_phase, "OBSERVING");
});

test("a failed rollout waits for a human instead of auto-pausing", () => {
  const result = evaluateTransition(
    base({
      phase: "ROLLING_OUT",
      stage: "EXTERNAL_15",
      event: {
        type: "EXECUTION_REPORT",
        child_id: "execute-15",
        report: execution({
          outcome: "FAILED",
          executed_stage: "",
          error: "fixture failure",
        }),
      },
    }),
  );
  assert.equal(result.allowed_action, "NOTIFY_EXECUTION_FAILURE");
  assert.equal(result.next_phase, "AWAIT_HUMAN_EXECUTION_FAILURE_DECISION");
  assert.notEqual(result.next_phase, "PAUSED");
});

test("a failed GitHub release waits for a human instead of auto-pausing", () => {
  const result = evaluateTransition(
    base({
      phase: "GITHUB_RELEASING",
      stage: "PROMOTE",
      event: {
        type: "EXECUTION_REPORT",
        child_id: "github-release-1",
        report: execution({
          requested_action: "GITHUB_RELEASE",
          outcome: "FAILED",
          executed_stage: "",
          evidence_url: "fixture://github-failure",
          error: "fixture failure",
        }),
      },
    }),
  );
  assert.equal(result.allowed_action, "NOTIFY_EXECUTION_FAILURE");
  assert.equal(result.next_phase, "AWAIT_HUMAN_GITHUB_FAILURE_DECISION");
  assert.notEqual(result.next_phase, "PAUSED");
});

test("a report without child_id is rejected for idempotency", () => {
  const result = evaluateTransition(
    base({
      phase: "OBSERVING",
      stage: "EXTERNAL_15",
      event: {
        type: "OBSERVATION_REPORT",
        report: observation("CONTINUE_REVIEW_READY"),
      },
    }),
  );
  assert.equal(result.allowed_action, "INVALID");
  assert.match(result.reason, /child_id/);
});

test("candidate check reuses the single existing Change child", () => {
  const result = evaluateTransition(
    base({
      change_child_id: "change-existing",
    }),
  );
  assert.equal(result.allowed_action, "WAIT");
  assert.match(result.reason, /already exists/);
});

test("an existing observation child is continued instead of duplicated", () => {
  const result = evaluateTransition(
    base({
      phase: "ROLLING_OUT",
      stage: "EXTERNAL_15",
      observation_child_id: "observe-existing",
      observation_child_stage: "EXTERNAL_15",
      event: {
        type: "EXECUTION_REPORT",
        child_id: "execute-15",
        report: execution(),
      },
    }),
  );
  assert.equal(result.allowed_action, "CONTINUE_OBSERVATION_ISSUE");
  assert.equal(result.next_phase, "OBSERVING");
});

test("an already-sent notification is a no-op", () => {
  const notificationKey =
    "1:OBSERVING:OBSERVATION_REPORT:observe-15:NOTIFY_HUMAN_RISK_DECISION";
  const result = evaluateTransition(
    base({
      phase: "OBSERVING",
      stage: "EXTERNAL_15",
      notification_keys: [notificationKey],
      event: {
        type: "OBSERVATION_REPORT",
        child_id: "observe-15",
        report: observation("PAUSE_RECOMMENDED"),
      },
    }),
  );
  assert.equal(result.allowed_action, "WAIT");
  assert.equal(result.current_phase, "OBSERVING");
  assert.equal(result.next_phase, "OBSERVING");
});

test("a consumed child report becomes a no-op", () => {
  const result = evaluateTransition(
    base({
      phase: "OBSERVING",
      stage: "EXTERNAL_15",
      last_consumed_child_id: "observe-15",
      event: {
        type: "OBSERVATION_REPORT",
        child_id: "observe-15",
        report: observation("CONTINUE_REVIEW_READY"),
      },
    }),
  );
  assert.equal(result.allowed_action, "WAIT");
  assert.match(result.reason, /already consumed/);
});
