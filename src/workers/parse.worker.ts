/**
 * parse.worker.ts
 *
 * Web Worker that handles all file parsing off the main thread:
 *   - CSV / TXT  → PapaParse
 *   - XLSX / XLS → SheetJS
 *   - KML        → @tmcw/togeojson
 *   - GPX        → @tmcw/togeojson
 *
 * Message protocol
 * ─────────────────
 * Incoming (main → worker):
 *   { type: "parse"; payload: ParseRequest }
 *
 * Outgoing (worker → main):
 *   { type: "result";  payload: Dataset }
 *   { type: "error";   payload: string  }
 *   { type: "progress"; payload: number } (0–100, during large CSV parsing)
 */

import Papa from "papaparse";
import * as XLSX from "xlsx";
import { kml as toGeoJsonKml, gpx as toGeoJsonGpx } from "@tmcw/togeojson";
import type { Dataset, Row, Cell } from "@/types";

export type ParseRequest =
  | { kind: "csv" | "txt"; buffer: ArrayBuffer; fileName: string }
  | { kind: "excel"; buffer: ArrayBuffer; fileName: string; sheetName?: string }
  | { kind: "kml" | "gpx"; buffer: ArrayBuffer; fileName: string };

/* ------------------------------------------------------------------ helpers */

const cleanRows = (
  raw: Record<string, unknown>[],
  columns: string[],
): Row[] => {
  const n = raw.length;
  const numCols = columns.length;
  const out: Row[] = new Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = raw[i];
    if (!r) continue;
    let hasContent = false;
    const row: Row = {};
    for (let c = 0; c < numCols; c++) {
      const col = columns[c];
      const v = r[col];
      if (v !== undefined && v !== null && v !== "") {
        hasContent = true;
        row[col] = v as Cell;
      } else {
        row[col] = "";
      }
    }
    if (hasContent) {
      out[count++] = row;
    }
  }
  out.length = count;
  return out;
};

/* -------------------------------------------------------------------- CSV */

function parseCsv(buffer: ArrayBuffer, fileName: string): Promise<Dataset> {
  return new Promise((resolve, reject) => {
    let text = new TextDecoder("utf-8").decode(buffer);
    // Strip outer whole-line quotation marks if lines were exported like: "Site 1,96.08,16.97,..."
    text = text.replace(/^"([^"\r\n]*)"(?=\r?$)/gm, "$1");

    Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: "greedy",
      dynamicTyping: false,
      transformHeader: (h) => h.trim(),
      complete: (results) => {
        const columns = (results.meta.fields ?? []).filter(
          (f) => f && f.trim() !== "",
        );
        if (!columns.length) {
          reject(new Error("No columns found in file."));
          return;
        }
        resolve({
          fileName,
          columns,
          rows: cleanRows(results.data, columns),
        });
      },
      error: (err: Error) => reject(err),
    });
  });
}

/* ------------------------------------------------------------------ Excel */

function parseExcel(
  buffer: ArrayBuffer,
  fileName: string,
  targetSheetName?: string,
): Dataset {
  const wb = XLSX.read(new Uint8Array(buffer), {
    type: "array",
    cellFormula: false,
    cellHTML: false,
    cellText: false,
    dense: true,
  });
  if (!wb.SheetNames.length) throw new Error("This workbook has no worksheets.");

  const sheetName = targetSheetName ?? wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`Worksheet "${sheetName}" was not found.`);

  const data = (sheet as { "!data"?: { v?: unknown }[][] })["!data"];
  let matrix: unknown[][];
  if (data && Array.isArray(data)) {
    matrix = data.map((row) =>
      row ? row.map((cell) => (cell ? cell.v ?? "" : "")) : [],
    );
  } else {
    matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: "",
    });
  }
  if (!matrix.length) throw new Error(`Worksheet "${sheetName}" is empty.`);

  const headerRow = (matrix[0] as unknown[]).map((h, i) =>
    String(h ?? "").trim() === "" ? `Column ${i + 1}` : String(h).trim(),
  );
  const numCols = headerRow.length;

  const rows: Row[] = new Array(matrix.length - 1);
  let count = 0;
  for (let i = 1; i < matrix.length; i++) {
    const arr = matrix[i] as unknown[];
    if (!arr || !arr.length) continue;
    let hasVal = false;
    const row: Row = {};
    for (let c = 0; c < numCols; c++) {
      const v = arr[c];
      if (v !== undefined && v !== null && v !== "") {
        hasVal = true;
        row[headerRow[c]] = v as Cell;
      } else {
        row[headerRow[c]] = "";
      }
    }
    if (hasVal) rows[count++] = row;
  }
  rows.length = count;

  return {
    fileName,
    columns: headerRow,
    rows,
    sheetName,
    sheetNames: wb.SheetNames,
  };
}

/* ------------------------------------------------------------------- KML */

function parseKml(buffer: ArrayBuffer, fileName: string): Dataset {
  const xml = new TextDecoder("utf-8").decode(buffer);
  const dom = new DOMParser().parseFromString(xml, "text/xml");
  const geojson = toGeoJsonKml(dom);

  return geoJsonToDataset(geojson, fileName);
}

/* ------------------------------------------------------------------- GPX */

function parseGpx(buffer: ArrayBuffer, fileName: string): Dataset {
  const xml = new TextDecoder("utf-8").decode(buffer);
  const dom = new DOMParser().parseFromString(xml, "text/xml");
  const geojson = toGeoJsonGpx(dom);

  return geoJsonToDataset(geojson, fileName);
}

/* ----------------------------------------- GeoJSON FeatureCollection → Dataset */

function geoJsonToDataset(
  // togeojson types geometries as nullable; the filter below drops the nulls.
  geojson: GeoJSON.FeatureCollection<GeoJSON.Geometry | null, GeoJSON.GeoJsonProperties>,
  fileName: string,
): Dataset {
  const pointFeatures = geojson.features.filter(
    (f) => f.geometry && f.geometry.type === "Point",
  );

  if (!pointFeatures.length) {
    throw new Error(
      "No point features found in the file. Only Point geometries are supported.",
    );
  }

  // Collect all property keys across all features
  const keySet = new Set<string>(["Latitude", "Longitude"]);
  for (const f of pointFeatures) {
    for (const k of Object.keys(f.properties ?? {})) {
      keySet.add(k);
    }
  }
  const columns = Array.from(keySet);

  const rows: Row[] = pointFeatures.map((f) => {
    const coords = (f.geometry as GeoJSON.Point).coordinates;
    const lon = coords[0];
    const lat = coords[1];
    const props = f.properties ?? {};
    const row: Row = { Latitude: lat, Longitude: lon };
    for (const k of columns) {
      if (k === "Latitude" || k === "Longitude") continue;
      const v = props[k];
      row[k] = v === undefined || v === null ? "" : (v as Cell);
    }
    return row;
  });

  return { fileName, columns, rows };
}

/* --------------------------------------------------------- message handler */

self.onmessage = async (
  e: MessageEvent<{ type: "parse"; payload: ParseRequest }>,
) => {
  const { type, payload } = e.data;
  if (type !== "parse") return;

  try {
    let dataset: Dataset;

    switch (payload.kind) {
      case "csv":
      case "txt":
        dataset = await parseCsv(payload.buffer, payload.fileName);
        break;
      case "excel":
        dataset = parseExcel(payload.buffer, payload.fileName, payload.sheetName);
        break;
      case "kml":
        dataset = parseKml(payload.buffer, payload.fileName);
        break;
      case "gpx":
        dataset = parseGpx(payload.buffer, payload.fileName);
        break;
      default:
        throw new Error("Unknown file kind.");
    }

    self.postMessage({ type: "result", payload: dataset });
  } catch (err) {
    self.postMessage({
      type: "error",
      payload: err instanceof Error ? err.message : "Could not read that file.",
    });
  }
};
