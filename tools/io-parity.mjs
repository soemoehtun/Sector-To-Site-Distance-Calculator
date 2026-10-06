/**
 * I/O parity harness: parsing and export.
 *
 *   node tools/io-parity.mjs
 *
 * Runs the Go parsers/writers and the JavaScript ones (PapaParse, SheetJS,
 * JSZip) on the same inputs in the same process and compares the results, plus
 * verifies that the embedded wasm payload really is the compiled engine.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "node_modules", ".cache", "io-parity");
fs.mkdirSync(tmp, { recursive: true });

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log("  ok   " + label);
  else {
    failures++;
    console.log("  FAIL " + label + (detail ? "\n       " + detail : ""));
  }
}

/* ------------------------------------------------ 1. the embedded payload */

console.log("\n[payload]");
const wasmTs = fs.readFileSync(path.join(root, "src", "wasm", "engineWasm.ts"), "utf8");
const b64 = wasmTs
  .slice(wasmTs.indexOf('"') + 1, wasmTs.lastIndexOf('"'))
  .replace(/"\s*\+\s*\n\s*"/g, "");
const gz = zlib.gzipSync(Buffer.from("round trip", "utf8"), { level: 9 });
void gz;
const bytes = zlib.gunzipSync(Buffer.from(b64, "base64"));
check(
  "base64 payload gunzips to a wasm module",
  bytes.subarray(0, 4).toString("hex") === "0061736d",
  `magic=${bytes.subarray(0, 4).toString("hex")}`,
);
const fresh = execFileSync(
  "go",
  ["-C", "engine", "build", "-trimpath", "-ldflags=-s -w", "-o", "/dev/stdout", "."],
  { env: { ...process.env, GOOS: "js", GOARCH: "wasm" }, maxBuffer: 64 * 1024 * 1024 },
);
check(
  "payload is byte-identical to a fresh build",
  Buffer.compare(bytes, fresh) === 0,
  `${bytes.length} vs ${fresh.length} bytes`,
);

/* ------------------------------------------------- 2. the engine in node */

const goroot = execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim();
require(path.join(goroot, "lib", "wasm", "wasm_exec.js"));
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
go.run(instance).catch(() => {});
for (let i = 0; i < 200 && !globalThis.__site2site; i++) {
  await new Promise((r) => setTimeout(r, 10));
}
const eng = globalThis.__site2site;
const call = (name, ...args) => {
  const out = eng[name](...args);
  if (out === null || out === undefined) {
    throw new Error(name + ": " + globalThis.__site2siteError);
  }
  return out;
};
const tableToRows = (t) => {
  const bin = atob(t.blobB64);
  const blob = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) blob[i] = bin.charCodeAt(i);
  const b64o = atob(t.offsetsB64);
  const offs = new Int32Array(b64o.length);
  for (let i = 0; i < b64o.length; i++) offs[i] = b64o.charCodeAt(i) | 0;
  const dec = new TextDecoder();
  const rows = [];
  for (let r = 0; r < t.rowCount; r++) {
    const row = [];
    for (let c = 0; c < t.columns.length; c++) {
      const at = r * t.columns.length + c;
      row.push(dec.decode(blob.subarray(offs[at], offs[at + 1])));
    }
    rows.push(row);
  }
  return { columns: t.columns, rows };
};
const enc = (s) => new TextEncoder().encode(s);

/* ------------------------------------------------------ 3. the JS bundle */

const entry = path.join(tmp, "io.ts");
fs.writeFileSync(entry, fs.readFileSync(path.join(root, "tools", "io-entry.ts")));
const out = path.join(tmp, "io.mjs");
execFileSync(
  path.join(root, "node_modules", ".bin", "esbuild"),
  [
    entry,
    "--bundle",
    "--format=esm",
    "--platform=node",
    "--external:*worker&inline",
    "--outfile=" + out,
    "--alias:@=" + path.join(root, "src"),
    "--alias:file-saver=" + path.join(root, "tools", "shims", "file-saver.ts"),
    "--external:worker-loader",
    "--loader:.css=empty",
    "--log-level=warning",
  ],
  { stdio: "inherit" },
);
const js = await import(url.pathToFileURL(out).href);
void js.parseFile;

/* ------------------------------------------------------------ 4. parsing */

console.log("\n[parse csv]");
const csv = [
  "Site,Latitude,Longitude,Region",
  "A,16.8661,96.1951,North",
  "B,16.9700,96.1000,South",
  "C,17.0500,96.5000,East",
  "D,15.8000,95.9000,West",
  "",
  ",,,",
  "E,16.0000,94.0000,Extra",
].join("\n");
const goCsv = tableToRows(JSON.parse(call("parseText", enc(csv), "sites.csv")));
const Papa = (await import(path.join(root, "node_modules", "papaparse", "package.json"), { with: { type: "json" } })).default;
const papa = Papa.default.parse(csv, { header: true, skipEmptyLines: "greedy" });
check(
  "csv columns match PapaParse",
  JSON.stringify(goCsv.columns) === JSON.stringify(papa.meta.fields),
  JSON.stringify(goCsv.columns) + " vs " + JSON.stringify(papa.meta.fields),
);
check(
  "csv rows match PapaParse",
  goCsv.rows.length === papa.data.length &&
    goCsv.rows.every((r, i) => JSON.stringify(r) === JSON.stringify(papa.data[i])),
  JSON.stringify(goCsv.rows) + " vs " + JSON.stringify(papa.data),
);
check("csv drops the blank rows", goCsv.rows.length === 5, `${goCsv.rows.length} rows`);

console.log("\n[parse xlsx]");
const XLSX = require(path.join(root, "node_modules", "xlsx"));
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    ["Site", "Latitude", "Longitude", "Band"],
    ["A", 16.8661, 96.1951, 700],
    ["B", 16.97, 96.1, 1800],
    ["C", 17.05, 96.5, 2600],
  ]),
  "Sheet1",
);
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x", "y"], [1, 2]]), "Second");
const xlsxBuf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
const goXlsx = JSON.parse(call("parseXlsx", new Uint8Array(xlsxBuf), "sites.xlsx", "Sheet1"));
const goXlsxRows = tableToRows(goXlsx);
const refXlsx = XLSX.read(xlsxBuf, { type: "buffer" });
const refSheet = XLSX.utils.sheet_to_json(refXlsx.Sheets.Sheet1, { header: 1, raw: false });
check(
  "xlsx columns match SheetJS",
  JSON.stringify(goXlsxRows.columns) === JSON.stringify(refSheet[0]),
  JSON.stringify(goXlsxRows.columns) + " vs " + JSON.stringify(refSheet[0]),
);
check(
  "xlsx rows match SheetJS",
  JSON.stringify(goXlsxRows.rows) === JSON.stringify(refSheet.slice(1)),
  JSON.stringify(goXlsxRows.rows) + " vs " + JSON.stringify(refSheet.slice(1)),
);
check("xlsx lists the worksheets", (goXlsx.sheetNames || []).length === 2, JSON.stringify(goXlsx.sheetNames));

console.log("\n[parse kml/gpx]");
const kml = `<?xml version="1.0"?><kml><Document>
<Placemark><name>Alpha</name><Point><coordinates>96.1951,16.8661,0</coordinates></Point></Placemark>
<Placemark><name>Beta</name><Point><coordinates>96.1000,16.9700,0</coordinates></Point></Placemark>
</Document></kml>`;
const goKml = tableToRows(JSON.parse(call("parseKml", enc(kml), "sites.kml")));
const { default: togeojson } = await import("@togeojson/togeojson");
const kmlFc = togeojson.kml(kml);
const kmlRef = kmlFc.features.map((f) => [
  f.properties.name,
  f.geometry.coordinates[1],
  f.geometry.coordinates[0],
]);
check(
  "kml points match togeojson",
  JSON.stringify(goKml.rows) === JSON.stringify(kmlRef),
  JSON.stringify(goKml.rows) + " vs " + JSON.stringify(kmlRef),
);
const gpx = `<?xml version="1.0"?><gpx><trkpt lat="16.5" lon="96.1"><name>TP1</name></trkpt>
<wpt lat="16.6" lon="96.2"><name>W1</name></wpt></gpx>`;
const goGpx = tableToRows(JSON.parse(call("parseGpx", enc(gpx), "sites.gpx")));
check("gpx finds both point types", goGpx.rows.length === 2, JSON.stringify(goGpx.rows));

/* ------------------------------------------------------------ 5. export */

console.log("\n[export xlsx]");
const sitesWithNeighbors = [
  {
    id: "A",
    lat: 16.8,
    lng: 96.2,
    isSource: true,
    isTarget: true,
    isNeighbor: false,
    neighbors: [
      { to: "B", dist: 12.3456 },
      { to: "C", dist: 40.9876 },
    ],
  },
  {
    id: "B",
    lat: 16.9,
    lng: 96.3,
    isSource: true,
    isTarget: true,
    isNeighbor: true,
    neighbors: [
      { to: "A", dist: 12.3456, layer: 1 },
      { to: "D", dist: 3.5, layer: 1 },
      { to: "E", dist: 88.0, layer: 2 },
    ],
  },
];
await js.exportExcelFile(sitesWithNeighbors, "km", "voronoi", "go.xlsx");
const goXlsxFile = await globalThis.__lastSave;
const goSheet = readSheetRows(goXlsxFile.bytes);
const refWb = XLSX.read(
  (await js.exportExcelFile(
    sitesWithNeighbors,
    "km",
    "voronoi",
    "ref.xlsx",
  )) && ((await globalThis.__lastSave), (await globalThis.__lastSave)).bytes,
  { type: "array" },
);
const refRows = XLSX.utils.sheet_to_json(refWb.Sheets.Detailed_Distances, {
  header: 1,
  raw: true,
});
check(
  "xlsx sheet rows identical",
  JSON.stringify(goSheet) === JSON.stringify(refRows),
  JSON.stringify(goSheet) + "\n       vs " + JSON.stringify(refRows),
);

console.log("\n[export kmz]");
const kmzOpts = {
  filename: "distances.kmz",
  sourceIcon: { url: "circle", color: "#22c55e", opacity: 1, scale: 1 },
  neighborIcon: { url: "circle", color: "#ef4444", opacity: 0.8, scale: 1.2 },
  allSites: sitesWithNeighbors,
  sitesWithNeighbors,
  connections: [
    { from: "A", to: "B", distance: 12.3456 },
    { from: "A", to: "C", distance: 40.9876 },
  ],
  lineColor: "#2563eb",
  lineThickness: 2,
  lineOpacity: 80,
  showVoronoi: true,
  voronoiEdges: [
    { lat1: 16.8, lng1: 96.2, lat2: 16.9, lng2: 96.3, siteA: "A", siteB: "B" },
  ],
  distanceUnit: "km",
  calcMethod: "voronoi",
  voronoiLayers: 2,
  nNeighbors: 3,
  popupColumns: new Set(["Band"]),
  popupColumnsTarget: new Set(["Band"]),
  hasTarget: false,
};
await js.exportKmzFile(kmzOpts);
const goKmz = (await globalThis.__lastSave).bytes;
const goKmlText = await firstEntry(goKmz, "doc.kml");
check("kmz contains doc.kml", goKmlText.startsWith("<?xml"), goKmlText.slice(0, 60));
check("kmz lists every site", (goKmlText.match(/<Placemark>/g) || []).length >= 2);
check("kmz writes the connections", goKmlText.includes("<LineString>"));
check("kmz writes voronoi edges", goKmlText.includes("#voronoiEdgeStyle"));

console.log(
  failures ? `\n${failures} check(s) FAILED` : "\nAll I/O parity checks passed",
);
process.exit(failures ? 1 : 0);

/* ------------------------------------------------------------------ utils */

function readSheetRows(xlsxBytes) {
  const wb = XLSX.read(xlsxBytes, { type: "array" });
  return XLSX.utils.sheet_to_json(wb.Sheets.Detailed_Distances, { header: 1, raw: true });
}

async function firstEntry(zipBytes, name) {
  const JSZip = require(path.join(root, "node_modules", "jszip"));
  const z = await JSZip.loadAsync(zipBytes);
  const f = z.file(name);
  if (!f) throw new Error("missing " + name);
  return await f.async("string");
}
