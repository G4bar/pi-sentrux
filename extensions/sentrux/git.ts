import { run as defaultRun, type RunResult } from "./process.ts";

export interface UntrackedFilesResult {
  isGitRepo: boolean;
  files: string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Lists untracked files via `git ls-files --others --exclude-standard`. Outside a git repo (or
 * if git itself is missing), returns isGitRepo:false rather than throwing — this probe is purely
 * informational and must never fail the tool call that uses it. */
export async function findUntrackedFiles(
  root: string,
  options: { timeoutMs?: number; run?: typeof defaultRun } = {},
): Promise<UntrackedFilesResult> {
  const run = options.run ?? defaultRun;
  let result: RunResult;
  try {
    // -c core.fsmonitor=false: a repo's own .git/config could set core.fsmonitor to an
    // arbitrary command that `git ls-files` would execute. This probe runs on every tool
    // call, even in untrusted checkouts, so never honor repo-configured fsmonitor.
    result = await run("git", ["-c", "core.fsmonitor=false", "-C", root, "ls-files", "--others", "--exclude-standard", "-z"], {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch {
    return { isGitRepo: false, files: [] };
  }
  if (result.timedOut || result.aborted || result.code !== 0) {
    return { isGitRepo: false, files: [] };
  }
  const files = result.stdout.split("\0").filter((f) => f.length > 0);
  return { isGitRepo: true, files };
}

/** `git add -N <file>` is enough for Sentrux to see a file (it is git-tracked, git-content only).
 * The tools never stage anything themselves, so the message tells the agent to ask the user first.
 * Only the first sample is listed inline: a fresh repo can have thousands of untracked files,
 * and the truncation helper never keeps part of a line, so a full join would drop the warning. */
export function formatUntrackedWarning(files: string[], sampleLimit = 10): string | undefined {
  if (files.length === 0) return undefined;
  const noun = files.length === 1 ? "file" : "files";
  const verb = files.length === 1 ? "is" : "are";
  const shown = files.slice(0, sampleLimit);
  const rest = files.length - shown.length;
  const list = rest > 0 ? `${shown.join(", ")} \u2026 ${rest} more` : shown.join(", ");
  return (
    `⚠ ${files.length} untracked ${noun} ${verb} invisible to Sentrux (git-tracked only): ${list} — ` +
    "ask the user before staging anything, then run `git add -N <file>` to include each one."
  );
}
