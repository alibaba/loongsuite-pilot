#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workflowDir = path.resolve(scriptDir, "..");
const manifestPath = path.join(workflowDir, "manifest.json");

const expectedStages = [
  "EXTERNAL_0",
  "EXTERNAL_5",
  "EXTERNAL_15",
  "EXTERNAL_40",
  "EXTERNAL_60",
  "PROMOTE",
];

function fail(errors, message) {
  errors.push(message);
}

export function validateWorkflow(baseDir = workflowDir) {
  const errors = [];
  const checked = [];
  const manifestFile = path.join(baseDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  checked.push(path.relative(baseDir, manifestFile));

  if (manifest.schema_version !== 1) {
    fail(errors, "manifest.schema_version must be 1");
  }
  if (manifest.workflow_version !== "1.0.0-validation") {
    fail(errors, "workflow_version must be 1.0.0-validation");
  }
  if (manifest.validation_only !== true) {
    fail(errors, "validation_only must be true");
  }
  if (manifest.target !== "external") {
    fail(errors, "target must be external");
  }
  if (JSON.stringify(manifest.stage_ladder) !== JSON.stringify(expectedStages)) {
    fail(errors, "stage_ladder must be 0,5,15,40,60,promote for external");
  }
  if (manifest.observation_minutes !== 30) {
    fail(errors, "observation_minutes must be 30");
  }
  if (manifest.no_release_hold_hours !== 24) {
    fail(errors, "no_release_hold_hours must be 24");
  }

  for (const resource of manifest.resources ?? []) {
    const resourcePath = path.resolve(baseDir, resource.path);
    if (!fs.existsSync(resourcePath)) {
      fail(errors, `missing resource file: ${resource.path}`);
      continue;
    }
    const content = fs.readFileSync(resourcePath, "utf8");
    checked.push(path.relative(baseDir, resourcePath));
    if (content.includes("[TODO") || content.includes("TODO:")) {
      fail(errors, `placeholder remains in ${resource.path}`);
    }
  }

  const requiredFiles = [
    "README.md",
    "squad.instructions.md",
    "agents/coordinator.instructions.md",
    "agents/release-executor.instructions.md",
    "agents/observer.instructions.md",
    "agents/release-notes.instructions.md",
    "autopilots/candidate-check.md",
    "autopilots/release-watchdog.md",
    "schemas/change-report.schema.json",
    "schemas/execution-report.schema.json",
    "schemas/observation-report.schema.json",
  ];

  for (const relativePath of requiredFiles) {
    const absolutePath = path.join(baseDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      fail(errors, `missing required file: ${relativePath}`);
      continue;
    }
    checked.push(relativePath);
  }

  for (const name of [
    "change-report.schema.json",
    "execution-report.schema.json",
    "observation-report.schema.json",
  ]) {
    const schemaPath = path.join(baseDir, "schemas", name);
    if (!fs.existsSync(schemaPath)) continue;
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      fail(errors, `${name} must use JSON Schema draft 2020-12`);
    }
    if (schema.type !== "object" || schema.additionalProperties !== false) {
      fail(errors, `${name} must be a closed object schema`);
    }
  }

  const combinedInstructions = [
    "squad.instructions.md",
    "agents/coordinator.instructions.md",
    "agents/release-executor.instructions.md",
    "agents/observer.instructions.md",
    "agents/release-notes.instructions.md",
  ]
    .map((relativePath) =>
      fs.readFileSync(path.join(baseDir, relativePath), "utf8"),
    )
    .join("\n");

  for (const phrase of [
    "VALIDATION_MODE=true",
    "external",
    "禁止",
    "30 分钟",
  ]) {
    if (!combinedInstructions.includes(phrase)) {
      fail(errors, `instructions must include ${phrase}`);
    }
  }

  return {
    valid: errors.length === 0,
    workflow_version: manifest.workflow_version,
    validation_only: manifest.validation_only,
    target: manifest.target,
    checked_files: [...new Set(checked)].sort(),
    errors,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output = validateWorkflow();
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.valid) process.exitCode = 1;
}
