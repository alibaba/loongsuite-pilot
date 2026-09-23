#!/usr/bin/env bash
set -euo pipefail
parity_root="${1:?Usage: prepare.sh ABSOLUTE_TEST_DIRECTORY}"
mkdir -p "$parity_root/baseline" "$parity_root/pilot"
for parity_mode in baseline pilot; do
  uv venv --python 3.12 "$parity_root/$parity_mode/venv"
  uv pip install --python "$parity_root/$parity_mode/venv/bin/python" qwenpaw==2.1.0 agentscope==2.0.4.post1
done
uv pip install --python "$parity_root/baseline/venv/bin/python" \
  loongsuite-instrumentation-qwenpaw==0.9.0 \
  loongsuite-instrumentation-agentscope==0.9.0 \
  loongsuite-otel-util-genai==0.9.0 opentelemetry-exporter-otlp-proto-http
for parity_mode in baseline pilot; do
  uv pip check --python "$parity_root/$parity_mode/venv/bin/python" > "$parity_root/$parity_mode/pip-check.txt" 2>&1
  uv pip freeze --python "$parity_root/$parity_mode/venv/bin/python" > "$parity_root/$parity_mode/packages.txt"
done
