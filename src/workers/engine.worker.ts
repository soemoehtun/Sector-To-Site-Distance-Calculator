/**
 * Engine worker: one Go/WASM instance per worker.
 *
 * The wasm module is expanded from the embedded gzip payload, then every call
 * is a plain synchronous JSON request. Go's wasm build is single threaded, so
 * parallelism comes from running several of these workers.
 */
import "../wasm/wasm_exec.js";
import { ENGINE_WASM_GZIP_BASE64 } from "../wasm/engineWasm";

interface EngineGlobals {
  __site2site: Record<string, (...args: unknown[]) => unknown>;
  __site2siteError?: string;
}

let engine: EngineGlobals["__site2site"] | null = null;
let booting: Promise<void> | null = null;

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "This browser cannot decompress the engine payload (DecompressionStream " +
        "is unavailable). Falling back to the built-in JavaScript engine.",
    );
  }
  const stream = new Blob([bytes]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function boot(): Promise<void> {
  if (engine) return;
  if (booting) return booting;
  booting = (async () => {
    const g = globalThis as unknown as {
      Go: new () => {
        importObject: WebAssembly.Imports;
        run: (i: WebAssembly.Instance) => Promise<unknown>;
      };
    };
    if (typeof g.Go !== "function") {
      throw new Error("wasm_exec.js did not register the Go runtime");
    }
    const bytes = await gunzip(b64ToBytes(ENGINE_WASM_GZIP_BASE64));
    const go = new g.Go();
    // run() never resolves: Go's main parks on a channel to keep the runtime
    // alive for the life of the worker.
    void go.run((await WebAssembly.instantiate(bytes, go.importObject)).instance);
    // The Go main function registers the API synchronously; give the scheduler
    // a turn in case the runtime had to spin up first.
    for (let i = 0; i < 500 && !engine; i++) {
      await Promise.resolve();
      engine = (globalThis as unknown as EngineGlobals).__site2site ?? null;
    }
    if (!engine) throw new Error("engine did not start");
    (self as unknown as Worker).postMessage({ type: "ready" });
  })();
  return booting;
}

self.onmessage = async (e: MessageEvent) => {
  const { id, method, payload } = e.data as {
    id: number;
    method: string;
    payload: unknown;
  };
  try {
    await boot();
    if (!engine) throw new Error("engine unavailable");
    const fn = engine[method];
    if (typeof fn !== "function") throw new Error("unknown method " + method);
    // A single object is passed straight through (the JSON methods take one
    // request object); an array is spread, which is how the parsers receive
    // their positional (bytes, fileName) arguments without JSON mangling them.
    const result = Array.isArray(payload) ? fn(...payload) : fn(payload);
    if (result === null || result === undefined) {
      const g = globalThis as unknown as EngineGlobals;
      throw new Error(g.__site2siteError || method + " failed");
    }
    (self as unknown as Worker).postMessage({ type: "reply", id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: "reply",
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
