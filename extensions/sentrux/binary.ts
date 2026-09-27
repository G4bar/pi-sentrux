import { access, constants as fsConstants, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { run as defaultRun, type RunResult } from "./process.ts";
import { capThrownMessage } from "./format.ts";

export type BinarySource = "config" | "env" | "path" | "managed";

export interface BinaryLocation {
  path: string;
  source: BinarySource;
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pro: boolean;
  raw: string;
}

export interface BinaryStatus {
  path: string;
  source: BinarySource;
  version: ParsedVersion;
  versionWarning?: string;
}

type RunFn = (cmd: string, args: string[], opts: { timeoutMs?: number }) => Promise<RunResult>;

const VERIFIED_VERSION = { major: 0, minor: 5, patch: 7 };
const MIN_SUPPORTED_VERSION = { major: 0, minor: 5, patch: 0 };

const VERSION_RE = /^sentrux (\d+)\.(\d+)\.(\d+)( \(Pro\))?/;
const GTK_MISSING_LIB_RE = /error while loading shared libraries: ([^:]+): cannot open shared object file/;

export const NOT_FOUND_MESSAGE =
  "Sentrux binary not found. Install v0.5.7: `brew install sentrux/tap/sentrux`, a release binary " +
  "(https://github.com/sentrux/sentrux/releases/tag/v0.5.7), or run `/sentrux install`; or set SENTRUX_BIN.";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(pathEnv: string | undefined, platform: NodeJS.Platform): Promise<string | undefined> {
  if (!pathEnv) return undefined;
  const exeName = platform === "win32" ? "sentrux.exe" : "sentrux";
  for (const dir of pathEnv.split(delimiter)) {
    // Skip empty and relative entries (notably a relative "."): resolving the
    // binary against the caller's cwd would let any directory win the lookup.
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, exeName);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export const MANAGED_SENTRUX_VERSION = "0.5.7";

const ASSET_ARCH: Partial<Record<string, string>> = { x64: "x86_64", arm64: "arm64" };

/**
 * Managed-cache asset suffix. Reconciled with install.ts's pinned release
 * table (Phase 6): the suffix matches the real v0.5.7 release asset name
 * minus the `sentrux-` prefix (`sentrux-linux-x86_64`,
 * `sentrux-linux-aarch64`, `sentrux-darwin-arm64`,
 * `sentrux-windows-x86_64.exe`). The one exception is the `sentrux-v0.5.7-`
 * filename prefix, which is our own cache namespacing, not upstream.
 * linux/arm64 maps to the upstream `aarch64` arch name; darwin uses the
 * upstream `darwin-` OS name (not `macos-`).
 */
export function managedAssetName(platform: NodeJS.Platform, arch: string): string {
  const key = `${platform}-${arch}`;
  switch (key) {
    case "linux-x64":
      return "linux-x86_64";
    case "linux-arm64":
      return "linux-aarch64";
    case "darwin-arm64":
      return "darwin-arm64";
    case "win32-x64":
      return "windows-x86_64.exe";
    default: {
      const assetArch = ASSET_ARCH[arch] ?? arch;
      if (platform === "win32") return `windows-${assetArch}.exe`;
      if (platform === "darwin") return `darwin-${assetArch}`;
      return `linux-${assetArch}`;
    }
  }
}

export function managedInstallPath(agentDir: string, platform?: NodeJS.Platform, arch?: string): string {
  return join(agentDir, "pi-sentrux", "bin", `sentrux-v${MANAGED_SENTRUX_VERSION}-${managedAssetName(platform ?? process.platform, arch ?? process.arch)}`);
}

export interface FindBinaryOptions {
  configuredPath?: string;
  env: NodeJS.ProcessEnv;
  agentDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

/**
 * Search order: configured (global-config) path, then SENTRUX_BIN, then PATH,
 * then the managed install location. A project config can never contribute
 * `configuredPath` (enforced by config.ts's key filter, not here).
 */
export async function findBinary(options: FindBinaryOptions): Promise<BinaryLocation | undefined> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  if (options.configuredPath && (await pathExists(options.configuredPath))) {
    return { path: options.configuredPath, source: "config" };
  }

  const envPath = options.env.SENTRUX_BIN;
  if (envPath && (await pathExists(envPath))) {
    return { path: envPath, source: "env" };
  }

  const pathHit = await findOnPath(options.env.PATH, platform);
  if (pathHit) return { path: pathHit, source: "path" };

  const managedPath = managedInstallPath(options.agentDir, platform, arch);
  if (await pathExists(managedPath)) {
    return { path: managedPath, source: "managed" };
  }

  return undefined;
}

export function parseVersionOutput(stdout: string): ParsedVersion | undefined {
  const match = VERSION_RE.exec(stdout.trimStart());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pro: match[4] !== undefined,
    raw: match[0],
  };
}

function compareVersions(a: ParsedVersion, b: { major: number; minor: number; patch: number }): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function isBelowMinimumVersion(v: ParsedVersion): boolean {
  return compareVersions(v, MIN_SUPPORTED_VERSION) < 0;
}

export function isVerifiedVersion(v: ParsedVersion): boolean {
  return compareVersions(v, VERIFIED_VERSION) === 0;
}

export function classifyLinuxLoaderError(stderr: string): string | undefined {
  const match = GTK_MISSING_LIB_RE.exec(stderr);
  if (!match) return undefined;
  const lib = match[1];
  return (
    `Sentrux cannot start: its Linux release binary links GTK3/X11 libraries even for CLI/MCP use, and \`${lib}\` is missing. ` +
    "Install the runtime libraries — Debian/Ubuntu: `sudo apt install libgtk-3-0 libxcb-render0 libxcb-shape0 libxcb-xfixes0 libxkbcommon0` " +
    "(Ubuntu 24.04: `libgtk-3-0t64`); Fedora: `sudo dnf install gtk3 libxcb libxkbcommon` — then run `/sentrux status`. No display server is needed."
  );
}

export function formatNotExecutableMessage(path: string): string {
  return `\`${path}\` is not executable (chmod +x).`;
}

export function formatBelowMinimumMessage(v: ParsedVersion): string {
  return `Sentrux ${v.major}.${v.minor}.${v.patch} is below the minimum supported version 0.5.0.`;
}

export function formatVersionMismatchWarning(v: ParsedVersion): string {
  return `Sentrux ${v.major}.${v.minor}.${v.patch} detected; parsers verified for 0.5.7 only.`;
}

function stderrTail(stderr: string, maxLines = 5): string {
  const lines = stderr.split("\n").filter((line) => line.length > 0);
  return lines.slice(-maxLines).join("\n");
}

export function formatUnparseableVersionMessage(stdout: string, stderr: string): string {
  const tail = stderrTail(stderr);
  // stdout is included whole for debuggability but the host passes
  // error.message verbatim, so cap it like every other thrown error.
  return capThrownMessage(`Could not parse "sentrux --version" output.\nstdout: ${stdout.trim()}${tail ? `\nstderr (tail): ${tail}` : ""}`);
}

export interface ValidateBinaryOptions {
  timeoutMs?: number;
  run?: RunFn;
  platform?: NodeJS.Platform;
}

export async function validateBinary(location: BinaryLocation, options: ValidateBinaryOptions = {}): Promise<BinaryStatus> {
  const runFn = options.run ?? defaultRun;
  const platform = options.platform ?? process.platform;

  let result: RunResult;
  try {
    result = await runFn(location.path, ["--version"], { timeoutMs: options.timeoutMs ?? 300_000 });
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === "EACCES") {
      throw new Error(formatNotExecutableMessage(location.path));
    }
    throw err;
  }

  if (platform === "linux") {
    const loaderError = classifyLinuxLoaderError(result.stderr);
    if (loaderError) throw new Error(loaderError);
  }

  const version = parseVersionOutput(result.stdout);
  if (!version) {
    throw new Error(formatUnparseableVersionMessage(result.stdout, result.stderr));
  }
  if (isBelowMinimumVersion(version)) {
    throw new Error(formatBelowMinimumMessage(version));
  }

  const status: BinaryStatus = { path: location.path, source: location.source, version };
  if (!isVerifiedVersion(version)) {
    status.versionWarning = formatVersionMismatchWarning(version);
  }
  return status;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  status: BinaryStatus;
}

const statusCache = new Map<string, CacheEntry>();

export function clearBinaryStatusCache(): void {
  statusCache.clear();
}

export interface ResolveBinaryOptions extends FindBinaryOptions {
  cliTimeoutMs?: number;
  run?: RunFn;
}

export async function resolveBinary(options: ResolveBinaryOptions): Promise<BinaryStatus> {
  const location = await findBinary(options);
  if (!location) {
    throw new Error(NOT_FOUND_MESSAGE);
  }

  let stats: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    stats = await stat(location.path);
  } catch {
    stats = undefined;
  }
  if (stats) {
    const cached = statusCache.get(location.path);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.status;
    }
  }

  const status = await validateBinary(location, { timeoutMs: options.cliTimeoutMs, run: options.run });

  if (stats) {
    statusCache.set(location.path, { mtimeMs: stats.mtimeMs, size: stats.size, status });
  }

  return status;
}

export type InvocationKind = "version" | "check" | "gate" | "gateSave" | "mcp";

/** Allowlisted argv builder. There is no way to construct GUI argv through this function. */
export function buildInvocationArgs(kind: "version" | "mcp"): string[];
export function buildInvocationArgs(kind: "check" | "gate" | "gateSave", root: string): string[];
export function buildInvocationArgs(kind: InvocationKind, root?: string): string[] {
  switch (kind) {
    case "version":
      return ["--version"];
    case "mcp":
      return ["mcp"];
    case "check":
      return ["check", requireRoot(kind, root)];
    case "gate":
      return ["gate", requireRoot(kind, root)];
    case "gateSave":
      return ["gate", "--save", requireRoot(kind, root)];
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown invocation kind: ${String(exhaustive)}`);
    }
  }
}

function requireRoot(kind: string, root: string | undefined): string {
  if (!root) throw new Error(`root is required for invocation kind "${kind}"`);
  return root;
}

export async function findMissingSharedLibraries(
  binPath: string,
  options: { timeoutMs?: number; run?: RunFn; platform?: NodeJS.Platform } = {},
): Promise<string[] | undefined> {
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  const runFn = options.run ?? defaultRun;
  try {
    const result = await runFn("ldd", [binPath], { timeoutMs: options.timeoutMs ?? 10_000 });
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("=> not found"));
  } catch {
    return undefined;
  }
}
