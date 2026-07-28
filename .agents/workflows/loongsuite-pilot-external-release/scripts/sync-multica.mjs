#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workflowDir = path.resolve(scriptDir, "..");

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalize(value) {
  return String(value ?? "").replaceAll("\r\n", "\n").trimEnd();
}

function parseArgs(argv) {
  const args = {
    command: argv[0] ?? "",
    snapshot: "",
    live: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--snapshot") {
      args.snapshot = argv[index + 1] ?? "";
      index += 1;
    } else if (argv[index] === "--live") {
      args.live = true;
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  if (args.command !== "plan") {
    throw new Error(
      "PRODUCTION_APPLY_DISABLED: this validation-only version supports only `plan`",
    );
  }
  if (args.live === Boolean(args.snapshot)) {
    throw new Error("choose exactly one of --live or --snapshot <file>");
  }
  return args;
}

function runMultica(args) {
  const stdout = execFileSync("multica", [...args, "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout);
}

export function unwrapResource(kind, record) {
  return kind === "autopilot" ? record.autopilot : record;
}

function resolveLiveResource(resource) {
  let id = resource.id;
  if (resource.kind === "skill" && !id) {
    const skills = runMultica(["skill", "list"]);
    const match = skills.find((skill) => skill.name === resource.name);
    if (!match) return null;
    id = match.id;
  }
  if (!id) return null;

  // Resource responses can contain secret-bearing sibling fields. Keep the
  // object in memory only long enough to select the manifest-declared field;
  // never print or persist the full response.
  let record;
  if (resource.kind === "squad") {
    record = runMultica(["squad", "get", id]);
  } else if (resource.kind === "agent") {
    record = runMultica(["agent", "get", id]);
  } else if (resource.kind === "autopilot") {
    record = runMultica(["autopilot", "get", id]);
  } else if (resource.kind === "skill") {
    record = runMultica(["skill", "get", id]);
  } else {
    throw new Error(`unsupported resource kind: ${resource.kind}`);
  }
  record = unwrapResource(resource.kind, record);
  return { id, value: record[resource.field] ?? "" };
}

function snapshotKey(resource) {
  return `${resource.kind}:${resource.id ?? resource.name}`;
}

function resolveSnapshotResource(snapshot, resource) {
  const record = snapshot[snapshotKey(resource)];
  if (!record) return null;
  return {
    id: record.id ?? resource.id,
    value: record[resource.field] ?? "",
  };
}

export function buildPlan(manifest, getRemote, baseDir = workflowDir) {
  return manifest.resources.map((resource) => {
    const sourcePath = path.resolve(baseDir, resource.path);
    const sourceValue = normalize(fs.readFileSync(sourcePath, "utf8"));
    const remote = getRemote(resource);
    if (!remote) {
      return {
        kind: resource.kind,
        id: resource.id,
        name: resource.name,
        field: resource.field,
        status: "missing",
        source_path: path.relative(baseDir, sourcePath),
        source_sha256: hash(sourceValue),
        remote_sha256: null,
      };
    }
    const remoteValue = normalize(remote.value);
    return {
      kind: resource.kind,
      id: remote.id,
      name: resource.name,
      field: resource.field,
      status: sourceValue === remoteValue ? "in_sync" : "different",
      source_path: path.relative(baseDir, sourcePath),
      source_sha256: hash(sourceValue),
      remote_sha256: hash(remoteValue),
    };
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(workflowDir, "manifest.json"), "utf8"),
  );
  let getRemote;
  let source;
  if (args.live) {
    getRemote = resolveLiveResource;
    source = "live-read-only";
  } else {
    const snapshotPath = path.resolve(process.cwd(), args.snapshot);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    getRemote = (resource) => resolveSnapshotResource(snapshot, resource);
    source = path.relative(process.cwd(), snapshotPath);
  }
  const plan = buildPlan(manifest, getRemote);
  const output = {
    command: "plan",
    validation_only: true,
    workflow_version: manifest.workflow_version,
    target: manifest.target,
    source,
    summary: {
      in_sync: plan.filter((item) => item.status === "in_sync").length,
      different: plan.filter((item) => item.status === "different").length,
      missing: plan.filter((item) => item.status === "missing").length,
    },
    resources: plan,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
