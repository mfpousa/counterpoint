import { withModelPriority, withModelSlot } from "../server/ai";
import { config } from "../server/config";

// Flush the microtask + timer queue so the gate has settled (slots acquired/woken).
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// The global model-request gate (server/ai.ts) bounds total in-flight requests to
// config.ai.maxConcurrency and RESERVES config.ai.reserveInteractive slots that only
// interactive work may use — so background catch-up (drain/synthesis/augment) can never
// occupy every model instance and queue a waiting reader. These tests lock that contract;
// it's the guarantee the feed pipeline's withModelPriority("background", …) wrapping relies on.
// config is `as const` (readonly to TS) but a plain object at runtime — alias a mutable
// view so the test can dial the gate's limits without touching the real env.
const aiCfg = config.ai as unknown as {
  maxConcurrency: number;
  reserveInteractive: number;
};

describe("model request gate: interactive reservation", () => {
  const savedMax = aiCfg.maxConcurrency;
  const savedReserve = aiCfg.reserveInteractive;
  beforeEach(() => {
    aiCfg.maxConcurrency = 3;
    aiCfg.reserveInteractive = 1;
  });
  afterEach(() => {
    aiCfg.maxConcurrency = savedMax;
    aiCfg.reserveInteractive = savedReserve;
  });

  it("caps background at maxConcurrency - reserveInteractive and keeps a slot for interactive", async () => {
    const started: string[] = [];
    const gates: Record<string, ReturnType<typeof deferred>> = {};
    const run = (label: string): Promise<void> => {
      gates[label] = deferred();
      return withModelSlot(async () => {
        started.push(label);
        await gates[label].promise;
      });
    };

    // Three background tasks compete, but only two may run at once — one instance is
    // held back for interactive work.
    const b0 = withModelPriority("background", () => run("b0"));
    const b1 = withModelPriority("background", () => run("b1"));
    const b2 = withModelPriority("background", () => run("b2"));
    await flush();
    expect([...started].sort()).toEqual(["b0", "b1"]);

    // A user-facing request still starts immediately on the reserved slot.
    const i0 = withModelPriority("interactive", () => run("i0"));
    await flush();
    expect(started).toContain("i0");
    expect(started).not.toContain("b2");

    // Freeing a background slot lets the queued background task proceed.
    gates["b0"].resolve();
    await flush();
    expect(started).toContain("b2");

    gates["b1"].resolve();
    gates["b2"].resolve();
    gates["i0"].resolve();
    await Promise.all([b0, b1, b2, i0]);
  });

  it("does not cap interactive work — it may use every instance", async () => {
    const started: string[] = [];
    const gates: ReturnType<typeof deferred>[] = [];
    const run = (label: string): Promise<void> => {
      const g = deferred();
      gates.push(g);
      return withModelSlot(async () => {
        started.push(label);
        await g.promise;
      });
    };

    const tasks = [
      withModelPriority("interactive", () => run("i0")),
      withModelPriority("interactive", () => run("i1")),
      withModelPriority("interactive", () => run("i2")),
    ];
    await flush();
    expect([...started].sort()).toEqual(["i0", "i1", "i2"]);

    gates.forEach((g) => g.resolve());
    await Promise.all(tasks);
  });

  it("wakes a waiting INTERACTIVE request before a waiting BACKGROUND one", async () => {
    const started: string[] = [];
    const gates: Record<string, ReturnType<typeof deferred>> = {};
    const run = (label: string): Promise<void> => {
      gates[label] = deferred();
      return withModelSlot(async () => {
        started.push(label);
        await gates[label].promise;
      });
    };

    // Fill all three slots with interactive work so nothing is free.
    const i0 = withModelPriority("interactive", () => run("i0"));
    const i1 = withModelPriority("interactive", () => run("i1"));
    const i2 = withModelPriority("interactive", () => run("i2"));
    await flush();
    expect([...started].sort()).toEqual(["i0", "i1", "i2"]);

    // Queue a background task FIRST, then an interactive one — both waiting.
    const bWaiting = withModelPriority("background", () => run("bWaiting"));
    const iWaiting = withModelPriority("interactive", () => run("iWaiting"));
    await flush();
    expect(started).not.toContain("bWaiting");
    expect(started).not.toContain("iWaiting");

    // Free ONE slot: interactive must jump ahead of the earlier-queued background task.
    gates["i0"].resolve();
    await flush();
    expect(started).toContain("iWaiting");
    expect(started).not.toContain("bWaiting");

    gates["i1"].resolve();
    gates["i2"].resolve();
    gates["iWaiting"].resolve();
    await flush();
    gates["bWaiting"].resolve();
    await Promise.all([i0, i1, i2, bWaiting, iWaiting]);
  });
});
