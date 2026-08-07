#!/usr/bin/env bash

set -euo pipefail

GITLEAKS_BIN="${GITLEAKS_BIN:-gitleaks}"
CONFIG_PATH="${1:-.gitleaks.toml}"
LEAK_EXIT=42

if [ ! -x "${GITLEAKS_BIN}" ]; then
  echo "Gitleaks binary is not executable: ${GITLEAKS_BIN}" >&2
  exit 1
fi

if [ ! -f "${CONFIG_PATH}" ]; then
  echo "Gitleaks configuration does not exist: ${CONFIG_PATH}" >&2
  exit 1
fi

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT

IGNORE_PATH="${TEST_ROOT}/gitleaksignore"
: > "${IGNORE_PATH}"

part_one='aB3dE5fG7hJ9kL'
part_two='2mN4pQ6rS8tV0xYz'
access_key_secret="${part_one}${part_two}"
id_marker='I'
access_key_id="LTA${id_marker}a1B2c3D4e5F6g7H8i9J0"
license_part_one='LIC-aB3dE5fG7hJ9'
license_part_two='kL2mN4pQ6rS8tV0xYz'
license_key="${license_part_one}${license_part_two}"

run_scan() {
  local mode="$1"
  local target="$2"
  local rule="$3"
  shift 3

  set +e
  "${GITLEAKS_BIN}" "${mode}" "${target}" \
    --config "${CONFIG_PATH}" \
    --gitleaks-ignore-path "${IGNORE_PATH}" \
    --ignore-gitleaks-allow \
    --enable-rule "${rule}" \
    --redact=100 \
    --exit-code="${LEAK_EXIT}" \
    --no-banner \
    "$@" > "${TEST_ROOT}/scan.log" 2>&1
  local status=$?
  set -e
  return "${status}"
}

expect_finding() {
  local name="$1"
  shift

  local status
  if run_scan "$@"; then
    status=0
  else
    status=$?
  fi

  if [ "${status}" -eq 0 ]; then
    echo "FAIL: ${name}: expected a finding but the scan passed" >&2
    return 1
  fi
  if [ "${status}" -ne "${LEAK_EXIT}" ]; then
    echo "FAIL: ${name}: scanner returned ${status}, expected ${LEAK_EXIT}" >&2
    sed -n '1,80p' "${TEST_ROOT}/scan.log" >&2
    return 1
  fi
  echo "PASS: ${name}"
}

expect_clean() {
  local name="$1"
  shift

  local status
  if run_scan "$@"; then
    status=0
  else
    status=$?
  fi

  if [ "${status}" -ne 0 ]; then
    echo "FAIL: ${name}: scanner returned ${status}, expected 0" >&2
    sed -n '1,80p' "${TEST_ROOT}/scan.log" >&2
    return 1
  fi
  echo "PASS: ${name}"
}

positive_dir="${TEST_ROOT}/positive"
negative_dir="${TEST_ROOT}/negative"
allow_comment_dir="${TEST_ROOT}/allow-comment"
mkdir -p "${positive_dir}" "${negative_dir}" "${allow_comment_dir}"

printf 'const accessKeyId = "%s";\n' "${access_key_id}" > "${positive_dir}/access-key-id.js"
printf 'ALIBABA_CLOUD_ACCESS_KEY_SECRET="%s"\n' "${access_key_secret}" > "${positive_dir}/access-key-secret.env"
printf 'licenseKey: "%s"\n' "${license_key}" > "${positive_dir}/license-key.yml"

printf '%s\n' \
  'const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;' \
  'const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;' \
  'const licenseKey = "example-license-key";' \
  'activationCode: "your-license-key"' > "${negative_dir}/placeholders.txt"

printf 'licenseKey: "%s" # gitleaks:allow\n' "${license_key}" > "${allow_comment_dir}/license-key.yml"

expect_finding "Alibaba AccessKey ID" dir "${positive_dir}/access-key-id.js" alibaba-access-key-id
expect_finding "Alibaba AccessKey Secret" dir "${positive_dir}/access-key-secret.env" loongsuite-alibaba-access-key-secret
expect_finding "license key" dir "${positive_dir}/license-key.yml" loongsuite-license-key
expect_finding "inline allow comment is ignored" dir "${allow_comment_dir}" loongsuite-license-key
expect_clean "environment references and placeholders" dir "${negative_dir}" loongsuite-license-key

history_repo="${TEST_ROOT}/history-repo"
mkdir -p "${history_repo}"
git -C "${history_repo}" init -q
git -C "${history_repo}" config user.name "Secret Scan Test"
git -C "${history_repo}" config user.email "secret-scan@example.invalid"
printf 'safe\n' > "${history_repo}/fixture.txt"
git -C "${history_repo}" add fixture.txt
git -C "${history_repo}" commit -qm "base"
history_base="$(git -C "${history_repo}" rev-parse HEAD)"
printf 'const accessKeyId = "%s";\n' "${access_key_id}" > "${history_repo}/fixture.txt"
git -C "${history_repo}" commit -qam "add secret"
printf 'safe again\n' > "${history_repo}/fixture.txt"
git -C "${history_repo}" commit -qam "remove secret"
expect_finding \
  "secret removed later in the pull request" \
  git "${history_repo}" alibaba-access-key-id \
  --log-opts="${history_base}..HEAD"

existing_repo="${TEST_ROOT}/existing-repo"
mkdir -p "${existing_repo}"
git -C "${existing_repo}" init -q
git -C "${existing_repo}" config user.name "Secret Scan Test"
git -C "${existing_repo}" config user.email "secret-scan@example.invalid"
printf 'const accessKeyId = "%s";\n' "${access_key_id}" > "${existing_repo}/existing.js"
git -C "${existing_repo}" add existing.js
git -C "${existing_repo}" commit -qm "existing base secret"
existing_base="$(git -C "${existing_repo}" rev-parse HEAD)"
printf 'safe pull request change\n' > "${existing_repo}/safe.txt"
git -C "${existing_repo}" add safe.txt
git -C "${existing_repo}" commit -qm "safe change"
expect_clean \
  "pre-existing base finding is outside the pull request range" \
  git "${existing_repo}" alibaba-access-key-id \
  --log-opts="${existing_base}..HEAD"

echo "All Gitleaks rule tests passed."
