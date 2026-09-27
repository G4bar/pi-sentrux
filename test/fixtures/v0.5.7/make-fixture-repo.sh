#!/usr/bin/env bash
# Recreates the Phase 0 Sentrux fixture repo described in PLAN.md §11
# "Phase 0 — capture real behaviour". TypeScript fixture; see PLAN.md for the
# Python fallback if import_edges turns out to be 0 with the real binary.
#
# Usage: make-fixture-repo.sh [target-dir]
# Default target-dir is a fresh mktemp directory (printed on stdout).
set -euo pipefail

TARGET="${1:-$(mktemp -d /tmp/sentrux-fixture.XXXXXX)}"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cd "$TARGET"

git init -q
git config user.email "fixture@example.com"
git config user.name "Sentrux Fixture"

mkdir -p src/core/sub src/app/sub src/app/deps

# --- core -> app import ---
cat > src/app/helper.ts <<'EOF'
export function appHelper(): string {
  return "app-helper";
}
EOF

cat > src/core/uses_app.ts <<'EOF'
import { appHelper } from "../app/helper";

export function coreEntry(): string {
  return appHelper();
}
EOF

# --- app -> core import, shallow core path (one level under src/core) ---
cat > src/core/base.ts <<'EOF'
export function coreBase(): string {
  return "core-base";
}
EOF

cat > src/app/uses_core.ts <<'EOF'
import { coreBase } from "../core/base";

export function appEntry(): string {
  return coreBase();
}
EOF

# --- app -> core import via a NESTED core path (src/core/sub/*), to test
# whether the "src/core/*" layer glob matches one level deeper ---
cat > src/core/sub/nested.ts <<'EOF'
export function nested(): string {
  return "nested";
}
EOF

cat > src/app/uses_nested_core.ts <<'EOF'
import { nested } from "../core/sub/nested";

export function appUsesNested(): string {
  return nested();
}
EOF

# --- core -> app import via a NESTED app path (src/app/sub/*), the mirror of
# the above, so the glob-depth question is tested in both directions ---
cat > src/app/sub/nested_app.ts <<'EOF'
export function nestedApp(): string {
  return "nested-app";
}
EOF

cat > src/core/uses_nested_app.ts <<'EOF'
import { nestedApp } from "../app/sub/nested_app";

export function coreUsesNestedApp(): string {
  return nestedApp();
}
EOF

# --- 2-file import cycle, same layer (core <-> core) ---
cat > src/core/cycle_a.ts <<'EOF'
import { cycleB } from "./cycle_b";

export function cycleA(): string {
  return "cycle-a";
}

export const refB = cycleB;
EOF

cat > src/core/cycle_b.ts <<'EOF'
import { cycleA } from "./cycle_a";

export function cycleB(): string {
  return "cycle-b";
}

export const refA = cycleA;
EOF

# --- god file: 16 outgoing imports (threshold is > 15) ---
for i in $(seq -w 1 16); do
  cat > "src/app/deps/dep${i}.ts" <<EOF
export const value${i} = ${i};
EOF
done

{
  echo "// Fixture god file: 16 outgoing imports (threshold is > 15)."
  for i in $(seq -w 1 16); do
    echo "import { value${i} } from \"./deps/dep${i}\";"
  done
  echo ""
  echo "export function sumAll(): number {"
  parts=()
  for i in $(seq -w 1 16); do
    parts+=("value${i}")
  done
  joined=$(IFS=" + "; echo "${parts[*]}")
  echo "  return ${joined};"
  echo "}"
} > src/app/god.ts

# --- one function with cyclomatic complexity > 15 (20 branches -> CC ~ 21) ---
{
  echo "export function complexDecision(x: number): string {"
  for i in $(seq 1 20); do
    if [ "$i" -eq 1 ]; then
      echo "  if (x === ${i}) return \"v${i}\";"
    else
      echo "  else if (x === ${i}) return \"v${i}\";"
    fi
  done
  echo "  else return \"default\";"
  echo "}"
} > src/app/complex.ts

git add -A
git commit -q -m "fixture: base structure (layers, cycle, god file, complex function)"

# --- one untracked file (never added to the index) ---
cat > src/app/untracked.ts <<'EOF'
export const untracked = true;
EOF

# --- one file added with --intent-to-add only (stub entry in the index,
# no blob content) ---
cat > src/app/intent_to_add.ts <<'EOF'
export const intentToAdd = true;
EOF
git add -N src/app/intent_to_add.ts

echo "Fixture repo created at: $TARGET"
git status --short
