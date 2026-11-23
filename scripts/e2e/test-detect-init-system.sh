#!/bin/bash
# test-detect-init-system.sh — Docker-based test for detect_init_system() scenarios
#
# Usage: ./scripts/e2e/test-detect-init-system.sh
#
# Builds a single test image then runs all scenarios inside one container.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

IMAGE_NAME="detect-init-test"

echo "============================================"
echo " detect_init_system() Scenario Tests"
echo "============================================"
echo ""
echo "[build] Building test image..."

docker build -t "$IMAGE_NAME" -f - "$REPO_ROOT" <<'DOCKERFILE'
FROM ubuntu:22.04
RUN sed -i 's|http://archive.ubuntu.com|http://mirrors.aliyun.com|g; s|http://security.ubuntu.com|http://mirrors.aliyun.com|g; s|http://ports.ubuntu.com|http://mirrors.aliyun.com|g' /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    systemd sudo bash coreutils procps \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m testuser && echo "testuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
RUN useradd -m nopwduser && echo "nopwduser ALL=(ALL) ALL" >> /etc/sudoers
COPY scripts/e2e/test-detect-init-runner.sh /opt/run-tests.sh
RUN chmod +x /opt/run-tests.sh
DOCKERFILE

echo "[build] Done."
echo ""

docker run --rm "$IMAGE_NAME" /opt/run-tests.sh
