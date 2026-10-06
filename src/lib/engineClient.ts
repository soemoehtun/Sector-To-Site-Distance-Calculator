/**
 * Worker pool in front of the Go/WASM engine.
 *
 * A single WASM instance is single threaded, so the speed-up on large datasets
 * comes from spreading the work over several workers. Callers just use
 * `call(method, payload)`; the pool picks the least busy worker and falls back
 * to the least busy one when a worker dies.
 *
 * Most engine methods are stateless (they carry their own data), but `setup`
 * stores the dataset in the worker's Go session and `calc` then reads from it.
 * Those two are pinned to one worker - see SESSION_METHODS.
 */

export interface EngineStats {
  ready: boolean;
  workers: number;
  calls: number;
  errors: number;
  lastError: string | null;
}

// ?worker&inline bundles the worker into this module and starts it from a blob
// URL, so the 2 MB wasm payload ends up inside index.html instead of a second
// file next to it.
import EngineWorkerFactory from "../workers/engine.worker?worker&inline";

type WorkerMessage =
  | { type: "ready" }
  | { type: "reply"; id: number; result?: unknown; error?: string };

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  worker: EngineWorker;
  timer: number;
};

/**
 * Methods that depend on the worker's Go session, so they must all run on the
 * same worker.
 */
const SESSION_METHODS = new Set(["setup", "calc"]);

const CALL_TIMEOUT_MS = 120_000;
const BOOT_TIMEOUT_MS = 30_000;

class EngineWorker {
  readonly index: number;
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private readyResolvers: (() => void)[] = [];
  ready: Promise<boolean>;
  booted = false;
  inflight = 0;
  alive = true;

  constructor(index: number) {
    this.index = index;
    this.worker = new EngineWorkerFactory();
    this.ready = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (ok) this.booted = true;
        resolve(ok);
      };
      this.readyResolvers.push(() => finish(false));
      const bootTimer = window.setTimeout(() => finish(false), BOOT_TIMEOUT_MS);
      this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        const data = e.data;
        if (data.type === "ready") {
          window.clearTimeout(bootTimer);
          finish(true);
          return;
        }
        if (data.type !== "reply") return;
        const p = this.pending.get(data.id);
        if (!p) return;
        this.pending.delete(data.id);
        window.clearTimeout(p.timer);
        this.inflight--;
        if (data.error !== undefined) p.reject(new Error(data.error));
        else p.resolve(data.result);
      };
      this.worker.onerror = (e) => {
        window.clearTimeout(bootTimer);
        this.alive = false;
        const err = new Error(e.message || "engine worker failed to load");
        this.readyResolvers.forEach((r) => r());
        this.pending.forEach((p) => {
          window.clearTimeout(p.timer);
          p.reject(err);
        });
        this.pending.clear();
        finish(false);
      };
    });
  }

  call<T>(method: string, payload: unknown, transfer?: Transferable[]): Promise<T> {
    if (!this.alive) return Promise.reject(new Error("engine worker is dead"));
    const id = ++this.seq;
    this.inflight++;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        this.inflight--;
        reject(new Error(method + " timed out"));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        worker: this,
        timer,
      });
      this.worker.postMessage({ id, method, payload }, transfer ?? []);
    });
  }

  dispose() {
    this.alive = false;
    this.worker.terminate();
  }
}

let pool: EngineWorker[] | null = null;
/** Index of the worker holding the Go session created by `setup`. */
let primaryIndex = 0;
let booting: Promise<EngineStats> | null = null;
/** Resolves once at least one worker has booted; the extra workers may still be starting. */
let firstReady: Promise<void> | null = null;
let resolveFirstReady: (() => void) | null = null;
let growing = false;
const stats: EngineStats = {
  ready: false,
  workers: 0,
  calls: 0,
  errors: 0,
  lastError: null,
};

function maxWorkers(): number {
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(1, Math.min(4, cores - 1));
}

/**
 * Starts one worker and resolves as soon as it is usable.
 *
 * Booting a worker means decoding the ~2 MB embedded payload, gunzipping it and
 * instantiating the module, so a full pool used to cost that several times over
 * before the first file could even be read. Only the first worker is on this
 * path; the rest are added by `growPool()` while the browser is idle.
 */
function bootFirst(): Promise<void> {
  if (firstReady) return firstReady;
  firstReady = new Promise<void>((resolve) => {
    resolveFirstReady = resolve;
  });
  const first = new EngineWorker(0);
  pool = [first];
  void first.ready.then((ok) => {
    stats.workers = ok ? 1 : 0;
    stats.ready = ok;
    if (!ok) stats.lastError = "the WebAssembly engine could not start";
    resolveFirstReady?.();
    resolveFirstReady = null;
  });
  return firstReady;
}

/** Adds the remaining workers without making anyone wait for them. */
function growPool(): void {
  if (growing || !pool) return;
  growing = true;
  const add = () => {
    const current = pool!;
    if (current.length >= maxWorkers()) {
      growing = false;
      return;
    }
    const extra = new EngineWorker(current.length);
    pool = [...current, extra];
    void extra.ready.then((ok) => {
      if (ok) {
        stats.workers++;
        stats.ready = true;
      }
    });
    if (pool.length < maxWorkers()) schedule(add);
    else growing = false;
  };
  schedule(add);
}

/** Runs `fn` on the next idle slot, or on a timer where idle callbacks are absent. */
function schedule(fn: () => void): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn());
  else setTimeout(fn, 200);
}

function pickWorker(method: string): EngineWorker | null {
  const alive = pool!.filter((w) => w.alive && w.booted);
  if (!alive.length) return null;
  if (SESSION_METHODS.has(method)) {
    // The session lives in one worker; re-pin if that worker died.
    const pinned = pool![primaryIndex];
    if (pinned && pinned.alive && pinned.booted) return pinned;
    const replacement = alive[0];
    primaryIndex = pool!.indexOf(replacement);
    return replacement;
  }
  return alive.reduce((a, b) => (a.inflight <= b.inflight ? a : b));
}

/** Boots the first worker, then fills out the pool in the background. */
export function initEngine(): Promise<EngineStats> {
  if (booting) return booting;
  booting = bootFirst().then(() => {
    growPool();
    return stats;
  });
  return booting;
}

export function engineStats(): EngineStats {
  return { ...stats };
}

/** Warm the pool up in the background so the first calculation does not wait. */
export function warmEngine(): void {
  void initEngine();
}

/**
 * Call an engine method. Resolves with null when the engine is unavailable so
 * the caller can use the JavaScript fallback.
 */
export async function call<T>(
  method: string,
  payload: unknown,
  transfer?: Transferable[],
): Promise<T | null> {
  await initEngine();
  const w = pickWorker(method);
  if (!w) {
    stats.lastError = stats.lastError ?? "no engine worker available";
    return null;
  }
  stats.calls++;
  try {
    return (await w.call<T>(method, payload, transfer)) as T;
  } catch (err) {
    stats.errors++;
    stats.lastError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

export function disposeEngine(): void {
  pool?.forEach((w) => w.dispose());
  pool = null;
  primaryIndex = 0;
  booting = null;
  firstReady = null;
  resolveFirstReady = null;
  growing = false;
  stats.ready = false;
  stats.workers = 0;
}
