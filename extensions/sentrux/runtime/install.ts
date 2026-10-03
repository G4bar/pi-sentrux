import { createHash, type Hash } from "node:crypto";
import { access, chmod, mkdir, open, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { managedInstallPath, validateBinary } from "./binary.ts";
import { run as defaultRun, type RunResult } from "./process.ts";

export const SENTRUX_PINNED_VERSION = "0.5.7";
export const RELEASE_BASE_URL = `https://github.com/sentrux/sentrux/releases/download/v${SENTRUX_PINNED_VERSION}`;

export const INSTALL_TIMEOUT_MS = 300_000;
export const INSTALL_MAX_BYTES = 200 * 1024 * 1024;

export interface ReleaseEntry {
  asset: string;
  sha256: string;
  url: string;
}

/**
 * Pinned v0.5.7 release table (§3.1, Phase 6). Key is
 * `${process.platform}-${process.arch}`. There is no macOS x86_64 asset.
 * Checksums are the digests GitHub publishes per asset on the release page
 * (verified against https://github.com/sentrux/sentrux/releases/expanded_assets/v0.5.7);
 * never guess a checksum — an unverifiable platform stays unsupported.
 */
export const RELEASE_TABLE: Record<string, ReleaseEntry> = {
  "linux-x64": {
    asset: "sentrux-linux-x86_64",
    sha256: "3237f80fe20d54aad4deefa8a143f0d60543bb5d2d6ad891eb42432f155725a6",
    url: `${RELEASE_BASE_URL}/sentrux-linux-x86_64`,
  },
  "linux-arm64": {
    asset: "sentrux-linux-aarch64",
    sha256: "27e1b4a3e4716b341dd76e9736a5553c6737c24e165cc27e0dbc399cc5b4d786",
    url: `${RELEASE_BASE_URL}/sentrux-linux-aarch64`,
  },
  "darwin-arm64": {
    asset: "sentrux-darwin-arm64",
    sha256: "30ae1a44d4478adf294019fce6d65ce5686c25bc863eb715b320c5234927f6c2",
    url: `${RELEASE_BASE_URL}/sentrux-darwin-arm64`,
  },
  "win32-x64": {
    asset: "sentrux-windows-x86_64.exe",
    sha256: "40dd2e47804bf9f006015eb742abfe178a824f42d4a19eb00478a7d705697cac",
    url: `${RELEASE_BASE_URL}/sentrux-windows-x86_64.exe`,
  },
};

export function platformKey(platform?: NodeJS.Platform, arch?: string): string {
  return `${platform ?? process.platform}-${arch ?? process.arch}`;
}

export function getReleaseEntry(platform?: NodeJS.Platform, arch?: string): ReleaseEntry | undefined {
  return RELEASE_TABLE[platformKey(platform, arch)];
}

export function formatUnsupportedPlatformMessage(platform?: NodeJS.Platform, arch?: string): string {
  const key = platformKey(platform, arch);
  return (
    `Sentrux v${SENTRUX_PINNED_VERSION} has no release asset for ${key}. ` +
    "Try `brew install sentrux/tap/sentrux` (macOS arm64 and Linux x86_64) or build from source with cargo " +
    "(https://github.com/sentrux/sentrux)."
  );
}

export function installTargetPath(agentDir: string, platform?: NodeJS.Platform, arch?: string): string {
  // Single source of truth for the managed-cache filename lives in binary.ts;
  // install.ts owns the release (URL/sha) table. This keeps the two reconciled by construction.
  return managedInstallPath(agentDir, platform, arch);
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type RunFn = (cmd: string, args: string[], opts: { timeoutMs?: number }) => Promise<RunResult>;

export interface InstallBinaryOptions {
  agentDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Test-only seam: overrides the pinned-table entry (URL + expected sha). */
  entry?: ReleaseEntry;
  fetchFn?: FetchFn;
  run?: RunFn;
  /** Caller abort (e.g. the command's signal). Combined with the install timeout. */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface InstallBinaryResult {
  path: string;
  asset: string;
  url: string;
  version: string;
}

function tempPathFor(target: string): string {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  return join(dirname(target), `.${basename(target)}.tmp-${suffix}`);
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

function assertWithinLimit(bytes: number, maxBytes: number, url: string): void {
  if (bytes > maxBytes) {
    throw new Error(`download exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit (${url})`);
  }
}

async function writeBody(
  response: Response,
  handle: FileHandle,
  hash: Hash,
  maxBytes: number,
  url: string,
): Promise<void> {
  let bytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        bytes += buf.length;
        assertWithinLimit(bytes, maxBytes, url);
        hash.update(buf);
        await handle.write(buf);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    const buf = Buffer.from(await response.arrayBuffer());
    bytes = buf.length;
    assertWithinLimit(bytes, maxBytes, url);
    hash.update(buf);
    await handle.write(buf);
  }
}

async function downloadToTemp(
  fetchFn: FetchFn,
  entry: ReleaseEntry,
  temp: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetchFn(entry.url, { signal, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} for ${entry.url}`);
  }
  const hash = createHash("sha256");
  const handle = await open(temp, "wx");
  try {
    await writeBody(response, handle, hash, maxBytes, entry.url);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function verifyChecksum(actual: string, entry: ReleaseEntry, temp: string): Promise<void> {
  if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
    await removeIfExists(temp);
    throw new Error(`checksum mismatch (expected ${entry.sha256}, got ${actual})`);
  }
}

/**
 * Download the pinned v0.5.7 asset for this platform over HTTPS into a temp
 * file in the target directory, verify its sha256 while streaming, chmod +x,
 * then rename atomically into the managed cache and validate `--version`.
 * Never runs automatically — only the `/sentrux install` handler calls this.
 */
export async function installBinary(options: InstallBinaryOptions): Promise<InstallBinaryResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const entry = options.entry ?? getReleaseEntry(platform, arch);
  if (!entry) {
    throw new Error(formatUnsupportedPlatformMessage(platform, arch));
  }

  const fetchFn: FetchFn = options.fetchFn ?? globalThis.fetch;
  const runFn: RunFn = options.run ?? defaultRun;
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? INSTALL_MAX_BYTES;

  const target = installTargetPath(options.agentDir, platform, arch);
  await mkdir(dirname(target), { recursive: true });
  // The awaits above yield; the caller's signal may have fired while the
  // abort listener was not yet attached, so re-check before downloading.
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error ? options.signal.reason : new Error("install aborted");
  }
  const temp = tempPathFor(target);

  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort(options.signal?.reason);
  // The aborted-signal guard above already threw, and everything between it and
  // here is synchronous, so the signal cannot newly be aborted at this point:
  // attach the listener and arm the timeout unconditionally.
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  timeoutTimer = setTimeout(() => {
    controller.abort(new Error(`install timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  timeoutTimer.unref?.();

  try {
    const actual = await downloadToTemp(fetchFn, entry, temp, maxBytes, controller.signal);
    await verifyChecksum(actual, entry, temp);

    await chmod(temp, 0o755);
    await rename(temp, target);

    const status = await validateBinary({ path: target, source: "managed" }, { run: runFn, platform });
    return {
      path: target,
      asset: entry.asset,
      url: entry.url,
      version: `sentrux ${status.version.major}.${status.version.minor}.${status.version.patch}`,
    };
  } catch (err) {
    if (controller.signal.aborted && options.signal?.aborted) {
      await removeIfExists(temp);
      throw options.signal.reason instanceof Error ? options.signal.reason : err;
    }
    // Leave a successfully renamed target in place even if --version validation
    // failed (the user can inspect/retry); the temp file itself is always removed.
    // (After a successful rename the temp path no longer exists, so this is a no-op
    // that preserves the target.)
    await removeIfExists(temp).catch(() => {});
    throw err;
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

export function telemetryOptOutPath(homeDir: string = homedir()): string {
  return join(homeDir, ".sentrux", "telemetry_opt_out");
}

/**
 * D4 telemetry opt-out: create the empty `~/.sentrux/telemetry_opt_out` file.
 * Idempotent (an existing file is left untouched and still succeeds) and never
 * deletes anything.
 */
export async function ensureTelemetryOptOut(homeDir: string = homedir()): Promise<{ path: string; alreadyExisted: boolean }> {
  await mkdir(join(homeDir, ".sentrux"), { recursive: true });
  const path = telemetryOptOutPath(homeDir);
  try {
    await access(path);
    return { path, alreadyExisted: true };
  } catch {
    try {
      await writeFile(path, "", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
        return { path, alreadyExisted: true };
      }
      throw err;
    }
    return { path, alreadyExisted: false };
  }
}
