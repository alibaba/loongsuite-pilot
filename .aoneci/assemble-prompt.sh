#!/bin/bash
set -euo pipefail

SPECS_DIR_IN_REPO="specs"
TARGET_DIR=".aoneci/specs"
PROMPT_FILE=".aoneci/review-prompt-full.md"
SOURCE_REPO="code-review-agent"

REQUIRED_SPECS=(
    "cr-convention-code-review.md"
    "semantic-convention-code-review.md"
)

if [ ! -d "$SOURCE_REPO/$SPECS_DIR_IN_REPO" ]; then
    echo "ERROR: Specs directory not found at $SOURCE_REPO/$SPECS_DIR_IN_REPO"
    echo "Make sure the checkout step for code-review-agent repo is configured"
    exit 1
fi

mkdir -p "$TARGET_DIR"

echo "Copying required specs..."
MISSING_SPECS=0
for spec in "${REQUIRED_SPECS[@]}"; do
    src="$SOURCE_REPO/$SPECS_DIR_IN_REPO/$spec"
    if [ -f "$src" ]; then
        cp "$src" "$TARGET_DIR/$spec"
        echo "  ✓ $spec"
    else
        echo "  ✗ $spec not found (REQUIRED)"
        MISSING_SPECS=$((MISSING_SPECS + 1))
    fi
done
if [ "$MISSING_SPECS" -gt 0 ]; then
    echo "ERROR: $MISSING_SPECS required spec file(s) missing."
    exit 1
fi

PROMPT_TEMPLATE=".aoneci/review-prompt.md"
if [ ! -f "$PROMPT_TEMPLATE" ]; then
    echo "ERROR: Prompt template not found at $PROMPT_TEMPLATE"
    exit 1
fi
cp "$PROMPT_TEMPLATE" "$PROMPT_FILE"

cat >> "$PROMPT_FILE" << 'HEADER_EOF'

================================================================================
代码审查规范
================================================================================
HEADER_EOF

for spec in "${REQUIRED_SPECS[@]}"; do
    if [ -f "$TARGET_DIR/$spec" ]; then
        name=$(basename "$spec" .md | sed 's/-code-review//' | tr '[:lower:]' '[:upper:]')
        echo "" >> "$PROMPT_FILE"
        echo "### ${name} 代码审查规范" >> "$PROMPT_FILE"
        cat "$TARGET_DIR/$spec" >> "$PROMPT_FILE"
    fi
done

cat >> "$PROMPT_FILE" << 'FOOTER_EOF'

================================================================================
FOOTER_EOF

echo "Prompt assembled: $PROMPT_FILE ($(wc -l < "$PROMPT_FILE") lines)"
