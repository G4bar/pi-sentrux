# pi-sentrux

Sentrux architecture-quality tools (Quality Signal, rules, gate, session diff) for the [pi coding agent](https://github.com/earendil-works/pi).

> [!NOTE]
> This is an **unofficial** pi extension. It wraps the Sentrux CLI and MCP server **without modifying them** and is not affiliated with or endorsed by Sentrux.

## About Sentrux

[Sentrux](https://github.com/sentrux/sentrux) ([website](https://sentrux.dev/), [docs](https://sentrux.dev/docs/quick-start/)) is a real-time architectural sensor for AI coding agents: a pure-Rust single binary (CLI + MCP server) covering 52 languages via tree-sitter plugins.

It reports a **Quality Signal from 0–10000** — the geometric mean of five normalized root-cause scores, scaled ×10000. The five root causes are **modularity, acyclicity, depth, equality, and redundancy** (see [quality-signal docs](https://sentrux.dev/docs/quality-signal/)).

Sentrux is by the [sentrux organization](https://github.com/sentrux/sentrux) (copyright holder "Sentrux" in its `LICENSE`) and is released under the **MIT license**. This extension targets Sentrux **v0.5.7** (the latest release). Sentrux's own first-run grammar download and daily telemetry ping apply when you use it — see [Network and telemetry](#network-and-telemetry) and opt out with `/sentrux telemetry-off`.

> [!WARNING]
> Never run bare `sentrux`, `sentrux <path>`, or `sentrux scan` — they open a GUI. All Sentrux invocations go through this package's allowlisted `check` / `gate` / `mcp` / `--version` arguments.

Pinned to **v0.5.7**: versions below 0.5.0 are rejected, and any version other than 0.5.7 logs a warning ("parsers verified for 0.5.7").

## Features

- Five `sentrux_*` tools: scan, check-rules, gate, session, and insights.
- `/sentrux` subcommands: `status`, `install`, `restart`, `telemetry-off`.
- A `sentrux` skill playbook (`measure → fix → remeasure`, `rules.toml` reference).
- Opt-in `agent_end` nudge that surfaces quality drops on the next turn.

## Prerequisites

- Node `>=22.19.0` and the pi coding agent (`0.87.1` is the dev dependency; host peer dependencies are `"*"`).
- A Sentrux binary, resolved in this order: `SENTRUX_BIN` → global config `binaryPath` → `PATH` → managed install at `<agentDir>/pi-sentrux/bin/`. A project config may never set `binaryPath`.
- Nothing is downloaded automatically.

## Install

Install the extension:

```sh
pi install git:github.com/G4bar/pi-sentrux
```

For local use:

```sh
pi -e /path/to/pi-sentrux
```

Then, if you have no Sentrux binary yet, run `/sentrux install`. It is opt-in, downloads the pinned v0.5.7 asset for your platform over HTTPS, and verifies its sha256 before installing. Alternatives: `brew install sentrux/tap/sentrux` (macOS arm64 and Linux x86_64 only) or set `SENTRUX_BIN`.

## Tools

All five tools warn about git-untracked files and never change git state. Sentrux reads `git ls-files`, so a new file is invisible until `git add -N` (intent-to-add is enough; nothing is staged by the tools). The warning leads the model text because truncation drops the tail, and `.sentrux/` paths are excluded from it.

- `sentrux_scan` — Quality Signal 0–10000, bottleneck, all five root-cause scores with raw values, and size counts. Every call rescans the whole tree; make one focused change per scan.
- `sentrux_check_rules` — runs `sentrux check` (read-only, all rules, no tier cap). `[[boundaries]]` violations appear **only** here. Violations are grouped per rule with a count; per-edge lines collapse to compact `from → to` lines capped per rule (`… N more`), with the full list in details.
- `sentrux_gate` — on-disk regression gate in `.sentrux/baseline.json`: `save=true` writes the baseline (blocked when `allowBaselineWrite: false`); `save=false` reports `ok` / `degraded` / `no_baseline`. Degraded means quality dropped >200 points, coupling rose >0.05, or cycles / god files / complex functions rose.
- `sentrux_session` — in-memory before/after for this pi session: `start` records a baseline, `end` rescans and diffs, `status` reports whether one exists. The baseline is lost if the server restarts (timeout, abort, or `/sentrux restart`), so the next `end`/`status` reports `lost` with instructions.
- `sentrux_insights` — `dsm`, `test_gaps`, and `git_stats` summaries only. The free tier returns summary counts (`dsm` clusters included; only the ASCII matrix is Pro-gated). When health reports import cycles while the `dsm` interpretation still claims clean layering, a note says so.

> [!TIP]
> Scales: quality and root-cause scores use the primary 0–10000 scale. Sentrux's own 0–1 figures (coupling, gate `reasons`, `coverage_score`) are labeled `(0–1 scale)`. Floats round to 3 significant figures (for example `Gini=0.573`); integer scores and counts print untouched.

## Commands

`/sentrux [status|install|restart|telemetry-off]` (default: `status`).

- `status` — binary path/source/version (plus warning), missing-library list, `~/.sentrux` and opt-out presence, config files in effect, and active servers (root, pid, session state).
- `install` — requires confirmation in the dialog UI, then downloads the pinned v0.5.7 asset to a temp file, verifies sha256, runs `chmod +x`, atomically renames it into the managed cache, and validates `--version`. Assets: `sentrux-linux-x86_64`, `sentrux-linux-aarch64`, `sentrux-darwin-arm64`, `sentrux-windows-x86_64.exe` (no macOS x86_64 asset — use Homebrew or cargo there).
- `restart` — asks for confirmation when any server has a session, closes all servers (baselines are lost), then re-resolves the binary and reports its path and version.
- `telemetry-off` — asks for confirmation, then creates `~/.sentrux/telemetry_opt_out` only. Idempotent; never deletes anything.

## Skill

`skills/sentrux/SKILL.md` is the agent playbook: the signal, the measure→fix→remeasure workflow (stop when gains plateau), root-cause fixes, the `git add -N` rule (ask before staging, never commit), the `rules.toml` reference (constraints, layers, boundaries, glob depth — `dir/*` is shallow-only, `dir/**` covers subtrees), session vs. gate, and limits.

> [!NOTE]
> Verified layer direction: the **higher**-`order` layer must not import the **lower**-`order` layer — the opposite of the upstream docs' plain-language description.

## Configuration

Global config lives at `<agentDir>/pi-sentrux/config.json`. A trusted project's `.pi/sentrux.json` may set only a restricted subset. `SENTRUX_BIN` overrides `binaryPath` alone.

| Key | Default | Project may set | Meaning |
| --- | --- | --- | --- |
| `binaryPath` | — | never | Global-only Sentrux binary path |
| `skipGrammarDownload` | `false` | no | Advanced/unsupported: sets `SENTRUX_SKIP_GRAMMAR_DOWNLOAD=1` in the spawned CLI/MCP process env (with zero cached grammars, scanning likely cannot parse anything) |
| `warmup` | `true` | no | `--version` warm-up at session start (front-loads the grammar download) |
| `cliTimeoutMs` | `300000` | no | CLI timeout (first run may download grammars) |
| `mcpStartTimeoutMs` | `300000` | no | MCP server start timeout |
| `mcpCallTimeoutMs` | `120000` | no | MCP call timeout |
| `maxServers` | `3` | no | Per-root MCP server cap (LRU; session-less handles evicted first) |
| `maxOutputBytes` | `8192` | yes | Model-text truncation budget |
| `maxOutputLines` | `200` | yes | Model-text truncation budget |
| `untrackedWarning` | `true` | yes | Warn about git-untracked files (invisible to Sentrux) |
| `allowBaselineWrite` | `true` | no | Allow `sentrux_gate save=true` to write `.sentrux/baseline.json` |
| `nudge` | `"off"` | yes | `"off"` or `"agent_end"` post-edit quality nudge (opt-in; skipped while a `sentrux_session` baseline is active) |
| `nudgeThreshold` | `200` | yes | Nudge fires when the quality drop is at least this many points, or when the cycle count rises |

## Nudge (opt-in)

With `nudge: "agent_end"`, the extension warms up a pre-edit quality baseline in the background at agent start. The first edit/write call in each run waits for that baseline (at most 30 s, at most once per root per run, interruptible with ESC); later edits reuse it. Only successful `edit`/`write` results mark a root dirty. At agent end, a rescan compares against the baseline and nudges only on a quality drop at or above `nudgeThreshold` or a risen cycle count (at most one nudge per run).

Nudge scans share the per-root MCP server with `sentrux_session`, so they are skipped while a session baseline is active for that root — otherwise a nudge timeout could kill the server and lose the session. The nudge names the root cause whose score fell the most (`worst drop: <cause> (<delta>)`), falling back to the overall bottleneck, with a `Q <score> (<delta>)` status line.

It is delivered as a next-turn message: it appears on the following user turn, never inside a one-shot `--print` run (which exits before delivery).

## Linux: GTK3/X11 runtime libraries

The Linux release binary links GTK3/xcb/xkbcommon libraries **even for CLI/MCP use** — no display server is needed (CLI and MCP work with `DISPLAY` unset), but the shared libraries must be present. A missing library produces an actionable error naming it; for example:

- Debian/Ubuntu: `sudo apt install libgtk-3-0 libxcb-render0 libxcb-shape0 libxcb-xfixes0 libxkbcommon0` (Ubuntu 24.04: `libgtk-3-0t64`)
- Fedora: `sudo dnf install gtk3 libxcb libxkbcommon`

`/sentrux status` also runs `ldd` on Linux when available and lists any `=> not found` lines.

## Network and telemetry

Sentrux has network side effects this package does not hide — a first-run grammar download and a daily version ping — but ordinary `check` / `gate` / scan calls make no network requests of their own:

- **First run:** Sentrux downloads ~30 MB of language grammars into `~/.sentrux/plugins/<lang>/grammars/<platform>.so` (one directory deeper than upstream docs suggest). This blocks the first spawn, so CLI/start timeouts are 5 minutes and the extension warms up with `--version` at session start. The grammar tarball Sentrux fetches itself cannot be checksum-pinned — that download is Sentrux's own, outside this extension's control.
- **Daily ping:** at most once every 24 h, Sentrux calls `https://api.sentrux.dev/version` with version, platform, tier, scan/MCP/gate counts, the file count, and the quality grade (0–10000). The **only** opt-out is the file `~/.sentrux/telemetry_opt_out` — no environment variable disables it. With the file present before the first run, even the first ping is suppressed; the ping and its `last_update_check`/`latest_version` cache never fire, although a local counter file `~/.sentrux/telemetry_pending.json` is still written.
- **Opt out:** run `/sentrux telemetry-off` — it asks for confirmation, then creates the empty `~/.sentrux/telemetry_opt_out` file. Idempotent; never deletes anything.

## Limitations

- Output formats are human text pinned to v0.5.7 fixtures; parsers fail loudly (throw with a capped stderr/stdout tail) on anything else.
- Exit code 1 means both "violations/degraded" and "error" — classification trusts the parsed stdout summary regardless of the exit code; a run the parser cannot recognise throws with a capped stderr tail plus a stdout tail.
- Scans cannot be cancelled: abort/timeout kills the server and loses the session baseline (`session end` then returns `lost`).
- `session_end` re-scans the server's own `scan_root` — one server per root.
- New files are invisible until `git add -N`; the tools never stage anything.
- The bundled grammar tarball is not checksum-pinned by us.
- Publishing needs explicit user approval.

## Development

```sh
npm test
npm run typecheck
SENTRUX_BIN=~/.cache/pi-sentrux-phase0/sentrux-linux-x86_64 npm run test:integration
```

## License

MIT — see [LICENSE](LICENSE).
