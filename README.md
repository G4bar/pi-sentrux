# pi-sentrux

Sentrux architecture-quality tools (Quality Signal, rules, gate, session diff)
for the pi coding agent. Wraps the Sentrux CLI and MCP server without changing
Sentrux — never run bare `sentrux`, `sentrux <path>`, or `sentrux scan` (they
open a GUI). All Sentrux invocations go through this package's allowlisted
`check` / `gate` / `mcp` / `--version` argv.

Pinned to Sentrux **v0.5.7** (released 2026-03-18); versions below 0.5.0 are
rejected, and any version other than 0.5.7 produces a warning ("parsers
verified for 0.5.7").

## Prerequisites

- Node `>=22.19.0`, pi coding agent `0.87.1` (dev dependency; host peer
  dependencies are `"*"`).
- A Sentrux binary, found in this order: `SENTRUX_BIN` (overrides `binaryPath`
  alone), then global config `binaryPath`, then `PATH`, then the managed
  install `<agentDir>/pi-sentrux/bin/`. A project config may never set `binaryPath`.
- No Sentrux binary yet? Run `/sentrux install` (downloads the pinned v0.5.7
  asset for your platform and verifies its sha256), or
  `brew install sentrux/tap/sentrux` (macOS arm64 and Linux x86_64 only), or
  set `SENTRUX_BIN`. Nothing is ever downloaded automatically.

## Linux: GTK3/X11 runtime libraries

The Linux release binary links GTK3/xcb/xkbcommon libraries **even for
CLI/MCP use** — no display server is needed (CLI and MCP work with `DISPLAY`
unset), but the shared libraries must be present. If they are missing you get
an actionable error naming the library; install it, e.g.:

- Debian/Ubuntu:
  `sudo apt install libgtk-3-0 libxcb-render0 libxcb-shape0 libxcb-xfixes0 libxkbcommon0`
  (Ubuntu 24.04: `libgtk-3-0t64`)
- Fedora: `sudo dnf install gtk3 libxcb libxkbcommon`

`/sentrux status` also runs `ldd` on Linux when available and lists any
`=> not found` lines.

## Network and telemetry behaviour

Sentrux has network side effects this package does not hide — a first-run
grammar download and a daily version ping (details below) — but ordinary
`check` / `gate` / scan calls make no network requests of their own:

- **First run:** Sentrux downloads ~30 MB of language grammars into
  `~/.sentrux/plugins/<lang>/grammars/<platform>.so` (one directory deeper
  than upstream docs suggest). This blocks the first spawn, so CLI/start
  timeouts are 5 minutes and the extension warms up with `--version` at
  session start. We cannot checksum-pin the grammar tarball Sentrux fetches
  itself — that download is Sentrux's own, outside our control.
- **Daily ping:** at most once every 24 h, Sentrux calls
  `https://api.sentrux.dev/version` with version, platform, tier, scan/MCP/
  gate counts, the file count, and the quality grade (0–10000). The **only**
  opt-out is the file `~/.sentrux/telemetry_opt_out` — no environment
  variable disables it. With the file present (created **before** the first
  run to suppress even the first ping), the ping and its
  `last_update_check`/`latest_version` cache never fire across ~20 runs; a
  local counter file `~/.sentrux/telemetry_pending.json` is still written.
- **Opt out:** run `/sentrux telemetry-off` — it asks for confirmation, then
  creates the empty `~/.sentrux/telemetry_opt_out` file. Idempotent; never
  deletes anything.

## Config

Global config lives at `<agentDir>/pi-sentrux/config.json`; a trusted
project's `.pi/sentrux.json` may additionally set a restricted subset.
`SENTRUX_BIN` overrides `binaryPath` alone.

| Key | Default | Project may set | Meaning |
|---|---|---|---|
| `binaryPath` | — | never | Global-only Sentrux binary path |
| `skipGrammarDownload` | `false` | no | Advanced/unsupported: sets `SENTRUX_SKIP_GRAMMAR_DOWNLOAD=1` in the spawned CLI/MCP process env (note: with zero cached grammars, scanning likely cannot parse anything) |
| `warmup` | `true` | no | `--version` warm-up at session start (front-loads the grammar download) |
| `cliTimeoutMs` | `300000` | no | CLI timeout (first run may download grammars) |
| `mcpStartTimeoutMs` | `300000` | no | MCP server start timeout |
| `mcpCallTimeoutMs` | `120000` | no | MCP call timeout |
| `maxServers` | `3` | no | Per-root MCP server cap (LRU, session-less handles evicted first) |
| `maxOutputBytes` | `8192` | yes | Model-text truncation budget |
| `maxOutputLines` | `200` | yes | Model-text truncation budget |
| `untrackedWarning` | `true` | yes | Warn about git-untracked files (invisible to Sentrux) |
| `allowBaselineWrite` | `true` | no | Allow `sentrux_gate save=true` to write `.sentrux/baseline.json` |
| `nudge` | `"off"` | yes | `"off"` or `"agent_end"` post-edit quality nudge (opt-in; skipped while a `sentrux_session` baseline is active — see below) |
| `nudgeThreshold` | `200` | yes | Nudge fires only above this quality-point drop, or when the cycle count rises |

## Tools

All five tools warn about untracked files (Sentrux reads `git ls-files`;
`git add -N` is enough for a new file to be scanned) and never change git
state. The warning leads the model text — output truncation drops the tail,
so leading with it guarantees the model still sees it — and `.sentrux/`
config paths are excluded from it.

- `sentrux_scan` — Quality Signal 0–10000, bottleneck, all five root-cause
  scores with raw values, and size counts. One focused change per scan; every
  call rescans the whole tree.
- `sentrux_check_rules` — runs `sentrux check` (read-only, all rules, no tier
  cap). `[[boundaries]]` violations are reported **only** here — the MCP
  `check_rules` view silently drops them. Violations are grouped per rule
  with a count; per-edge layer/boundary violations collapse to compact
  `from → to` lines capped per rule (`… N more`), so even dozens of
  violations fit the output budget (full list stays in details).
- `sentrux_gate` — on-disk regression gate in `.sentrux/baseline.json`:
  `save=true` writes the baseline; `save=false` reports `ok` / `degraded` /
  `no_baseline`. Degraded: quality drops >200 points, coupling rises >0.05,
  or cycles / god files / complex functions rise.
- `sentrux_session` — in-memory before/after for this pi session: `start`
  records a baseline, `end` rescans and diffs, `status` reports whether a
  baseline exists. Lost if the server restarts (timeout, abort,
  `/sentrux restart` closes all servers, so the next `end`/`status` reports
  `lost` with instructions).
- `sentrux_insights` — `dsm` / `test_gaps` / `git_stats` summaries. Free tier
  returns summary counts only (`dsm` clusters included; only the ASCII matrix
  is Pro-gated). When health reports import cycles while Sentrux's own `dsm`
  interpretation still claims clean layering, a note says so.

Scales: quality and root-cause scores print on the primary 0–10000 scale.
Sentrux's own 0–1 figures (coupling, gate `reasons`, `coverage_score`) are
labeled `(0–1 scale)`; floats are rounded to 3 significant figures
(`Gini=0.573`), while integer scores and counts print untouched.

## Commands

`/sentrux [status|install|restart|telemetry-off]` (default: `status`).

- `status` — binary path/source/version (plus warning), `ldd`
  missing-library list, `~/.sentrux` and opt-out presence, config files in
  effect, active servers (root, pid, session state).
- `install` — asks for confirmation (dialog UI required), downloads the
  pinned v0.5.7 asset over HTTPS to a temp file, verifies sha256, `chmod
  +x`, atomically renames into the managed cache, validates `--version`.
  Release assets: `sentrux-linux-x86_64`, `sentrux-linux-aarch64`,
  `sentrux-darwin-arm64`, `sentrux-windows-x86_64.exe` (no macOS x86_64
  asset — use Homebrew or cargo there).
- `restart` — asks for confirmation when any server has a session, closes
  all servers (baselines are lost), then re-resolves the binary and reports
  its path and version.
- `telemetry-off` — asks for confirmation, creates
  `~/.sentrux/telemetry_opt_out` only. Idempotent; never deletes.

## Skill

`skills/sentrux/SKILL.md` is the agent's playbook: the signal, the
measure→fix→remeasure workflow, root-cause fixes, the `git add -N` rule, the
`rules.toml` reference (constraints, layers, boundaries, glob depth —
`dir/*` is shallow-only, `dir/**` covers subtrees), session vs gate, and
limits. Note the verified layer direction: the **higher**-`order` layer must
not import the **lower**-`order` layer (opposite of the upstream docs'
plain-language description).

## Limitations

- Output formats are human text pinned to v0.5.7 fixtures; parsers fail
  loudly (throw with a capped stderr/stdout tail) on anything else.
- Exit code 1 means both "violations/degraded" and "error" — classification
  trusts the parsed stdout summary regardless of the exit code; a run the
  parser cannot recognise throws with a capped stderr tail plus a stdout tail.
- Scans cannot be cancelled: abort/timeout kills the server and loses the
  session baseline (`session end` then returns `lost`).
- `session_end` re-scans the server's own `scan_root` — one server per root.
- New files are invisible until `git add -N`; the tools never stage anything.
- The bundled grammar tarball is not checksum-pinned by us.
- Publishing needs explicit user approval.

## Nudge (opt-in)

With `nudge: "agent_end"`, the extension warms up a pre-edit quality baseline
in the background at agent start. The first edit/write tool call in each run
waits for that baseline (at most 30 s, at most once per root per run, and
interruptible with ESC); later edits reuse it. At agent end, a rescan compares
against the baseline and nudges only on a quality drop above `nudgeThreshold`
or a risen cycle count. Nudge scans share the per-root MCP server with
`sentrux_session`, so they are skipped while a session baseline is active for
that root — otherwise a nudge timeout could kill the server and lose the
session.

The nudge names the root cause whose score fell the most
(`worst drop: <cause> (<delta>)`), falling back to the overall bottleneck
when no cause fell. It is delivered as a next-turn message: it appears on
the following user turn, never inside a one-shot `--print` run (which exits
before delivery).

## Installing this package

```sh
pi install git:github.com/<owner>/pi-sentrux
```

(Replace `<owner>` with the GitHub owner once the repository exists.)
