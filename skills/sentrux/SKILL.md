---
name: sentrux
description: Measure and improve code architecture with the sentrux_* tools (Quality Signal 0–10000, root causes, rules.toml, gate, session). Use when refactoring, adding modules, reviewing structure, or writing .sentrux/rules.toml.
---

# Sentrux

Sentrux measures architectural quality. Use the `sentrux_*` tools — never run
bare `sentrux`, `sentrux <path>`, or `sentrux scan` through bash (they open a GUI).

## 1. The signal

The Quality Signal runs from **0 to 10000**. It is the geometric mean of five
root-cause scores, ×10000. It cannot be gamed: raising one factor while tanking
another does not help. The **bottleneck** is the root cause with the lowest score.

Each root cause has a score (0–10000) plus a raw value:

| Root cause | Raw value |
|---|---|
| modularity | Q (modularity metric) |
| acyclicity | cycle count |
| depth | max dependency depth |
| equality | Gini coefficient of complexity |
| redundancy | (dead + duplicate) / total functions |

`sentrux_scan` returns the signal, the bottleneck, every score with its raw value,
and size counts (files, lines, import edges).

## 2. Workflow

1. `sentrux_session start`. For work that spans sessions or goes to CI, use
   `sentrux_gate save=true` instead.
2. `sentrux_scan` to read the bottleneck.
3. Make one focused change aimed at the bottleneck root cause.
4. `sentrux_scan` again, and check that the other factors did not drop.
5. Repeat until gains plateau. Heuristic: under about 50 points of gain in each
   of two iterations, or the scope the user asked for is done. (Docs: converge
   when marginal improvement approaches zero.)
6. `sentrux_session end` or `sentrux_gate`. Fix any degradation you introduced.
7. `sentrux_check_rules` before finishing.

## 3. Root cause to typical fix

- **modularity:** cohesive modules and fewer cross-module imports.
- **acyclicity:** break cycles by extracting interfaces or moving shared code down.
- **depth:** flatten long dependency chains.
- **equality:** split god files (more than 15 outgoing dependencies) and very
  complex functions (cyclomatic complexity over 15).
- **redundancy:** delete dead code and merge duplicates.

## 4. Untracked files are invisible

Sentrux reads the file list from `git ls-files`. Genuinely untracked files are
excluded from every scan. `git add -N` (intent-to-add, no content committed) is
already enough for Sentrux to measure a new file — the content does not need to
be staged or committed.

The tools warn about untracked files but never change git state themselves.
**Ask the user before staging anything, and never commit for them.**

## 5. `rules.toml` reference

Rules live in `<root>/.sentrux/rules.toml`. `sentrux_check_rules` runs
`sentrux check` (read-only): all rules, no tier cap. `[[boundaries]]`
violations are reported **only** by this CLI check — the MCP `check_rules`
view silently drops them.

Boolean constraints set to `false` are disabled entirely (not counted, not
checked). Numeric constraints are always counted and checked, whatever their
value. A missing rules file reports that no rules exist (details status
`no_rules`); an invalid file reports which parse line failed.

### 5.1 `[constraints]` — all 13 keys

| Key | Type | Meaning |
|---|---|---|
| `min_quality` | number 0–1 | Fail when quality/10000 is below this (e.g. `0.9` means 9000). |
| `min_modularity` | number 0–1 | Fail when the modularity score is below this. |
| `min_acyclicity` | number 0–1 | Fail when the acyclicity score is below this. |
| `min_depth` | number 0–1 | Fail when the depth score is below this. |
| `min_equality` | number 0–1 | Fail when the equality score is below this. |
| `min_redundancy` | number 0–1 | Fail when the redundancy score is below this. |
| `max_coupling_score` | number 0–1 | Fail when the coupling score exceeds this. |
| `max_cycles` | integer | Fail when the circular-dependency count exceeds this. |
| `max_cc` | integer | Fail when any function's cyclomatic complexity exceeds this. |
| `max_file_lines` | integer | Fail when any file exceeds this many lines. |
| `max_fn_lines` | integer | Fail when any function exceeds this many lines. |
| `no_god_files` | boolean | When `true`, fail when any file has fan-out over 15. When `false`, the rule is disabled. |
| `max_upward_violations` | integer | Fail when the layer upward-violation count exceeds this. |

### 5.2 `[[layers]]` — higher order must not import lower order

Each layer is `{name, paths, order}`; at least two layers are needed. A file's
layer is taken as the **first** layer whose glob matches it (assumed from
observed behaviour — first-match precedence was not directly verified). Files matching no layer are
ignored.

Direction (verified against v0.5.7, opposite of the plain-language docs): the
layer with the **HIGHER** `order` must not import the layer with the **LOWER**
`order`. With `core` at order 0 and `app` at order 1, an `app` file importing a
`core` file is the violation (`app must not depend on core`); a `core` file
importing an `app` file is allowed.

Glob depth: `src/core/*` matches only direct children (e.g. `src/core/base.ts`)
and does **not** match one directory level deeper (`src/core/sub/nested.ts` is
not assigned to the layer). Use `src/core/**` for a whole subtree.

Minimal layers example (flags `src/app/uses_core.ts` importing `src/core/base.ts`):

```toml
[[layers]]
name = "core"
paths = ["src/core/*"]
order = 0

[[layers]]
name = "app"
paths = ["src/app/*"]
order = 1
```

### 5.3 `[[boundaries]]` — one-way import bans

Each boundary is `{from, to, reason}`. A violation is reported when a file
matching the `from` glob imports a file matching the `to` glob. Only the CLI
check reports these.

```toml
[[boundaries]]
from = "src/core/*"
to = "src/app/*"
reason = "core must not import app-specific helpers"
```

### 5.4 Glob forms

Observed forms (not every form directly verified): `dir/*`, `dir/**`, `*.ext`,
a path prefix, or an exact path.
Remember the depth rule: `*` is one level (direct children), `**` is the whole
subtree.

### 5.5 Pitfalls

- `max_coupling = "B"` is silently ignored — the real key is `max_coupling_score`.
- `[language.X.constraints]` sections are parsed but never applied.

### 5.6 Starter template

Copy this to `.sentrux/rules.toml` and adjust the thresholds. Keep `**` globs
when you want whole subtrees covered. Give the most foundational layer the
**highest** `order`: here `app` (order 0) may import `core` (order 1), while
`core` importing `app` is flagged by both the layer rule and the boundary.
The boundary repeats the layer rule on purpose: it carries a custom reason,
and keeping both shows each syntax.

```toml
[constraints]
min_quality = 0.0
max_cycles = 0
max_cc = 15
no_god_files = true
max_upward_violations = 0

[[layers]]
name = "app"
paths = ["src/app/**"]
order = 0

[[layers]]
name = "core"
paths = ["src/core/**"]
order = 1

[[boundaries]]
from = "src/core/**"
to = "src/app/**"
reason = "core must not import app-specific helpers"
```

## 6. Session vs gate

- `sentrux_session` is an **in-memory** before/after for this pi session:
  `start` records a baseline, `end` rescans and reports signal before/after/delta
  plus coupling and cycle changes (repeatable — always compares with the start),
  `status` reports whether a baseline exists. The baseline is lost if the Sentrux
  server restarts (timeout, abort, `/sentrux restart`).
- `sentrux_gate` is the **on-disk** regression gate in
  `.sentrux/baseline.json`: `save=true` writes the baseline (blocked when
  `allowBaselineWrite` is false), `save=false` compares and reports
  `ok` / `degraded` / `no_baseline`. Degraded means any of: quality drops by
  more than 200 points (0.02), coupling rises by more than 0.05, cycles rise,
  god files rise, or functions with complexity over 15 rise. The baseline
  persists across sessions — prefer it for CI or multi-session work.

## 7. Limits

- The free tier returns summary counts only for insights (`dsm`, `test_gaps`,
  `git_stats`), and `health` has no Pro diagnostics. The DSM matrix itself is
  Pro-only (`format="text"` returns the same stats as `format="stats"`).
- Every call rescans the whole tree, so measure per focused change, not after
  every tiny edit.
- Never run bare `sentrux` or `sentrux scan` — they open a GUI.
- Sentrux sends a daily usage ping (counts, file count, quality score). The only
  opt-out is the file `~/.sentrux/telemetry_opt_out` — create it with
  `/sentrux telemetry-off` (asks for confirmation, is idempotent, and never
  deletes anything). Check `/sentrux status` for the
  binary, version, telemetry state, config files, and active servers.
