#!/bin/bash
set -euo pipefail

# idealab proxy: disable adaptive thinking (required for Claude Code 2.1.143+)
export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
export CLAUDE_CODE_EFFORT_LEVEL=high

echo "=== Setting up Claude model wrapper ==="

CLAUDE_PATH=$(which claude 2>/dev/null || echo "")
if [ -z "$CLAUDE_PATH" ]; then
  echo "⚠ claude not found yet, checking npm global bin..."
  NPM_GLOBAL_BIN=$(npm prefix -g 2>/dev/null)/bin
  CLAUDE_PATH="$NPM_GLOBAL_BIN/claude"
  if [ ! -f "$CLAUDE_PATH" ]; then
    echo "ERROR: Cannot find claude binary"
    exit 1
  fi
fi

echo "Found claude at: $CLAUDE_PATH"

CLAUDE_MODEL_NAME="${CLAUDE_MODEL_NAME:-}"
if [ -z "$CLAUDE_MODEL_NAME" ] || [ "$CLAUDE_MODEL_NAME" = "null" ]; then
  CLAUDE_MODEL_NAME="claude-opus-4-6"
fi
MODEL="$CLAUDE_MODEL_NAME"
echo "Model to inject: $MODEL"

MR_ID=""
SPEL_CONTEXT="/aoneci/wrapper/spelContext"
if [ -f "$SPEL_CONTEXT" ]; then
  if command -v python3 >/dev/null 2>&1; then
    MR_ID=$(python3 -c "import sys,json; print(json.load(sys.stdin)['git']['merge_request']['id'])" < "$SPEL_CONTEXT" 2>/dev/null || echo "")
    if [ -n "$MR_ID" ]; then
      echo "Extracted MR ID from spelContext: $MR_ID"
    else
      echo "⚠ WARNING: spelContext exists but MR ID extraction failed."
    fi
  else
    echo "⚠ WARNING: python3 not available — cannot extract MR ID from spelContext."
  fi
else
  echo "⚠ WARNING: spelContext not found at $SPEL_CONTEXT."
fi

REAL_PATH="${CLAUDE_PATH}-real"
MARKER_FILE="${CLAUDE_PATH}.wrapper-marker"

if [ -f "$MARKER_FILE" ]; then
  if [ -f "$REAL_PATH" ]; then
    echo "Wrapper already exists (marker found). Skipping re-wrap."
  else
    echo "ERROR: Wrapper marker exists but claude-real is missing. Aborting."
    exit 1
  fi
elif [ -f "$REAL_PATH" ]; then
  echo "claude-real exists but no marker file. Creating marker and proceeding."
  touch "$MARKER_FILE"
else
  mv "$CLAUDE_PATH" "$REAL_PATH"
  touch "$MARKER_FILE"
  echo "Moved claude to $REAL_PATH and created marker file."
fi

cat > "$CLAUDE_PATH" << 'WRAPPER_EOF'
#!/bin/bash
WRAPPER_EOF

printf 'MODEL="%s"\n' "$MODEL" >> "$CLAUDE_PATH"

if [ -n "$MR_ID" ]; then
  printf 'export AONE_CI_MERGE_REQUEST_ID="%s"\n' "$MR_ID" >> "$CLAUDE_PATH"
fi

cat >> "$CLAUDE_PATH" << 'WRAPPER_EOF2'
# idealab proxy does not support Claude Code 2.1.143+ adaptive thinking params
export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
export CLAUDE_CODE_EFFORT_LEVEL=high
exec "$(dirname "$0")/claude-real" --model "$MODEL" "$@"
WRAPPER_EOF2

chmod +x "$CLAUDE_PATH"
echo "✓ Created wrapper at $CLAUDE_PATH"
echo "  Model: $MODEL"
echo "  AONE_CI_MERGE_REQUEST_ID: ${MR_ID:-<not set>}"

echo "=== Claude model wrapper setup completed ==="
