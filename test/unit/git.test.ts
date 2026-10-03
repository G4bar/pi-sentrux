import { describe, expect, it } from "vitest";
import { findUntrackedFiles, formatUntrackedWarning } from "../../extensions/sentrux/runtime/git.ts";

describe("findUntrackedFiles", () => {
  it("passes -c core.fsmonitor=false so a repo config cannot run commands", async () => {
    let seenArgs: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      seenArgs = args;
      return { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
    };
    const result = await findUntrackedFiles("/repo", { run: run as never });
    expect(result).toEqual({ isGitRepo: true, files: [] });
    expect(seenArgs.slice(0, 4)).toEqual(["-c", "core.fsmonitor=false", "-C", "/repo"]);
    expect(seenArgs).toContain("ls-files");
  });

  it("returns isGitRepo:false when git itself is missing", async () => {
    const run = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    await expect(findUntrackedFiles("/repo", { run: run as never })).resolves.toEqual({ isGitRepo: false, files: [] });
  });

  it("excludes .sentrux/ config paths from the untracked list", async () => {
    const run = async () => ({
      code: 0,
      stdout: ".sentrux/rules.toml\0.sentrux/baseline.json\0src/a.ts\0",
      stderr: "",
      timedOut: false,
      aborted: false,
    });
    await expect(findUntrackedFiles("/repo", { run: run as never })).resolves.toEqual({
      isGitRepo: true,
      files: ["src/a.ts"],
    });
    expect(formatUntrackedWarning(["src/a.ts"])!).not.toContain(".sentrux");
  });
});

describe("formatUntrackedWarning", () => {
  it("returns undefined for no files", () => {
    expect(formatUntrackedWarning([])).toBeUndefined();
  });

  it("lists a handful of files inline", () => {
    const warning = formatUntrackedWarning(["a.ts", "b.ts"])!;
    expect(warning).toContain("a.ts, b.ts");
    expect(warning).not.toContain("more");
    expect(warning).toContain("git add -N");
  });

  it("truncates a long list as \"… N more\" so the line survives truncation", () => {
    const files = Array.from({ length: 2000 }, (_, i) => `file-${i}.ts`);
    const warning = formatUntrackedWarning(files)!;
    expect(warning).toContain("2000 untracked files");
    expect(warning).toContain("… 1990 more");
    expect(warning).toContain("file-0.ts");
    expect(warning).not.toContain("file-1999.ts");
  });
});
