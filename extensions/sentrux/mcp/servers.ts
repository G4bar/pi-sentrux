import type { McpClientLike } from "./types.ts";

const DEFAULT_MAX_SERVERS = 3;
const DEFAULT_CLOSE_ALL_TIMEOUT_MS = 3000;

/** Local record of a sentrux_session baseline, kept alongside the handle it was recorded on. */
export interface SessionBaseline {
  startedAt: number;
  qualityAtStart: number;
}

export interface ServerHandleInfo {
  generation: number;
  hasSession: boolean;
  lostSession: boolean;
  lastUsed: number;
  pid: number | undefined;
  sessionBaseline: SessionBaseline | undefined;
  /** Whether the underlying process is currently running. Evicted/closed handles keep
   * their last-known entry (pid, generation) for observability, so callers must check
   * this instead of assuming a listed handle is live. */
  alive: boolean;
}

interface ServerHandle {
  client: McpClientLike;
  generation: number;
  hasSession: boolean;
  lostSession: boolean;
  lastUsed: number;
  sessionBaseline?: SessionBaseline;
}

export interface McpServerRegistryOptions {
  createClient: (root: string) => McpClientLike;
  /** Read on every new-root spawn, so a config reload takes effect without recreating the registry. */
  maxServers?: () => number;
}

/**
 * One MCP server process per real root, keyed by root path. `session_end` re-scans the
 * server's own scan_root, so sharing one process across roots would silently measure the
 * wrong directory; hence a per-root map rather than a pool.
 */
export class McpServerRegistry {
  private readonly handles = new Map<string, ServerHandle>();
  /** Clients detached by closeAll whose close() has not settled; still reachable by killAllSync. */
  private readonly closing = new Set<McpClientLike>();

  constructor(private readonly options: McpServerRegistryOptions) {}

  private countAlive(excludeRoot?: string): number {
    let n = 0;
    for (const [root, handle] of this.handles) {
      if (root === excludeRoot) continue;
      if (handle.client.isAlive) n++;
    }
    return n;
  }

  private evictOneFor(excludeRoot: string): void {
    const candidates = [...this.handles.entries()].filter(([root, h]) => root !== excludeRoot && h.client.isAlive);
    if (candidates.length === 0) return;
    const sessionless = candidates.filter(([, h]) => !h.hasSession);
    const pool = sessionless.length > 0 ? sessionless : candidates;
    pool.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const victim = pool[0][1];
    if (victim.hasSession) victim.lostSession = true;
    void victim.client.close();
  }

  private ensureHandle(root: string): ServerHandle {
    const existing = this.handles.get(root);
    if (existing) return existing;

    const max = this.options.maxServers?.() ?? DEFAULT_MAX_SERVERS;
    if (this.countAlive() >= max) this.evictOneFor(root);

    const client = this.options.createClient(root);
    const handle: ServerHandle = { client, generation: client.generation, hasSession: false, lostSession: false, lastUsed: Date.now() };
    this.handles.set(root, handle);
    return handle;
  }

  /** Spawns lazily on first use. Returns the live client for `root`, respawning it first if it died. */
  async getClient(root: string): Promise<McpClientLike> {
    const handle = this.ensureHandle(root);
    handle.lastUsed = Date.now();
    await handle.client.start();
    if (handle.client.generation !== handle.generation) {
      if (handle.hasSession) handle.lostSession = true;
      handle.hasSession = false;
      handle.sessionBaseline = undefined;
      handle.generation = handle.client.generation;
    }
    return handle.client;
  }

  /** Records that `session_start` succeeded for `root`, for eviction/lostSession bookkeeping. */
  markSessionStarted(root: string, baseline?: SessionBaseline): void {
    const handle = this.handles.get(root);
    if (!handle) return;
    handle.hasSession = true;
    handle.lostSession = false;
    handle.generation = handle.client.generation;
    handle.sessionBaseline = baseline;
  }

  getHandleInfo(root: string): ServerHandleInfo | undefined {
    const handle = this.handles.get(root);
    if (!handle) return undefined;
    return {
      generation: handle.generation,
      hasSession: handle.hasSession,
      lostSession: handle.lostSession,
      lastUsed: handle.lastUsed,
      pid: handle.client.pid,
      sessionBaseline: handle.sessionBaseline,
      alive: handle.client.isAlive,
    };
  }

  /** Lists every root with a live or last-known handle, for `/sentrux status`. */
  listHandles(): Array<{ root: string } & ServerHandleInfo> {
    return [...this.handles.keys()].map((root) => ({ root, ...this.getHandleInfo(root)! }));
  }

  async closeAll(timeoutMs = DEFAULT_CLOSE_ALL_TIMEOUT_MS): Promise<void> {
    const clients = [...this.handles.values()].map((h) => h.client);
    this.handles.clear();
    for (const c of clients) this.closing.add(c);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(clients.map((c) => c.close().finally(() => this.closing.delete(c)))),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Synchronous best-effort kill for a `process.once("exit", ...)` safety net. */
  killAllSync(): void {
    for (const handle of this.handles.values()) {
      handle.client.forceKillSync();
    }
    for (const client of this.closing) {
      client.forceKillSync();
    }
  }
}
