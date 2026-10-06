/**
 * parse.ts
 *
 * Main-thread parsing API.
 *
 * Heavy I/O (CSV, Excel, KML, GPX) is delegated to the Web Worker via
 * `parseFile()`. Pure helpers (detectColumns, uniqueValues, toNumber) remain
 * on the main thread since they are fast and synchronous.
 */

import type { Dataset, Row, Cell } from "@/types";
import ParseWorker from "@/workers/parse.worker?worker";
import type { ParseRequest } from "@/workers/parse.worker";

/* ----------------------------------------------------------------- hints */
const LAT_HINTS = [
  "latitude", "lat", "y", "lat_dd", "site_lat", "ycoord", "y_coord", "northing",
];
const LON_HINTS = [
  "longitude", "long", "lon", "lng", "x", "lon_dd", "site_lon",
  "xcoord", "x_coord", "easting",
];
const NAME_HINTS = [
  "site name", "sitename", "site_name", "name", "site", "site id",
  "site_id", "id", "label", "title",
];
const CAT_HINTS = [
  "category", "type", "class", "status", "group",
  "region", "operator", "band", "layer", "zone",
];

const norm = (s: string) => s.toLowerCase().replace(/[\s._-]+/g, "");

function pick(columns: string[], hints: string[]): string {
  const normalized = columns.map((c) => ({ raw: c, n: norm(c) }));
  for (const h of hints) {
    const hn = norm(h);
    const exact = normalized.find((c) => c.n === hn);
    if (exact) return exact.raw;
  }
  for (const h of hints) {
    const hn = norm(h);
    const partial = normalized.find((c) => c.n.includes(hn));
    if (partial) return partial.raw;
  }
  return "";
}

/* -------------------------------------------------------------- utilities */

export function toNumber(value: Cell): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).trim().replace(/,/g, "").replace(/[°\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * What a column sniffer can find. This is deliberately richer than
 * `ColumnMapping` (which is only what the map needs to draw a site) and is not
 * interchangeable with it.
 */
export interface DetectedColumns {
  lat: string;
  lon: string;
  name: string;
  category: string;
  popup: string[];
}

export function detectColumns(dataset: Dataset): DetectedColumns {
  const cols = dataset.columns;
  let lat = pick(cols, LAT_HINTS);
  let lon = pick(cols, LON_HINTS);

  // Validate numerically — swap if detected columns appear transposed.
  const sample = dataset.rows.slice(0, 40);
  const scoreAs = (col: string, max: number) => {
    if (!col) return 0;
    let ok = 0;
    let seen = 0;
    for (const r of sample) {
      const n = toNumber(r[col]);
      if (n === null) continue;
      seen++;
      if (Math.abs(n) <= max) ok++;
    }
    return seen === 0 ? 0 : ok / seen;
  };
  if (lat && lon && scoreAs(lat, 90) < 0.6 && scoreAs(lon, 90) > 0.6) {
    const t = lat;
    lat = lon;
    lon = t;
  }

  const nameCandidates = NAME_HINTS.filter(
    (h) => norm(h) !== norm(lat) && norm(h) !== norm(lon),
  );
  let name = pick(
    cols.filter((c) => c !== lat && c !== lon),
    nameCandidates,
  );
  if (!name) name = cols.filter((c) => c !== lat && c !== lon)[0] ?? "";

  const category = pick(
    cols.filter((c) => c !== lat && c !== lon && c !== name),
    CAT_HINTS,
  );

  const popup = cols.filter((c) => c !== lat && c !== lon).slice(0, 6);
  return { lat, lon, name, category, popup };
}

export function uniqueValues(rows: Row[], column: string): string[] {
  if (!column) return [];
  const set = new Set<string>();
  for (const r of rows) {
    const v = String(r[column] ?? "").trim();
    set.add(v === "" ? "(blank)" : v);
  }
  return Array.from(set).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

/* ---------------------------------------------------------- type helpers */

export function isExcel(file: File): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ["xlsx", "xls", "xlsm", "ods"].includes(ext);
}

export function isKml(file: File): boolean {
  return (file.name.split(".").pop()?.toLowerCase() ?? "") === "kml";
}

export function isGpx(file: File): boolean {
  return (file.name.split(".").pop()?.toLowerCase() ?? "") === "gpx";
}

/**
 * The old binary workbook formats the Go engine does not read - SheetJS handles
 * those in the fallback worker.
 */
export function isLegacyExcel(file: File): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ["xls", "xlsm", "ods"].includes(ext);
}

/* ------------------------------------------------------- worker dispatch */

/**
 * The fallback worker is created once and reused. It carries PapaParse, SheetJS
 * and togeojson, so making a new one per parse re-evaluated that whole bundle
 * every time - visible as a stall on each file load and on every worksheet
 * switch.
 */
let parseWorker: Worker | null = null;
let parseWorkerBroken = false;

function getParseWorker(): Worker {
  if (!parseWorker) {
    parseWorker = new ParseWorker();
    // A module-level failure means every later parse would fail the same way.
    parseWorker.onerror = () => {
      parseWorkerBroken = true;
    };
  }
  return parseWorker;
}

let parseQueue: Promise<unknown> = Promise.resolve();

function parseInWorker(
  file: File,
  kind: ParseRequest["kind"],
  sheetName?: string,
): Promise<Dataset> {
  if (parseWorkerBroken) {
    return Promise.reject(
      new Error("The fallback file reader could not be started."),
    );
  }

  const run = () =>
    new Promise<Dataset>((resolve, reject) => {
      const worker = getParseWorker();
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        worker.onmessage = null;
        fn();
      };

      worker.onmessage = (e: MessageEvent<{ type: string; payload: unknown }>) => {
        const { type, payload } = e.data;
        if (type === "result") finish(() => resolve(payload as Dataset));
        else if (type === "error") finish(() => reject(new Error(payload as string)));
      };

      file
        .arrayBuffer()
        .then((buffer) => {
          if (settled) return;
          worker.postMessage(
            {
              type: "parse",
              payload: {
                kind,
                buffer,
                fileName: file.name,
                sheetName,
              } as ParseRequest,
            },
            [buffer],
          );
        })
        .catch((err: unknown) =>
          finish(() =>
            reject(
              err instanceof Error ? err : new Error("Could not read that file."),
            ),
          ),
        );
    });

  const next = parseQueue.then(run, run);
  parseQueue = next.then(() => {}, () => {});
  return next;
}

function kindFor(file: File): ParseRequest["kind"] | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "csv" || ext === "txt") return ext;
  if (isExcel(file)) return "excel";
  if (isKml(file)) return "kml";
  if (isGpx(file)) return "gpx";
  return null;
}

/**
 * Parse any supported file directly in the dedicated Web Worker.
 * Bypasses main-thread overhead and WASM boot latency for instant file importing.
 */
export async function parseFile(file: File): Promise<Dataset> {
  const kind = kindFor(file);
  if (!kind) return Promise.reject(unsupportedType(file));
  return parseInWorker(file, kind);
}

/**
 * Parse a specific Excel worksheet in the Web Worker.
 */
export function parseFileSheet(file: File, sheetName: string): Promise<Dataset> {
  return parseInWorker(file, "excel", sheetName);
}

function unsupportedType(file: File): Error {
  const ext = file.name.split(".").pop() ?? "";
  return new Error(
    `Unsupported file type ".${ext}". Please use CSV, XLSX, XLS, KML, or GPX.`,
  );
}
