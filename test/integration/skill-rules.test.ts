import { execFile } from "node:child_process";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const SENTRUX_BIN = process.env.SENTRUX_BIN;
const SKILL_PATH = join(import.meta.dirname, "..", "..", "skills", "sentrux", "SKILL.md");
const MAKE_FIXTURE_REPO = join(import.meta.dirname, "..", "fixtures", "v0.5.7", "make-fixture-repo.sh");

function extractTomlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /```toml\n(.*?)\n```/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const m = /^---\n(.*?)\n---\n/s.exec(markdown);
  expect(m, "SKILL.md must start with YAML frontmatter").not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of m![1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

describe.skipIf(!SENTRUX_BIN)("skill rules.toml examples (real binary)", () => {
  const roots: string[] = [];

  afterAll(async () => {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function makeFixtureRoot(): Promise<string> {
    const target = join(tmpdir(), `sentrux-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    execFileSync("bash", [MAKE_FIXTURE_REPO, target], { stdio: "pipe" });
    roots.push(target);
    return target;
  }

  async function runCheck(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(SENTRUX_BIN!, ["check", root], { timeout: 120_000 });
      return { code: 0, stdout, stderr };
    } catch (err: any) {
      return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  it("has valid pi skill frontmatter", async () => {
    const text = await readFile(SKILL_PATH, "utf8");
    const fm = parseFrontmatter(text);
    expect(fm.name).toBe("sentrux");
    expect(fm.description).toMatch(/sentrux_\*/);
    expect(fm.description).toMatch(/rules\.toml/);
    expect(fm.description.length).toBeGreaterThan(20);
    expect(fm.description.length).toBeLessThanOrEqual(1024);
  });

  it("every ```toml block parses with `sentrux check` on the fixture repo", async () => {
    const text = await readFile(SKILL_PATH, "utf8");
    const blocks = extractTomlBlocks(text);
    // Layers-only, boundaries-only, starter template.
    expect(blocks).toHaveLength(3);

    for (const [i, block] of blocks.entries()) {
      const root = await makeFixtureRoot();
      await mkdir(join(root, ".sentrux"), { recursive: true });
      await writeFile(join(root, ".sentrux", "rules.toml"), block.endsWith("\n") ? block : block + "\n");
      const { stdout, stderr } = await runCheck(root);
      expect(stderr, `block ${i} must not fail TOML parsing`).not.toMatch(/Failed to parse/);
      expect(stdout, `block ${i} must report a rule count and quality`).toMatch(/rules checked/);
      expect(stdout, `block ${i} must report a quality score`).toMatch(/Quality: \d+/);
    }
    // Three sequential real-binary checks take ~4.5s, too close to vitest's 5s default.
  }, 30_000);

  it("layers example flags only the higher-order app importing the lower-order core (P0-L)", async () => {
    const text = await readFile(SKILL_PATH, "utf8");
    const blocks = extractTomlBlocks(text);
    const root = await makeFixtureRoot();
    await mkdir(join(root, ".sentrux"), { recursive: true });
    await writeFile(join(root, ".sentrux", "rules.toml"), blocks[0].endsWith("\n") ? blocks[0] : blocks[0] + "\n");
    const { stdout } = await runCheck(root);
    expect(stdout).toContain("1 rules checked");
    expect(stdout).toContain("layer_direction");
    expect(stdout).toContain("app must not depend on core");
    expect(stdout).toContain("src/app/uses_core.ts");
    // The shallow `*` glob does not match the nested path: only one violation.
    expect(stdout).toContain("1 violation(s) found");
    expect(stdout).not.toContain("uses_nested_core.ts");
  });

  it("boundaries example is reported by the CLI check", async () => {
    const text = await readFile(SKILL_PATH, "utf8");
    const blocks = extractTomlBlocks(text);
    const root = await makeFixtureRoot();
    await mkdir(join(root, ".sentrux"), { recursive: true });
    await writeFile(join(root, ".sentrux", "rules.toml"), blocks[1].endsWith("\n") ? blocks[1] : blocks[1] + "\n");
    const { stdout } = await runCheck(root);
    expect(stdout).toContain("1 rules checked");
    expect(stdout).toContain("boundary");
    expect(stdout).toContain("src/core/uses_app.ts");
  });

  it("starter template uses ** for subtrees (nested imports flagged, unlike * above)", async () => {
    const text = await readFile(SKILL_PATH, "utf8");
    const blocks = extractTomlBlocks(text);
    const root = await makeFixtureRoot();
    await mkdir(join(root, ".sentrux"), { recursive: true });
    await writeFile(join(root, ".sentrux", "rules.toml"), blocks[2].endsWith("\n") ? blocks[2] : blocks[2] + "\n");
    const { stdout, stderr } = await runCheck(root);
    expect(stderr).not.toMatch(/Failed to parse/);
    // 5 constraints (min_quality is numeric so always counted, no_god_files=true)
    // + 1 collapsed layer_direction + 1 boundary = 7 rules checked.
    expect(stdout).toContain("7 rules checked");
    expect(stdout).toContain("layer_direction");
    expect(stdout).toContain("boundary");
    // Proof that `**` covers one level deeper where `*` did not.
    expect(stdout).toContain("uses_nested_core.ts");
    expect(stdout).toContain("uses_nested_app.ts");
  });

});
