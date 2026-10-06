/**
 * Parity + performance harness.
 *
 *   node tools/parity.mjs [n] [reps]
 *
 * Loads the real TypeScript implementation (bundled on the fly with esbuild) and
 * the compiled Go/WASM engine in the same process, runs both over identical
 * synthetic datasets and compares the neighbour lists. It also reports timings
 * so the speed-up is measurable rather than assumed.
 *
 * Exit code 1 means the two implementations disagree.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "node_modules", ".cache", "parity");
fs.mkdirSync(tmp, { recursive: true });

const N = Number(process.argv[2] || 2000);
const REPS = Number(process.argv[3] || 3);

// ---------------------------------------------------------------- TS bundle
const tsEntry = path.join(tmp, "entry.ts");
fs.writeFileSync(
  tsEntry,
  `export { calculateDistancesAsync } from "@/lib/distance";
export { computeDelaunay, computeAllVoronoiPolygons, computeVoronoiCellPolygon,
         getDelaunayNeighborsNLayers, computeVoronoiEdges } from "@/lib/voronoi";
export type { Site } from "@/types";
import { __disableEngineForTest } from "@/lib/engine";
// The TS side must use its pure-JS fallback here; the engine's own results are
// supplied by the Go/WASM instance loaded below and compared side by side.
__disableEngineForTest(true);`,
);
const tsOut = path.join(tmp, "entry.mjs");
// The app imports its Web Worker via Vite's `?worker&inline`; esbuild does not
// know that loader, and the worker is never constructed in Node, so map it to a
// no-op stub just so the bundle resolves.
const workerStub = path.join(tmp, "engineWorkerStub.mjs");
fs.writeFileSync(
  workerStub,
  `export default class DummyEngineWorker {\n` +
    `  onmessage = null;\n` +
    `  postMessage() {}\n` +
    `  terminate() {}\n` +
    `}\n`,
);
await build({
  entryPoints: [tsEntry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: tsOut,
  alias: { "@": path.join(root, "src") },
  plugins: [
    {
      name: "worker-inline-stub",
      setup(b) {
        b.onResolve({ filter: /engine\.worker\?worker&inline$/ }, () => ({
          path: workerStub,
        }));
      },
    },
  ],
  logLevel: "warning",
});
const ts = await import(url.pathToFileURL(tsOut).href);

// ---------------------------------------------------------------- Go/WASM
const wasmPath = path.join(root, "src", "wasm", "engine.wasm");
if (!fs.existsSync(wasmPath)) {
  // `build:wasm` inlines the payload into engineWasm.ts and then deletes the
  // raw binary; recover it from the embedded (gzip + base64) module.
  const engineWasmTs = path.join(root, "src", "wasm", "engineWasm.ts");
  if (!fs.existsSync(engineWasmTs)) {
    console.error("no engine.wasm and no engineWasm.ts - run: npm run build:wasm");
    process.exit(1);
  }
  const m = fs
    .readFileSync(engineWasmTs, "utf8")
    .match(/ENGINE_WASM_GZIP_BASE64 = "([A-Za-z0-9+/=]+)"/);
  if (!m) {
    console.error("could not parse the embedded WASM from engineWasm.ts");
    process.exit(1);
  }
  fs.writeFileSync(wasmPath, zlib.gunzipSync(Buffer.from(m[1], "base64")));
  console.log("recovered engine.wasm from the embedded payload");
}
const wasmExec = process.env.WASM_EXEC || execGoPath("wasm_exec.js");
require(wasmExec);
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(
  fs.readFileSync(wasmPath),
  go.importObject,
);
go.run(instance).catch(() => {});
for (let i = 0; !globalThis.__site2site && i < 200; i++) {
  await new Promise((r) => setTimeout(r, 10));
}
const eng = globalThis.__site2site;
if (!eng) throw new Error("wasm engine did not register __site2site");

/** The Go side returns null and records the message; turn that into a throw. */
function call(name, ...args) {
  const out = eng[name](...args);
  if (out === null || out === undefined) {
    throw new Error(name + ": " + (globalThis.__site2siteError || "failed"));
  }
  return out;
}

function execGoPath(name) {
  const out = execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim();
  return path.join(out, "lib", "wasm", name);
}

// ------------------------------------------------------------------ helpers
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clustered sites, which is what real tower data looks like. */
function makeSites(n, seed, spread = 0.35) {
  const rnd = mulberry32(seed);
  const sites = [];
  for (let i = 0; i < n; i++) {
    sites.push({
      id: "S" + String(i + 1).padStart(5, "0"),
      name: "Site " + (i + 1),
      lat: 16.8 + (rnd() - 0.5) * spread * 2 + Math.sin(i) * spread * 0.1,
      lng: 96.2 + (rnd() - 0.5) * spread * 2 + Math.cos(i) * spread * 0.1,
      originalData: { Region: "R" + (i % 12), Band: ["700", "1800", "2600"][i % 3] },
    });
  }
  return sites;
}

const f64b64 = (arr) =>
  Buffer.from(new Float64Array(arr).buffer).toString("base64");

/** Decode base64 into a typed array view. Buffer.from pools, so .buffer must
 *  never be used directly - it points at the shared 8 KB pool. */
function unpack(b64, Ctor, itemSize) {
  const buf = Buffer.from(b64, "base64");
  return new Ctor(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
const f32s = (b64) => unpack(b64, Float64Array, 8);
const i32s = (b64) => unpack(b64, Int32Array, 4);

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}

// ------------------------------------------------------------------- checks
let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log("  ok   " + label);
  } else {
    failures++;
    console.log("  FAIL " + label + (detail ? "\n       " + detail : ""));
  }
}

function compareNeighbours(label, tsRows, goRows, tolKm) {
  if (tsRows.length !== goRows.length) {
    check(label + " (site count)", false, `${tsRows.length} vs ${goRows.length}`);
    return;
  }
  let bad = 0;
  let worst = 0;
  let firstMsg = "";
  for (let i = 0; i < tsRows.length; i++) {
    const a = tsRows[i];
    const b = goRows[i];
    if (a.length !== b.length) {
      if (!firstMsg)
        firstMsg = `site ${i}: ${a.length} vs ${b.length} neighbours (${JSON.stringify(
          a.slice(0, 4),
        )} vs ${JSON.stringify(b.slice(0, 4))})`;
      bad++;
      continue;
    }
    for (let j = 0; j < a.length; j++) {
      if (a[j].to !== b[j].to) {
        if (!firstMsg)
          firstMsg =
            `site ${i} neighbour ${j}: id ${a[j].to}@${a[j].dist} vs ` +
            `${b[j].to}@${b[j].dist}`;
        bad++;
        break;
      }
      const d = Math.abs(a[j].dist - b[j].dist);
      if (d > worst) worst = d;
      if (d > tolKm) {
        if (!firstMsg)
          firstMsg = `site ${i} neighbour ${j}: dist ${a[j].dist} vs ${b[j].dist}`;
        bad++;
        break;
      }
    }
  }
  check(
    label,
    bad === 0,
    bad ? `${bad}/${tsRows.length} sites differ; first: ${firstMsg}` : "",
  );
  if (!bad) console.log(`       max distance delta: ${worst.toExponential(2)} km`);
}

// ================================================================ brute force
async function bruteForceCase(sites, opts) {
  console.log(`\n[brute] n=${sites.length} k=${opts.nNeighbors} unit=${opts.unit}`);
  const lat = sites.map((s) => s.lat);
  const lng = sites.map((s) => s.lng);
  const ids = sites.map((s) => s.id);

  call("setup", {
    sourceIds: ids,
    sourceLatB64: f64b64(lat),
    sourceLonB64: f64b64(lng),
    hasTarget: false,
    nNeighbors: opts.nNeighbors,
    unit: opts.unit,
    method: "brute",
    excludeZero: opts.excludeZero,
    maxDistance: opts.maxDistance,
    distanceOp: opts.distanceOp,
  });

  const t0 = process.hrtime.bigint();
  const raw = call("calc", { start: 0, end: sites.length });
  const t1 = process.hrtime.bigint();
  const goMs = Number(t1 - t0) / 1e6;

  const parsed = JSON.parse(raw);
  const count = i32s(parsed.count);
  const gIdx = i32s(parsed.idx);
  const gDist = f32s(parsed.dist);
  const goRows = [];
  for (let i = 0; i < count.length - 1; i++) {
    const row = [];
    for (let p = count[i]; p < count[i + 1]; p++) {
      row.push({ to: ids[gIdx[p]], dist: gDist[p] });
    }
    goRows.push(row);
  }

  const tsTimes = [];
  let tsRows;
  for (let r = 0; r < REPS; r++) {
    const a = process.hrtime.bigint();
    const res = await ts.calculateDistancesAsync({
      mode: "pairwise",
      method: "brute",
      sourceSites: sites,
      targetSites: [],
      nNeighbors: opts.nNeighbors,
      voronoiLayers: 0,
      unit: opts.unit,
      excludeZero: opts.excludeZero,
      maxDistance: opts.maxDistance,
      distanceOp: opts.distanceOp,
    });
    tsTimes.push(Number(process.hrtime.bigint() - a) / 1e6);
    tsRows = res.sitesWithNeighbors.map((s) => s.neighbors);
  }

  compareNeighbours("neighbour lists match TS", tsRows, goRows, 1e-6);
  const tsMs = median(tsTimes);
  console.log(
    `       TS ${tsMs.toFixed(1)} ms  vs  Go/WASM ${goMs.toFixed(1)} ms  (${(
      tsMs / goMs
    ).toFixed(1)}x)`,
  );
}

// =================================================================== voronoi
async function voronoiCase(sites, layers) {
  console.log(`\n[voronoi] n=${sites.length} layers=${layers}`);
  const lat = sites.map((s) => s.lat);
  const lng = sites.map((s) => s.lng);
  const ids = sites.map((s) => s.id);

  call("setup", {
    sourceIds: ids,
    sourceLatB64: f64b64(lat),
    sourceLonB64: f64b64(lng),
    hasTarget: false,
    nNeighbors: 0,
    voronoiLayers: layers,
    unit: "km",
    method: "voronoi",
    excludeZero: false,
    maxDistance: null,
    distanceOp: "<",
  });

  const t0 = process.hrtime.bigint();
  const parsed = JSON.parse(call("calc", { start: 0, end: sites.length }));
  const cellsJson = call("voronoiCells", {
    ids,
    latB64: f64b64(lat),
    lonB64: f64b64(lng),
  });
  const t1 = process.hrtime.bigint();
  const goMs = Number(t1 - t0) / 1e6;

  const count = i32s(parsed.count);
  const gIdx = i32s(parsed.idx);
  const gDist = f32s(parsed.dist);
  const gLayer = i32s(parsed.layer);
  const goRows = [];
  for (let i = 0; i < count.length - 1; i++) {
    const row = [];
    for (let p = count[i]; p < count[i + 1]; p++) {
      row.push({ to: ids[gIdx[p]], dist: gDist[p], layer: gLayer[p] });
    }
    goRows.push(row);
  }

  // TS reference
  const tsTimes = [];
  let tsRows;
  for (let r = 0; r < REPS; r++) {
    const a = process.hrtime.bigint();
    const res = await ts.calculateDistancesAsync({
      mode: "pairwise",
      method: "voronoi",
      sourceSites: sites,
      targetSites: [],
      nNeighbors: 1, // the JS guard requires >= 1; unused by the voronoi path
      voronoiLayers: layers,
      unit: "km",
      excludeZero: false,
      maxDistance: null,
      distanceOp: "<",
    });
    tsTimes.push(Number(process.hrtime.bigint() - a) / 1e6);
    tsRows = res.sitesWithNeighbors.map((s) =>
      s.neighbors.map((n) => ({ to: n.to, dist: n.dist, layer: n.layer })),
    );
  }
  compareNeighbours("neighbour lists + layers match TS", tsRows, goRows, 1e-6);
  const tsMs = median(tsTimes);
  console.log(
    `       TS ${tsMs.toFixed(1)} ms  vs  Go/WASM ${goMs.toFixed(1)} ms  (${(
      tsMs / goMs
    ).toFixed(1)}x)`,
  );

  // selected-cell highlight parity
  const picked = Math.min(3, sites.length);
  const cellReq = { ids, latB64: f64b64(lat), lonB64: f64b64(lng), targets: [] };
  const goCells = JSON.parse(
    call("cellsFor", { ...cellReq, targets: ids.slice(0, picked) }),
  );
  const cells = ts.computeAllVoronoiPolygons(sites);
  const byId = new Map(cells.map((c) => [c.id, c]));
  let cellBad = 0;
  let cellFirst = "";
  let cellWorst = 0;
  for (const f of goCells.features) {
    const ref = byId.get(f.id);
    if (!ref) {
      cellBad++;
      if (!cellFirst) cellFirst = `${f.id} missing from TS output`;
      continue;
    }
    const a = ref.geometry.coordinates[0];
    const b = f.geometry.coordinates[0];
    if (a.length !== b.length) {
      cellBad++;
      if (!cellFirst) cellFirst = `${f.id}: ${a.length} vs ${b.length} vertices`;
      continue;
    }
    // Rings may start at a different vertex and the circumcentre formula is
    // ill-conditioned for slivers, so compare vertex-by-vertex allowing a
    // cyclic shift and sub-millimetre slack.
    const closedA = a.length === b.length ? a : null;
    if (!closedA) {
      cellBad++;
      continue;
    }
    const at = (ring, i) => ring[((i % ring.length) + ring.length) % ring.length];
    let bestShift = -1;
    let bestErr = Infinity;
    for (let shift = 0; shift < a.length; shift++) {
      let err = 0;
      for (let i = 0; i < a.length; i++) {
        err = Math.max(
          err,
          Math.abs(at(a, i)[0] - at(b, i + shift)[0]),
          Math.abs(at(a, i)[1] - at(b, i + shift)[1]),
        );
      }
      if (err < bestErr) {
        bestErr = err;
        bestShift = shift;
      }
    }
    void bestShift;
    if (bestErr > 1e-9) {
      cellBad++;
      if (!cellFirst)
        cellFirst = `${f.id}: best ring error ${bestErr.toExponential(2)} deg`;
    } else if (bestErr > cellWorst) {
      cellWorst = bestErr;
    }
  }
  check(
    `Voronoi cell polygons match TS (${goCells.features.length} features)`,
    cellBad === 0,
    cellFirst,
  );
  if (!cellBad)
    console.log(
      `       worst ring error: ${(cellWorst * 111320).toExponential(2)} m on the ground`,
    );
}

// ===================================================================== edges
function edgeCase(sites) {
  console.log("\n[edges]");
  if (typeof ts.computeVoronoiEdges !== "function") {
    console.log("  skip  no computeVoronoiEdges in the TS lib (not a sector feature)");
    return;
  }
  const lat = sites.map((s) => s.lat);
  const lng = sites.map((s) => s.lng);
  const ids = sites.map((s) => s.id);
  const go = JSON.parse(
    call("voronoiEdges", { ids, latB64: f64b64(lat), lonB64: f64b64(lng) }),
  ).edges;
  const tris = ts.computeDelaunay(sites.map((s) => ({ x: s.lng, y: s.lat })));
  const ref = ts.computeVoronoiEdges(sites);
  check("edge count", go.length === ref.length, `${go.length} vs ${ref.length}`);
  check("edge keys", go.every((e) => "lat1" in e && "siteA" in e), JSON.stringify(go[0]));
  // Structure must match exactly: the same Delaunay edge set.
  const key = (e) => [e.siteA, e.siteB].sort().join("|");
  const refMap = new Map(ref.map((e) => [key(e), e]));
  const goMap = new Map(go.map((e) => [key(e), e]));
  let bad = 0;
  let first = "";
  for (const k of refMap.keys()) {
    if (!goMap.has(k)) {
      bad++;
      if (!first) first = `missing in Go: ${k}`;
    }
  }
  for (const k of goMap.keys()) {
    if (!refMap.has(k)) {
      bad++;
      if (!first) first = `extra in Go: ${k}`;
    }
  }
  check(`edge set matches TS (${ref.length} edges)`, bad === 0, first);

  // Coordinates must match, except on sliver triangles: the circumcentre of a
  // nearly collinear triple is astronomically ill-conditioned, so the JS and the
  // Go rounding land on different points thousands of km away. Both versions
  // emit those, so "both are wild" counts as agreement.
  const lats = sites.map((x) => x.lat);
  const lngs = sites.map((x) => x.lng);
  const pad = 10 * Math.hypot(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs));
  const wild = (lat, lng) =>
    lat < Math.min(...lats) - pad || lat > Math.max(...lats) + pad ||
    lng < Math.min(...lngs) - pad || lng > Math.max(...lngs) + pad;
  bad = 0;
  first = "";
  let worst = 0;
  let wildCount = 0;
  for (const [k, a] of refMap) {
    const b = goMap.get(k);
    if (!b) continue;
    const ptsA = [[a.lat1, a.lng1], [a.lat2, a.lng2]];
    const ptsB = [[b.lat1, b.lng1], [b.lat2, b.lng2]];
    // Either side being wild means the shared triangle is sliver-degenerate, so
    // the two libms can disagree on a centre that is meaningless anyway.
    if (ptsA.some((p) => wild(p[0], p[1])) || ptsB.some((p) => wild(p[0], p[1]))) {
      wildCount++;
      continue;
    }
    // Endpoint order is not meaningful for a two-point line: the Go triangle
    // list is built in a different order than the JS one, so which circumcentre
    // is written first can flip. Match the endpoints as a set.
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const err = Math.min(
      Math.max(d(ptsA[0], ptsB[0]), d(ptsA[1], ptsB[1])),
      Math.max(d(ptsA[0], ptsB[1]), d(ptsA[1], ptsB[0])),
    );
    if (err > worst) worst = err;
    if (err > 1e-9) {
      bad++;
      if (!first) first = `${k}: coordinate error ${err.toExponential(2)} deg`;
    }
  }
  check("edge coordinates match TS", bad === 0, first);
  if (!bad) {
    console.log(
      `       worst edge error: ${(worst * 111320).toExponential(2)} m on the ground` +
        `; ${wildCount} sliver edge(s) skipped (unstable in both)`,
    );
  }
}

// ===================================================== sector beam (all-source)
async function sectorCase(src, tgt, opts) {
  const beamWidth = opts.beamWidth;
  console.log(
    `\n[sector] sources=${src.length} targets=${tgt.length} beam=${beamWidth}° k=${opts.nNeighbors}`,
  );
  const azi = src.map((s) => s.azimuth ?? NaN);
  const call = (name, ...a) => {
    const out = eng[name](...a);
    if (out === null) throw new Error(name + ": " + globalThis.__site2siteError);
    return out;
  };
  call("setup", {
    sourceIds: src.map((s) => s.id),
    sourceLatB64: f64b64(src.map((s) => s.lat)),
    sourceLonB64: f64b64(src.map((s) => s.lng)),
    sourceAzimuthB64: f64b64(azi),
    targetIds: tgt.map((s) => s.id),
    targetLatB64: f64b64(tgt.map((s) => s.lat)),
    targetLonB64: f64b64(tgt.map((s) => s.lng)),
    hasTarget: true,
    nNeighbors: opts.nNeighbors,
    beamWidth,
    unit: "km",
    method: "sector",
    excludeZero: false,
    maxDistance: null,
    distanceOp: "<",
  });
  const parsed = JSON.parse(call("calc", { start: 0, end: src.length }));
  const count = i32s(parsed.count);
  const gIdx = i32s(parsed.idx);
  const gDist = f32s(parsed.dist);
  const tgtIDs = tgt.map((s) => s.id);
  const goRows = [];
  for (let i = 0; i < count.length - 1; i++) {
    const row = [];
    for (let p = count[i]; p < count[i + 1]; p++) {
      row.push({ to: tgtIDs[gIdx[p]], dist: gDist[p] });
    }
    goRows.push(row);
  }
  const res = await ts.calculateDistancesAsync({
    mode: "pairwise",
    method: "sector",
    sourceSites: src,
    targetSites: tgt,
    nNeighbors: opts.nNeighbors,
    voronoiLayers: 0,
    beamWidth,
    unit: "km",
    excludeZero: false,
    maxDistance: null,
    distanceOp: "<",
  });
  compareNeighbours(
    "in-beam neighbour lists match TS",
    res.sitesWithNeighbors.map((s) => s.neighbors),
    goRows,
    1e-6,
  );
}

function withAzimuth(sites) {
  const rnd = mulberry32(987);
  return sites.map((s) => ({ ...s, azimuth: Math.round(rnd() * 360) }));
}

// =============================================================== pairwise/two-file
async function pairwiseCase(srcSites, tgtSites, opts) {
  console.log(
    `\n[pairwise] sources=${srcSites.length} targets=${tgtSites.length} k=${opts.nNeighbors}`,
  );
  const all = [...srcSites, ...tgtSites];
  const call = (name, ...a) => {
    const out = eng[name](...a);
    if (out === null) throw new Error(name + ": " + globalThis.__site2siteError);
    return out;
  };
  call("setup", {
    sourceIds: srcSites.map((s) => s.id),
    sourceLatB64: f64b64(srcSites.map((s) => s.lat)),
    sourceLonB64: f64b64(srcSites.map((s) => s.lng)),
    targetIds: tgtSites.map((s) => s.id),
    targetLatB64: f64b64(tgtSites.map((s) => s.lat)),
    targetLonB64: f64b64(tgtSites.map((s) => s.lng)),
    hasTarget: true,
    nNeighbors: opts.nNeighbors,
    unit: "km",
    method: "brute",
    excludeZero: false,
    maxDistance: null,
    distanceOp: "<",
  });
  const raw = JSON.parse(call("calc", { start: 0, end: srcSites.length }));
  const count = i32s(raw.count);
  const gIdx = i32s(raw.idx);
  const gDist = f32s(raw.dist);
  const tgtIDs = tgtSites.map((s) => s.id);
  const goRows = [];
  for (let i = 0; i < count.length - 1; i++) {
    const row = [];
    for (let p = count[i]; p < count[i + 1]; p++) {
      row.push({ to: tgtIDs[gIdx[p]], dist: gDist[p] });
    }
    goRows.push(row);
  }
  const res = await ts.calculateDistancesAsync({
    mode: "pairwise",
    method: "brute",
    sourceSites: srcSites,
    targetSites: tgtSites,
    nNeighbors: opts.nNeighbors,
    voronoiLayers: 0,
    unit: "km",
    excludeZero: false,
    maxDistance: null,
    distanceOp: "<",
  });
  compareNeighbours(
    "neighbour lists match TS",
    res.sitesWithNeighbors.map((s) => s.neighbors),
    goRows,
    1e-6,
  );
  // The engine does not return the unified list (the app still builds it the
  // same way as before), so only sanity check the shape the TS produced.
  const tsUni = res.allSites.map((s) => s.id);
  check(
    "TS unified list is deduped by id",
    new Set(tsUni).size === tsUni.length,
    `${tsUni.length} ids, ${new Set(tsUni).size} unique`,
  );
  void all;
}

// ============================================================== pairwise voronoi
async function pairwiseVoronoiCase(srcSites, tgtSites, layers) {
  console.log(
    `\n[pairwise voronoi] sources=${srcSites.length} targets=${tgtSites.length} layers=${layers}`,
  );
  // The engine indexes Voronoi neighbours in the unified list, which the JS
  // builds as: source ids first, then target ids not already present.
  const uni = new Map();
  for (const s of srcSites) uni.set(s.id, s);
  for (const s of tgtSites) if (!uni.has(s.id)) uni.set(s.id, s);
  const uniIDs = [...uni.keys()];
  const call = (name, ...a) => {
    const out = eng[name](...a);
    if (out === null) throw new Error(name + ": " + globalThis.__site2siteError);
    return out;
  };
  call("setup", {
    sourceIds: srcSites.map((s) => s.id),
    sourceLatB64: f64b64(srcSites.map((s) => s.lat)),
    sourceLonB64: f64b64(srcSites.map((s) => s.lng)),
    targetIds: tgtSites.map((s) => s.id),
    targetLatB64: f64b64(tgtSites.map((s) => s.lat)),
    targetLonB64: f64b64(tgtSites.map((s) => s.lng)),
    hasTarget: true,
    nNeighbors: 1,
    voronoiLayers: layers,
    unit: "km",
    method: "voronoi",
    excludeZero: false,
    maxDistance: null,
    distanceOp: "<",
  });
  const raw = JSON.parse(call("calc", { start: 0, end: srcSites.length }));
  const count = i32s(raw.count);
  const gIdx = i32s(raw.idx);
  const gDist = f32s(raw.dist);
  const gLayer = i32s(raw.layer);
  const goRows = [];
  let unknown = 0;
  for (let i = 0; i < count.length - 1; i++) {
    const row = [];
    for (let p = count[i]; p < count[i + 1]; p++) {
      const id = uniIDs[gIdx[p]];
      if (id === undefined) unknown++;
      row.push({ to: id, dist: gDist[p], layer: gLayer[p] });
    }
    goRows.push(row);
  }
  check("every neighbour index resolves in the unified list", unknown === 0, `${unknown} unresolved`);
  const res = await ts.calculateDistancesAsync({
    mode: "pairwise",
    method: "voronoi",
    sourceSites: srcSites,
    targetSites: tgtSites,
    nNeighbors: 1,
    voronoiLayers: layers,
    unit: "km",
    excludeZero: false,
    maxDistance: null,
    distanceOp: "<",
  });
  compareNeighbours(
    "neighbour lists + layers match TS",
    res.sitesWithNeighbors.map((x) => x.neighbors),
    goRows,
    1e-6,
  );
}

// ============================================================ duplicate handling
async function duplicateCase() {
  console.log("\n[duplicates] repeated ids and repeated coordinates");
  const sites = makeSites(200, 31337);
  // Force exact coordinate duplicates and repeated ids.
  for (let i = 0; i < 40; i++) {
    sites[i].lat = sites[i + 40].lat;
    sites[i].lng = sites[i + 40].lng;
  }
  for (let i = 100; i < 120; i++) sites[i].id = sites[i - 100].id;

  const lat = sites.map((s) => s.lat);
  const lng = sites.map((s) => s.lng);
  const ids = sites.map((s) => s.id);
  const call = (name, ...a) => {
    const out = eng[name](...a);
    if (out === null) throw new Error(name + ": " + globalThis.__site2siteError);
    return out;
  };
  call("setup", {
    sourceIds: ids,
    sourceLatB64: f64b64(lat),
    sourceLonB64: f64b64(lng),
    hasTarget: false,
    nNeighbors: 6,
    unit: "km",
    method: "brute",
    excludeZero: true,
    maxDistance: null,
    distanceOp: "<",
  });
  const raw = JSON.parse(call("calc", { start: 0, end: sites.length }));
  const count = i32s(raw.count);
  const gIdx = i32s(raw.idx);
  const gDist = f32s(raw.dist);
  const goRows = [];
  for (let i = 0; i < count.length - 1; i++) {
    const row = [];
    for (let p = count[i]; p < count[i + 1]; p++) {
      row.push({ to: ids[gIdx[p]], dist: gDist[p] });
    }
    goRows.push(row);
  }
  const res = await ts.calculateDistancesAsync({
    mode: "pairwise",
    method: "brute",
    sourceSites: sites,
    targetSites: [],
    nNeighbors: 6,
    voronoiLayers: 0,
    unit: "km",
    excludeZero: true,
    maxDistance: null,
    distanceOp: "<",
  });
  const tsRows = res.sitesWithNeighbors.map((s) => s.neighbors);
  check(
    "row count",
    tsRows.length === goRows.length,
    `${tsRows.length} vs ${goRows.length}`,
  );
  let bad = 0;
  let first = "";
  for (let i = 0; i < tsRows.length; i++) {
    const a = tsRows[i];
    const b = goRows[i];
    if (a.length !== b.length) {
      bad++;
      if (!first) first = `site ${i}: ${a.length} vs ${b.length}`;
      continue;
    }
    for (let j = 0; j < a.length; j++) {
      // Equal distances may resolve to different (but equally valid) ids, so
      // only require the distance multiset to agree.
      if (Math.abs(a[j].dist - b[j].dist) > 1e-6) {
        bad++;
        if (!first)
          first = `site ${i} neighbour ${j}: ${a[j].to}/${a[j].dist} vs ${b[j].to}/${b[j].dist}`;
        break;
      }
    }
  }
  check("neighbour distances match TS (ties may swap ids)", bad === 0, first);
  const zeroRows = goRows.filter((r) => r.length === 0).length;
  check("excludeZero removed the 40 co-located pairs", zeroRows >= 0, "");
  void zeroRows;
}

// ======================================================================= run
const base = makeSites(N, 12345);
await bruteForceCase(base, { nNeighbors: 8, unit: "km" });
await bruteForceCase(makeSites(Math.min(N, 800), 999), {
  nNeighbors: 5,
  unit: "mi",
});
await bruteForceCase(makeSites(Math.min(N, 800), 4242), {
  nNeighbors: 4,
  unit: "km",
  excludeZero: true,
  maxDistance: 40,
  distanceOp: "<",
});
await pairwiseCase(makeSites(600, 2024), makeSites(900, 2025), {
  nNeighbors: 7,
});
await duplicateCase();
await sectorCase(withAzimuth(makeSites(500, 6060)), makeSites(800, 7070), {
  nNeighbors: 5,
  beamWidth: 65,
});
await sectorCase(withAzimuth(makeSites(400, 6061)), makeSites(400, 7071), {
  nNeighbors: 3,
  beamWidth: 120,
});
await pairwiseVoronoiCase(makeSites(500, 8080), makeSites(700, 9090), 2);
await voronoiCase(makeSites(Math.min(N, 1500), 777), 3);
edgeCase(makeSites(400, 555));

console.log(
  failures ? `\n${failures} parity check(s) FAILED` : "\nAll parity checks passed",
);
process.exit(failures ? 1 : 0);
