import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPlan,
  unwrapResource,
} from "../scripts/sync-multica.mjs";
import { validateWorkflow } from "../scripts/validate-workflow.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const workflowDir = path.resolve(testDir, "..");

test("workflow source is internally consistent", () => {
  const result = validateWorkflow(workflowDir);
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(result.validation_only, true);
  assert.equal(result.target, "external");
});

test("offline sync plan reports drift without applying", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(workflowDir, "manifest.json"), "utf8"),
  );
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(testDir, "fixtures/live-snapshot.json"), "utf8"),
  );
  const plan = buildPlan(
    manifest,
    (resource) => {
      const key = `${resource.kind}:${resource.id ?? resource.name}`;
      const record = snapshot[key];
      return record
        ? {
            id: record.id ?? resource.id,
            value: record[resource.field] ?? "",
          }
        : null;
    },
    workflowDir,
  );

  assert.equal(plan.length, manifest.resources.length);
  assert.ok(plan.some((item) => item.status === "different"));
  assert.ok(
    plan.some(
      (item) =>
        item.name === "loongsuite-pilot-release-coordinator" &&
        item.status === "missing",
    ),
  );
  assert.ok(plan.every((item) => !("source_content" in item)));
});

test("live Autopilot responses are unwrapped before reading description", () => {
  const record = unwrapResource("autopilot", {
    autopilot: {
      id: "autopilot-1",
      description: "validation instructions",
    },
    triggers: [],
  });
  assert.equal(record.description, "validation instructions");
});
