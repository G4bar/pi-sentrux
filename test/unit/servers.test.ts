import { describe, expect, it } from "vitest";
import type { McpClientLike } from "../../extensions/sentrux/types.ts";
import { McpServerRegistry } from "../../extensions/sentrux/servers.ts";
import { makeFakeMcpClient } from "../helpers.ts";

class FakeMcpClient implements McpClientLike {
  private alive = false;
  private everStarted = false;
  generation = 0;
  pid: number | undefined = undefined;
  startCalls = 0;
  closeCalls = 0;
  forceKillCalls = 0;

  get isAlive(): boolean {
    return this.alive;
  }

  async start(): Promise<void> {
    this.startCalls++;
    if (this.alive) return;
    if (this.everStarted) this.generation += 1;
    this.everStarted = true;
    this.alive = true;
  }

  async callTool<T = unknown>(): Promise<T> {
    throw new Error("FakeMcpClient.callTool is not exercised by servers.test.ts");
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.alive = false;
  }

  forceKillSync(): void {
    this.forceKillCalls++;
    this.alive = false;
  }

  /** Simulates the process dying outside of any registry action (timeout, abort, crash). */
  crash(): void {
    this.alive = false;
  }
}

function makeRegistry(maxServers = 3): { registry: McpServerRegistry; created: Map<string, FakeMcpClient> } {
  const created = new Map<string, FakeMcpClient>();
  const registry = new McpServerRegistry({
    maxServers: () => maxServers,
    createClient: (root) => {
      const client = new FakeMcpClient();
      created.set(root, client);
      return client;
    },
  });
  return { registry, created };
}

describe("McpServerRegistry", () => {
  it("does not create any client until getClient is called (lazy spawn)", () => {
    const { created } = makeRegistry();
    expect(created.size).toBe(0);
  });

  it("creates one client per root and reuses it on repeat access (per-root isolation)", async () => {
    const { registry, created } = makeRegistry();
    const a1 = await registry.getClient("/root/a");
    const b1 = await registry.getClient("/root/b");
    const a2 = await registry.getClient("/root/a");

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    expect(created.size).toBe(2);
    expect(created.get("/root/a")!.startCalls).toBe(2);
  });

  it("LRU-evicts a session-less handle over one with a session when at capacity", async () => {
    const { registry, created } = makeRegistry(2);
    await registry.getClient("/root/a");
    await registry.getClient("/root/b");
    registry.markSessionStarted("/root/a"); // a has a session, b does not

    await registry.getClient("/root/c"); // exceeds maxServers=2; must evict one of a/b

    expect(created.get("/root/b")!.closeCalls).toBe(1);
    expect(created.get("/root/a")!.closeCalls).toBe(0);
    expect(registry.getHandleInfo("/root/b")?.lostSession).toBe(false);
  });

  it("evicts the least-recently-used handle when all candidates have a session, and sets lostSession", async () => {
    const { registry, created } = makeRegistry(2);
    await registry.getClient("/root/a");
    await registry.getClient("/root/b");
    registry.markSessionStarted("/root/a");
    registry.markSessionStarted("/root/b");

    await registry.getClient("/root/c"); // both a and b have sessions; a is LRU (accessed first)

    expect(created.get("/root/a")!.closeCalls).toBe(1);
    expect(created.get("/root/b")!.closeCalls).toBe(0);
    expect(registry.getHandleInfo("/root/a")?.lostSession).toBe(true);
  });

  it("detects a respawn between calls (generation bump) and marks lostSession", async () => {
    const { registry, created } = makeRegistry();
    await registry.getClient("/root/a");
    registry.markSessionStarted("/root/a");

    created.get("/root/a")!.crash();
    await registry.getClient("/root/a"); // start() respawns the fake, bumping its generation

    const info = registry.getHandleInfo("/root/a");
    expect(info?.generation).toBe(1);
    expect(info?.hasSession).toBe(false);
    expect(info?.lostSession).toBe(true);
  });

  it("closeAll closes every tracked client and clears the registry", async () => {
    const { registry, created } = makeRegistry();
    await registry.getClient("/root/a");
    await registry.getClient("/root/b");

    await registry.closeAll();

    expect(created.get("/root/a")!.closeCalls).toBe(1);
    expect(created.get("/root/b")!.closeCalls).toBe(1);
    expect(registry.getHandleInfo("/root/a")).toBeUndefined();
  });

  it("closeAll does not wait past its timeout for a client whose close() hangs", async () => {
    const hangingClient: McpClientLike = makeFakeMcpClient({ close: () => new Promise(() => {}) });
    const registry = new McpServerRegistry({ maxServers: () => 3, createClient: () => hangingClient });
    await registry.getClient("/root/hang");

    const start = Date.now();
    await registry.closeAll(100);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("killAllSync still reaches clients whose closeAll close() has not settled", async () => {
    let forceKills = 0;
    let finishClose!: () => void;
    const hangingClient: McpClientLike = makeFakeMcpClient({
      close: () => new Promise<void>((resolve) => (finishClose = resolve)),
      forceKillSync: () => void forceKills++,
    });
    const registry = new McpServerRegistry({ maxServers: () => 3, createClient: () => hangingClient });
    await registry.getClient("/root/hang");

    const closing = registry.closeAll(5000);
    expect(registry.getHandleInfo("/root/hang")).toBeUndefined();
    registry.killAllSync();
    expect(forceKills).toBe(1);

    finishClose();
    await closing;
    registry.killAllSync();
    expect(forceKills).toBe(1);
  });

  it("reports liveness via the alive flag; dead handles stay listed until closed", async () => {
    const { registry, created } = makeRegistry();
    await registry.getClient("/root/a");
    expect(registry.getHandleInfo("/root/a")?.alive).toBe(true);

    created.get("/root/a")!.crash();
    const info = registry.getHandleInfo("/root/a");
    expect(info?.alive).toBe(false);
    expect(info).toBeDefined();
  });

  it("killAllSync force-kills every tracked client synchronously", async () => {
    const { registry, created } = makeRegistry();
    await registry.getClient("/root/a");
    await registry.getClient("/root/b");

    registry.killAllSync();

    expect(created.get("/root/a")!.forceKillCalls).toBe(1);
    expect(created.get("/root/b")!.forceKillCalls).toBe(1);
  });
});
