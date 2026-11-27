// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
'use strict';

// This file is copied into the application image and loaded by native Claude.
// The installed Pilot directory can be on a separate volume or unavailable.
if (process.versions.bun) {
  try {
    const { homedir } = require('node:os');
    const { resolve } = require('node:path');
    const pilotDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || resolve(homedir(), '.loongsuite-pilot');
    require(resolve(pilotDataDir, 'hooks', 'claude-code-sdk-preload.cjs'));
  } catch {
    // Optional telemetry must not prevent the SDK's Claude child from starting.
  }
}
