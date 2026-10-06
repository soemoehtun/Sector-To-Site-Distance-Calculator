/**
 * Engine facade.
 *
 * Every function here returns null when the WebAssembly engine is unavailable or
 * fails, and the caller falls back to the original JavaScript implementation.
 * That keeps the app working on browsers without WASM/DecompressionStream and
 * means a bad payload can never break the tool.
 */
import type {
  Connection,
  Dataset,
  DistanceUnit,
  Row,
  Site,
} from "@/types";

import type { VoronoiCellPolygonFeature } from "./voronoi";
import { call, warmEngine } from "./engineClient";

// Warming the pool at import time is what makes the first calculation feel
// instant, but a Worker cannot exist while server-rendering.
if (typeof window !== "undefined" && typeof Worker !== "undefined") {
  warmEngine();
}

/**
 * Test seam: makes every entry point below report "unavailable" so the
 * TypeScript fallback can be captured and compared against the engine.
 */
let engineDisabled = false;
export function __disableEngineForTest(disabled = true): void {
  engineDisabled = disabled;
}

/* -------------------------------------------------------------- primitives */

function f64ToB64(values: number[]): string {
  const f = new Float64Array(values);
  const bytes = new Uint8Array(f.buffer);
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function b64ToF64(b64: string): Float64Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float64Array(bytes.buffer);
}

function b64ToI32(b64: string): Int32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int32Array(bytes.buffer);
}

/* ------------------------------------------------------------------- setup */

export interface EngineSetup {
  sourceIds: string[];
  sourceLat: number[];
  sourceLon: number[];
  /** Per-source sector azimuth in degrees; NaN when no azimuth is mapped. */
  sourceAzimuth?: number[];
  /** Per-source sector beamwidth in degrees; NaN when no beamwidth is mapped. */
  sourceBeamwidth?: number[];
  targetIds?: string[];
  targetLat?: number[];
  targetLon?: number[];
  hasTarget: boolean;
  nNeighbors: number;
  voronoiLayers: number;
  /** Sector beam width in degrees (sector method). */
  beamWidth?: number;
  unit: DistanceUnit;
  method: "brute" | "voronoi" | "sector";
  excludeZero: boolean;
  maxDistance: number | null;
  distanceOp: string;
}

/** Loads the coordinates into the engine. Returns false if it is unavailable. */
export async function engineSetup(opts: EngineSetup): Promise<boolean> {
  if (engineDisabled) return false;
  const res = await call<boolean>("setup", {
    sourceIds: opts.sourceIds,
    sourceLatB64: f64ToB64(opts.sourceLat),
    sourceLonB64: f64ToB64(opts.sourceLon),
    sourceAzimuthB64: opts.sourceAzimuth ? f64ToB64(opts.sourceAzimuth) : undefined,
    sourceBeamwidthB64: opts.sourceBeamwidth ? f64ToB64(opts.sourceBeamwidth) : undefined,
    targetIds: opts.targetIds,
    targetLatB64: opts.targetLat ? f64ToB64(opts.targetLat) : undefined,
    targetLonB64: opts.targetLon ? f64ToB64(opts.targetLon) : undefined,
    hasTarget: opts.hasTarget,
    nNeighbors: opts.nNeighbors,
    voronoiLayers: opts.voronoiLayers,
    beamWidth: opts.beamWidth,
    unit: opts.unit,
    method: opts.method,
    excludeZero: opts.excludeZero,
    maxDistance: opts.maxDistance,
    distanceOp: opts.distanceOp,
  });
  return res === true;
}

export interface EngineRange {
  /** Neighbour ids, resolved through the caller's id list. */
  rows: { to: string; dist: number; layer: number }[][];
}

/**
 * Computes neighbours for source indices [start,end).
 *
 * The engine keeps the whole dataset in wasm memory between calls, so the
 * caller can split the work into ranges and still only pays the setup once.
 */
export async function engineCalcRange(
  idOf: (index: number) => string,
  start: number,
  end: number,
): Promise<EngineRange | null> {
  if (engineDisabled) return null;
  const raw = await call<string>("calc", { start, end });
  if (!raw) return null;
  const parsed = JSON.parse(raw) as {
    count: string;
    idx: string;
    dist: string;
    layer: string;
  };
  const count = b64ToI32(parsed.count);
  const idx = b64ToI32(parsed.idx);
  const dist = b64ToF64(parsed.dist);
  const layer = b64ToI32(parsed.layer);
  const rows: EngineRange["rows"] = [];
  for (let i = 0; i + 1 < count.length; i++) {
    const row: EngineRange["rows"][number] = [];
    for (let p = count[i]; p < count[i + 1]; p++) {
      row.push({ to: idOf(idx[p]), dist: dist[p], layer: layer[p] });
    }
    rows.push(row);
  }
  return { rows };
}

/* ---------------------------------------------------------------- geometry */

export async function engineVoronoiCells(
  sites: Site[],
): Promise<VoronoiCellPolygonFeature[] | null> {
  if (engineDisabled) return null;
  const ids = sites.map((s) => s.id);
  const res = await call<{ features: VoronoiCellPolygonFeature[] }>(
    "voronoiCells",
    {
      ids,
      latB64: f64ToB64(sites.map((s) => s.lat)),
      lonB64: f64ToB64(sites.map((s) => s.lng)),
    },
  );
  return res ? res.features : null;
}



export async function engineCellsFor(
  sites: Site[],
  targets: string[],
): Promise<VoronoiCellPolygonFeature[] | null> {
  if (engineDisabled) return null;
  const res = await call<{ features: VoronoiCellPolygonFeature[] }>("cellsFor", {
    ids: sites.map((s) => s.id),
    latB64: f64ToB64(sites.map((s) => s.lat)),
    lonB64: f64ToB64(sites.map((s) => s.lng)),
    targets,
  });
  return res ? res.features : null;
}

/* ------------------------------------------------------------------ parsing */

interface EngineTable {
  fileName: string;
  columns: string[];
  rowCount: number;
  blobB64: string;
  offsetsB64: string;
  sheetName?: string;
  sheetNames?: string[];
}

/** Columnar table -> Dataset, mirroring how the parse worker builds its result. */
function tableToDataset(t: EngineTable): Dataset {
  const offsets = b64ToI32(t.offsetsB64);
  const bin = atob(t.blobB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const decoder = new TextDecoder();

  // offsets is a flat cumulative list: one entry per cell plus the final end,
  // so cell (row, col) spans offsets[row * cols + col] .. offsets[row * cols + col + 1].
  const cols = t.columns.length;

  // Every cell is a slice of one concatenated blob, so the blob is decoded once
  // here instead of once per cell. When the blob is all single-byte UTF-8 the
  // byte offsets are also string offsets, and slicing is dramatically cheaper
  // than a TextDecoder call - which was the single biggest cost of loading a
  // large file. Non-ASCII blobs (the offsets no longer line up) fall back to
  // decoding each cell.
  const blob = decoder.decode(bytes);
  const singleByte = blob.length === bytes.length;

  const rows: Row[] = new Array(t.rowCount);
  for (let r = 0; r < t.rowCount; r++) {
    const row: Row = {};
    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      const at = base + c;
      const start = offsets[at];
      const end = offsets[at + 1];
      row[t.columns[c]] = singleByte
        ? blob.slice(start, end)
        : decoder.decode(bytes.subarray(start, end));
    }
    rows[r] = row;
  }
  return {
    fileName: t.fileName,
    columns: t.columns,
    rows,
    sheetName: t.sheetName,
    sheetNames: t.sheetNames,
  };
}

/**
 * Parses a File with the engine. Returns null when the engine is unavailable or
 * the format is one it does not handle (legacy .xls), so the caller can use the
 * SheetJS/PapaParse worker.
 */
export async function engineParseFile(
  file: File,
  sheetName?: string,
): Promise<Dataset | null> {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let method: string;
  if (ext === "csv" || ext === "txt") method = "parseText";
  else if (ext === "xlsx") method = "parseXlsx";
  else if (ext === "kml") method = "parseKml";
  else if (ext === "gpx") method = "parseGpx";
  else return null;

  // Positional, because the bytes have to survive structured cloning intact.
  // The buffer is transferred rather than copied: for a 50 MB workbook the copy
  // on its own was a visible pause before any parsing began.
  const res = await call<string>(
    method,
    [bytes, file.name, sheetName ?? ""],
    [buf],
  );
  if (!res) return null;
  try {
    return tableToDataset(JSON.parse(res) as EngineTable);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ exports */

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface EngineKmzOptions {
  fileName: string;
  sites: Site[];
  /** Per-site neighbour list, used for the KML popup. */
  neighborsBySite: Map<string, { to: string; dist: number; layer: number }[]>;
  connections: Connection[];
  distanceUnit: DistanceUnit;
  calcMethod: "brute" | "voronoi" | "sector" | "face";
  hasTarget: boolean;
  sourceIcon: { color: string; opacity: number; scale: number };
  neighborIcon: { color: string; opacity: number; scale: number };
  lineColor: string;
  lineOpacity: number;
  lineThickness: number;
  showVoronoi: boolean;
  popupColumns: string[];
  popupColumnsTarget: string[];
  /** Voronoi cell polygons (voronoi mode only). */
  voronoiPolygons?: VoronoiCellPolygonFeature[];
}

export async function engineBuildKmz(
  opts: EngineKmzOptions,
): Promise<Uint8Array | null> {
  if (engineDisabled) return null;
  const res = await call<string>("buildKmz", {
    fileName: opts.fileName,
    sourceIcon: opts.sourceIcon,
    neighborIcon: opts.neighborIcon,
    lineColor: opts.lineColor,
    lineOpacity: opts.lineOpacity,
    lineThickness: opts.lineThickness,
    hasTarget: opts.hasTarget,
    showVoronoi: opts.showVoronoi,
    distanceUnit: opts.distanceUnit,
    calcMethod: opts.calcMethod,
    sites: opts.sites.map((s) => ({
      id: s.id,
      lat: s.lat,
      lon: s.lng,
      isSource: s.isSource,
      isTarget: s.isTarget,
      fields: (opts.hasTarget && s.isTarget && !s.isSource
        ? opts.popupColumnsTarget
        : opts.popupColumns
      )
        .map((c) => [c, s.originalData?.[c] === undefined ? "" : String(s.originalData[c])] as [string, string])
        .filter(([, v]) => v !== ""),
      neighbors: (opts.neighborsBySite.get(s.id) ?? []).map((n) => ({
        to: n.to,
        // The KML popup prints the distance rounded to 3 decimals, same as the
        // JS writer.
        dist: Number(n.dist.toFixed(3)),
        layer: n.layer,
      })),
    })),
    connections: opts.connections.map((c) => ({
      from: c.from,
      to: c.to,
      distance: c.distance,
    })),
    voronoiEdges: [],
    voronoiPolygons: (opts.voronoiPolygons ?? []).map((f) => ({
      siteId: f.properties.siteId,
      ring: f.geometry.coordinates[0].map((pt) => [pt[0], pt[1]] as [number, number]),
    })),
  });
  return res ? fromBase64(res) : null;
}


export interface EngineXlsxRow {
  source: string;
  target: string;
  layer: number;
  dist: number;
}

export async function engineBuildXlsx(
  rows: EngineXlsxRow[],
  distanceUnit: DistanceUnit,
  calcMethod: "brute" | "voronoi" | "sector" | "face",
): Promise<Uint8Array | null> {
  if (engineDisabled) return null;
  const res = await call<string>("buildXlsx", {
    distanceUnit,
    calcMethod,
    rows: rows.map((r) => ({
      source: r.source,
      target: r.target,
      layer: r.layer,
      dist: r.dist,
    })),
  });
  return res ? fromBase64(res) : null;
}

export { toBase64 };
