// Leaf type module: no imports, so importing it never deepens the import graph.
/** The subset of McpClient's contract the server registry (and tests) depend on. */
export interface McpClientLike {
  readonly isAlive: boolean;
  /** Increments each time the underlying process is (re)spawned; 0 for the first spawn. */
  readonly generation: number;
  /** For observability/testing only; undefined before the first spawn. */
  readonly pid: number | undefined;
  start(): Promise<void>;
  callTool<T = unknown>(name: string, args?: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
  close(): Promise<void>;
  /** Synchronous best-effort kill for a `process.once("exit", ...)` safety net. */
  forceKillSync(): void;
}
