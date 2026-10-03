import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildInvocationArgs,
  classifyLinuxLoaderError,
  findBinary,
  formatNotExecutableMessage,
  formatUnparseableVersionMessage,
  validateBinary,
} from "../../extensions/sentrux/runtime/binary.ts";

async function makeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\necho fake\n");
  await chmod(path, 0o755);
}

describe("findBinary discovery order", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sentrux-bin-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prefers configuredPath over SENTRUX_BIN, PATH, and the managed install", async () => {
    const configured = join(dir, "configured-sentrux");
    const envBin = join(dir, "env-sentrux");
    await makeExecutable(configured);
    await makeExecutable(envBin);

    const result = await findBinary({
      configuredPath: configured,
      env: { SENTRUX_BIN: envBin, PATH: "" },
      agentDir: join(dir, "agent"),
      platform: "linux",
    });

    expect(result).toEqual({ path: configured, source: "config" });
  });

  it("ignores relative PATH entries (a relative \".\" must not win the lookup)", async () => {
    const onPath = join(dir, "sentrux");
    await makeExecutable(onPath);

    const result = await findBinary({
      env: { PATH: [".", ""].join(delimiter) },
      agentDir: join(dir, "agent"),
      platform: "linux",
    });

    // Run from `dir` where ./sentrux exists and is executable: the relative entries
    // must still be skipped, so nothing is found (no managed install in this agentDir).
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const skipped = await findBinary({
        env: { PATH: "." },
        agentDir: join(dir, "agent"),
        platform: "linux",
      });
      expect(skipped).toBeUndefined();
    } finally {
      process.chdir(cwd);
    }
    expect(result).toBeUndefined();
  });

  it("falls back to SENTRUX_BIN when no configuredPath is set", async () => {
    const envBin = join(dir, "env-sentrux");
    await makeExecutable(envBin);

    const result = await findBinary({
      env: { SENTRUX_BIN: envBin, PATH: "" },
      agentDir: join(dir, "agent"),
      platform: "linux",
    });

    expect(result).toEqual({ path: envBin, source: "env" });
  });

  it("a project config can never set binaryPath, so falls through to PATH", async () => {
    // Simulates the caller: config.ts's project-config filter never lets `configuredPath`
    // be populated from a project file, so a "malicious" project path never reaches here.
    const pathDir = join(dir, "bin");
    await mkdir(pathDir);
    const onPath = join(pathDir, "sentrux");
    await makeExecutable(onPath);

    const result = await findBinary({
      configuredPath: undefined,
      env: { PATH: pathDir },
      agentDir: join(dir, "agent"),
      platform: "linux",
    });

    expect(result).toEqual({ path: onPath, source: "path" });
  });

  it("scans PATH directories in order and skips non-executable entries", async () => {
    const badDir = join(dir, "bad");
    const goodDir = join(dir, "good");
    await mkdir(badDir);
    await mkdir(goodDir);
    await writeFile(join(badDir, "sentrux"), "not executable");
    const goodBin = join(goodDir, "sentrux");
    await makeExecutable(goodBin);

    const result = await findBinary({
      env: { PATH: [badDir, goodDir].join(delimiter) },
      agentDir: join(dir, "agent"),
      platform: "linux",
    });

    expect(result).toEqual({ path: goodBin, source: "path" });
  });

  it("falls back to the managed install path", async () => {
    const agentDir = join(dir, "agent");
    const managedPath = join(agentDir, "pi-sentrux", "bin", "sentrux-v0.5.7-linux-x86_64");
    await mkdir(join(agentDir, "pi-sentrux", "bin"), { recursive: true });
    await makeExecutable(managedPath);

    const result = await findBinary({
      env: { PATH: "" },
      agentDir,
      platform: "linux",
      arch: "x64",
    });

    expect(result).toEqual({ path: managedPath, source: "managed" });
  });

  it("returns undefined when nothing is found anywhere", async () => {
    const result = await findBinary({
      env: { PATH: "" },
      agentDir: join(dir, "agent"),
      platform: "linux",
    });
    expect(result).toBeUndefined();
  });
});

describe("EACCES classification", () => {
  it("classifies a spawn EACCES error into an actionable chmod message", async () => {
    const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const run = async (): Promise<never> => {
      throw err;
    };
    await expect(validateBinary({ path: "/opt/sentrux", source: "config" }, { run })).rejects.toThrow(
      formatNotExecutableMessage("/opt/sentrux"),
    );
  });

  it("rethrows unrelated spawn errors unchanged", async () => {
    const err = Object.assign(new Error("boom"), { code: "EPIPE" });
    const run = async (): Promise<never> => {
      throw err;
    };
    await expect(validateBinary({ path: "/opt/sentrux", source: "config" }, { run })).rejects.toBe(err);
  });
});

describe("classifyLinuxLoaderError", () => {
  it("extracts the missing library from a synthetic ld.so stderr line", () => {
    const stderr =
      "sentrux: error while loading shared libraries: libgtk-3.so.0: cannot open shared object file: No such file or directory";
    const message = classifyLinuxLoaderError(stderr);
    expect(message).toContain("`libgtk-3.so.0` is missing");
    expect(message).toContain("sudo apt install libgtk-3-0 libxcb-render0 libxcb-shape0 libxcb-xfixes0 libxkbcommon0");
    expect(message).toContain("libgtk-3-0t64");
    expect(message).toContain("sudo dnf install gtk3 libxcb libxkbcommon");
    expect(message).toContain("No display server is needed.");
  });

  it("returns undefined for unrelated stderr", () => {
    expect(classifyLinuxLoaderError("some other error\n")).toBeUndefined();
    expect(classifyLinuxLoaderError("")).toBeUndefined();
  });

  it("is applied by validateBinary only on a completed (non-throwing) run", async () => {
    const stderr =
      "error while loading shared libraries: libxcb-render.so.0: cannot open shared object file: No such file or directory";
    const run = async () => ({ code: 127, stdout: "", stderr, timedOut: false, aborted: false });
    await expect(validateBinary({ path: "/opt/sentrux", source: "path" }, { run, platform: "linux" })).rejects.toThrow(
      "`libxcb-render.so.0` is missing",
    );
  });
});

describe("formatUnparseableVersionMessage cap", () => {
  it("caps a huge stdout so the thrown error stays within budget", () => {
    const message = formatUnparseableVersionMessage("x".repeat(100_000), "oops");
    expect(message.length).toBeLessThanOrEqual(8100);
    expect(message).toContain("[truncated]");
  });

  it("leaves short output unchanged", () => {
    const message = formatUnparseableVersionMessage("sentrux huh\n", "");
    expect(message).toContain("sentrux huh");
    expect(message).not.toContain("[truncated]");
  });
});

describe("buildInvocationArgs allowlist", () => {
  it("builds exact argv for every allowlisted kind", () => {
    expect(buildInvocationArgs("version")).toEqual(["--version"]);
    expect(buildInvocationArgs("mcp")).toEqual(["mcp"]);
    expect(buildInvocationArgs("check", "/repo")).toEqual(["check", "/repo"]);
    expect(buildInvocationArgs("gate", "/repo")).toEqual(["gate", "/repo"]);
    expect(buildInvocationArgs("gateSave", "/repo")).toEqual(["gate", "--save", "/repo"]);
  });

  it("cannot express GUI argv: root-requiring kinds refuse a missing root and unknown kinds throw", () => {
    expect(() => buildInvocationArgs("check" as never, undefined as never)).toThrow(/root is required/);
    expect(() => buildInvocationArgs("gui" as never)).toThrow(/Unknown invocation kind/);
  });
});
