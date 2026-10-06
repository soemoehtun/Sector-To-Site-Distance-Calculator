import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BeamRadiusMode,
  CalcMethod,
  CalcMode,
  CalculatedData,
  ColumnMapping,
  Connection,
  Dataset,
  DistanceOperator,
  DistanceUnit,
  FaceFilter,
  FacePair,
  NeighborResult,
  Site,
  SiteWithNeighbors,
} from "@/types";
import { PALETTE } from "@/types";
import { parseFile, parseFileSheet } from "@/lib/parse";
import { calculateDistancesAsync, getUnitMultiplier } from "@/lib/distance";
import { computeFaceToFace } from "@/lib/faceToFace";
import {
  exportExcelFile,
  exportKmzFile,
} from "@/lib/export";
import MapView from "@/components/MapView";
import { engineVoronoiCells } from "@/lib/engine";
import { computeAllVoronoiPolygons } from "@/lib/voronoi";
import { buildBeamPolygons } from "@/lib/beam";

const MATCHED_BEAM_COLOR = "#22c55e";
const UNMATCHED_BEAM_COLOR = "#ef4444";


/* ------------------------------------------------------------------ icons */
const I = {
  Menu: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  ),

  Upload: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  ),

  Columns: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  ),

  Style: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" />
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  ),

  Filter: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  ),

  Search: (p: { size?: number }) => (
    <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),

  X: (p: { size?: number }) => (
    <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),

  Export: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),

  Bolt: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),

  Trash: () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  ),

  Sheet: () => (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="9" x2="9" y2="21" />
    </svg>
  ),

  Cloud: () => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V4m0 0L8 8m4-4 4 4" /><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  ),

  FileSheet: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><path d="M8 13h8" /><path d="M8 17h8" />
    </svg>
  ),

  SectorBeam: (p: { size?: number }) => (
    <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20L4.5 7a10 10 0 0 1 15 0z" fill="currentColor" fillOpacity="0.15" />
      <path d="M12 20L4.5 7" />
      <path d="M12 20L19.5 7" />
      <path d="M4.5 7a10 10 0 0 1 15 0" />
      <circle cx="12" cy="20" r="1.5" fill="currentColor" />
    </svg>
  ),

  FaceToFace: (p: { size?: number }) => (
    <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h6M6 9l3 3-3 3" />
      <path d="M21 12h-6M18 9l-3 3 3 3" />
      <circle cx="2.5" cy="12" r="1" fill="currentColor" />
      <circle cx="21.5" cy="12" r="1" fill="currentColor" />
    </svg>
  ),

  AllSites: (p: { size?: number }) => (
    <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8.5 6h7M7.2 8.2l3.6 7.6M16.8 8.2l-3.6 7.6" />
    </svg>
  ),

  SourceTarget: (p: { size?: number }) => (
    <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="12" r="3" />
      <circle cx="19" cy="12" r="3" />
      <path d="M8 12h8m-3-3l3 3-3 3" />
    </svg>
  ),
};

/* ------------------------------------------------------------------ setup */
type Tab = "upload" | "columns" | "style" | "filter";
type FileKind = "source" | "target";

const TABS: { id: Tab; label: string; Icon: () => React.ReactElement }[] = [
  { id: "upload", label: "File Input", Icon: I.Upload },
  { id: "columns", label: "Fields", Icon: I.Columns },
  { id: "style", label: "Style", Icon: I.Style },
  { id: "filter", label: "Export", Icon: I.Filter },
];

const EMPTY_MAPPING: ColumnMapping = { id: "", lat: "", lng: "", azimuth: "", radius: "", beamwidth: "" };
const EMPTY_RESULTS: CalculatedData = { sitesWithNeighbors: [], allSites: [], connections: [] };

const MAP_FIELDS: { key: keyof ColumnMapping; label: string; hint: string; optional?: boolean }[] = [
  { key: "id", label: "Site Name", hint: "unique identifier" },
  { key: "lat", label: "Latitude", hint: "WGS84 · -90 to 90" },
  { key: "lng", label: "Longitude", hint: "WGS84 · -180 to 180" },
  { key: "azimuth", label: "Azimuth", hint: "sector beam · 0-360°", optional: true },
];

function guessMapping(columns: string[]): ColumnMapping {
  return {
    id:
      columns.find((c) => /^(site(\s*|_)?(name|id|code)?|name|id|code|cell(\s*|_)?(name|id|code)?|sector(\s*|_)?(name|id|code)?)$/i.test(c.trim())) ??
      columns.find((c) => /id|site|name|code|cell|sector/i.test(c.trim())) ??
      columns[0] ??
      "",
    lat:
      columns.find((c) => /^(lat(itude)?|y|northing|cell_lat|site_lat|target_lat|source_lat|wgs84_lat|lat_dd|ycoord|y_coord)$/i.test(c.trim())) ??
      columns.find((c) => /lat|northing/i.test(c.trim())) ??
      columns.find((c) => /^y$/i.test(c.trim())) ??
      "",
    lng:
      columns.find((c) => /^(lon(gitude)?|lng|long|x|easting|cell_lon|cell_lng|site_lon|site_lng|target_lon|target_lng|source_lon|source_lng|wgs84_lon|lon_dd|xcoord|x_coord)$/i.test(c.trim())) ??
      columns.find((c) => /lon|lng|long|easting/i.test(c.trim())) ??
      columns.find((c) => /^x$/i.test(c.trim())) ??
      "",
    azimuth:
      columns.find((c) => /^(azimuth|azi|az|bearing|dir|direction)$/i.test(c.trim())) ??
      columns.find((c) => /azimuth|azi|az$/i.test(c.trim())) ??
      "",
    beamwidth: "",
    radius: "",
  };
}

/** Muted gray used on the map for non-facing pairs. */
const NOT_FACE_COLOR = "#7c8a96";

/* ------------------------------------------------------------- primitives */
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="check-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

function ColorSwatches({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="mapping-field">
      <div className="mapping-label">
        <label>{label}</label>
        <span>{value.toUpperCase()}</span>
      </div>
      <div className="sw-row">
        {PALETTE.map((c) => (
          <button
            key={c}
            className={`sw ${value === c ? "active" : ""}`}
            style={{ background: c }}
            onClick={() => onChange(c)}
            title={c}
          />
        ))}
        <label className="sw sw-custom" title="Custom colour">
          <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
          <span style={{ background: value }} />
        </label>
      </div>
    </div>
  );
}

function FilePanel({
  fileName,
  data,
  loading,
  onFile,
  onSheet,
  onRemove,
}: {
  fileName: string;
  data: Dataset | null;
  loading: boolean;
  onFile: (f: File) => void;
  onSheet: (name: string) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const columns = data?.columns ?? [];

  return (
    <>
      <div
        className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        onClick={() => inputRef.current?.click()}
      >
        <I.Cloud />
        <strong>{loading ? "Parsing file…" : "Drop file to upload"}</strong>
        <span>CSV · XLSX · XLS · TXT · KML · GPX</span>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.txt,.xlsx,.xls,.kml,.gpx"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
      </div>

      {data && (
        <>
          <div style={{ marginTop: 18 }} className="source-summary">
            <div className="source-icon sheet">
              <I.Sheet />
            </div>
            <div>
              <strong>{fileName}</strong>
              <span>
                {data.sheetName ? `${data.sheetName} · ` : ""}
                {data.rows.length.toLocaleString()} rows · {columns.length} columns
              </span>
            </div>
          </div>

          {data.sheetNames && data.sheetNames.length > 1 && (
            <div className="sheet-picker">
              <div className="mapping-label">
                <label>Worksheet</label>
                <span>{data.sheetNames.length} sheets</span>
              </div>
              <select
                className="field-control"
                value={data.sheetName ?? ""}
                onChange={(e) => onSheet(e.target.value)}
              >
                {data.sheetNames.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <p className="field-help">Switching sheets reloads the columns and clears the current mapping.</p>
            </div>
          )}

          <div className="source-actions">
            <button onClick={() => inputRef.current?.click()}>Replace</button>
            <button className="danger" onClick={onRemove}>
              Remove
            </button>
          </div>
        </>
      )}
    </>
  );
}

function MappingFields({
  mapping,
  columns,
  onChange,
  validCount,
  totalCount,
}: {
  mapping: ColumnMapping;
  columns: string[];
  onChange: (m: ColumnMapping) => void;
  validCount: number;
  totalCount: number;
}) {
  return (
    <>
      {!columns.length && <p className="field-help">Upload a dataset first to map its columns.</p>}

      {MAP_FIELDS.map((f) => (
        <div className="mapping-field" key={f.key}>
          <div className="mapping-label">
            <label>
              {f.label}
              {f.optional ? <em style={{ fontStyle: "normal", color: "#64748b", fontWeight: 400 }}> (optional)</em> : <b>*</b>}
            </label>
            <span>{f.hint}</span>
          </div>
          <select
            className="field-control"
            value={mapping[f.key]}
            onChange={(e) => onChange({ ...mapping, [f.key]: e.target.value })}
            disabled={!columns.length}
          >
            <option value="">— Select column —</option>
            {columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      ))}

      {validCount > 0 && (
        <p className="field-help">
          <code>{validCount.toLocaleString()}</code> usable rows
          {totalCount > validCount ? ` · ${(totalCount - validCount).toLocaleString()} skipped` : ""}
        </p>
      )}
    </>
  );
}

function PopupFields({
  label,
  columns,
  selected,
  onChange,
}: {
  label: string;
  columns: string[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
}) {
  const toggle = (col: string) => {
    const next = new Set(selected);
    if (next.has(col)) next.delete(col);
    else next.add(col);
    onChange(next);
  };

  return (
    <>
      <div className="mapping-label">
        <label>{label}</label>
        <span>{selected.size} selected</span>
      </div>
      <div className="source-actions">
        <button onClick={() => onChange(new Set(columns))}>Select all</button>
        <button onClick={() => onChange(new Set<string>())}>Clear</button>
      </div>
      <div className="check-list" style={{ marginTop: 12 }}>
        {columns.map((col) => (
          <label className="check-row" key={col}>
            <input type="checkbox" checked={selected.has(col)} onChange={() => toggle(col)} />
            <span>
              <strong>{col}</strong>
            </span>
          </label>
        ))}
        {!columns.length && <div className="pg-empty" style={{ fontSize: 10 }}>No columns yet.</div>}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- app */
export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(
    typeof window === "undefined" ? true : window.innerWidth > 860,
  );
  const [tab, setTab] = useState<Tab>("upload");

  // Calculation settings
  const [calcMode, setCalcMode] = useState<CalcMode>("all");
  const [calcMethod, setCalcMethod] = useState<CalcMethod>("sector");
  const [beamWidth, setBeamWidth] = useState(65);
  const [beamRadiusMode, setBeamRadiusMode] = useState<BeamRadiusMode>("value");
  const [beamRadiusFixed, setBeamRadiusFixed] = useState(350);
  const [beamRadiusCol, setBeamRadiusCol] = useState("");
  const [beamRadiusCategoryMap, setBeamRadiusCategoryMap] = useState<Record<string, number>>({});
  const [beamRadiusCategoryDefault, setBeamRadiusCategoryDefault] = useState(150);
  const [voronoiLayers] = useState(1);
  const [nNeighbors, setNNeighbors] = useState(3);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>("km");
  const [excludeZero, setExcludeZero] = useState(true);
  const [maxDistance, setMaxDistance] = useState<number | null>(null);
  const [distanceOp, setDistanceOp] = useState<DistanceOperator>("<=");
  const [faceRows, setFaceRows] = useState<FacePair[] | null>(null);

  // Datasets
  const [sourceFileName, setSourceFileName] = useState("");
  const [sourceData, setSourceData] = useState<Dataset | null>(null);
  const [sourceMapping, setSourceMapping] = useState<ColumnMapping>(EMPTY_MAPPING);

  const [targetFileName, setTargetFileName] = useState("");
  const [targetData, setTargetData] = useState<Dataset | null>(null);
  const [targetMapping, setTargetMapping] = useState<ColumnMapping>(EMPTY_MAPPING);

  const [popupColumns, setPopupColumns] = useState<Set<string>>(new Set());
  const [popupColumnsTarget, setPopupColumnsTarget] = useState<Set<string>>(new Set());
  const [fieldsDatasetTab, setFieldsDatasetTab] = useState<"source" | "target">("source");
  const [popupDatasetTab, setPopupDatasetTab] = useState<"source" | "target">("source");

  // Styling & map
  const [markerSize, setMarkerSize] = useState(1.0);
  const [lineThickness, setLineThickness] = useState(2);
  const [lineColor, setLineColor] = useState("#10b981");
  const [lineOpacity, setLineOpacity] = useState(40);
  const [sourceIconColor, setSourceIconColor] = useState("#13a38f");
  const [neighborIconColor, setNeighborIconColor] = useState("#ef4444");
  const [showSiteLabels, setShowSiteLabels] = useState(true);
  const [showLegend, setShowLegend] = useState(true);
  const [showVoronoi, setShowVoronoi] = useState(false);
  const [showBeams, setShowBeams] = useState(true);


  // Filtering & search
  const [searchTerm, setSearchTerm] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const [filterCol, setFilterCol] = useState("");
  const [filterVals, setFilterVals] = useState<string[]>([]);
  const [selectedSite, setSelectedSite] = useState<string | null>(null);
  const [focusSite, setFocusSite] = useState<{ id: string; timestamp: number } | null>(null);

  // Session status
  const [loading, setLoading] = useState<FileKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [showProgress, setShowProgress] = useState(false);
  const [showOnMap, setShowOnMap] = useState(false);

  const [calculatedData, setCalculatedData] = useState<CalculatedData>(EMPTY_RESULTS);
  const hasResults = calculatedData.allSites.length > 0;

  const sourceFileRef = useRef<File | null>(null);
  const targetFileRef = useRef<File | null>(null);

  const sourceColumns = sourceData?.columns ?? [];
  const targetColumns = targetData?.columns ?? [];
  const hasTarget = calcMode === "pairwise" && Boolean(targetData?.rows.length);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  /* -------------------------------------------------------- File Upload */
  const handleFile = useCallback(
    async (file: File, kind: FileKind) => {
      setLoading(kind);
      setError(null);
      try {
        const ds = await parseFile(file);
        if (!ds.rows.length) throw new Error("The file contains no data rows.");
        const mapping = guessMapping(ds.columns);

        if (kind === "source") {
          sourceFileRef.current = file;
          setSourceFileName(file.name);
          setSourceData(ds);
          setSourceMapping(mapping);
          setPopupColumns(new Set(ds.columns.slice(0, 6)));
          setCalculatedData(EMPTY_RESULTS);
          setShowOnMap(false);
          setSelectedSite(null);
          setTab("columns");
        } else {
          targetFileRef.current = file;
          setTargetFileName(file.name);
          setTargetData(ds);
          setTargetMapping(mapping);
          setPopupColumnsTarget(new Set(ds.columns.slice(0, 6)));
          setCalculatedData(EMPTY_RESULTS);
          setShowOnMap(false);
          setSelectedSite(null);
        }

        const sheet = ds.sheetName ? `"${ds.sheetName}" · ` : "";
        flash(
          `Loaded ${ds.rows.length.toLocaleString()} rows from ${sheet}${file.name}` +
            (kind === "source" ? ` · ${mapping.lat || "?"} / ${mapping.lng || "?"} detected` : ""),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read that file.");
      } finally {
        setLoading(null);
      }
    },
    [flash],
  );

  const handleSheetChange = useCallback(
    async (sheetName: string, kind: FileKind) => {
      const file = kind === "source" ? sourceFileRef.current : targetFileRef.current;
      if (!file) return;
      setLoading(kind);
      setError(null);
      try {
        const ds = await parseFileSheet(file, sheetName);
        if (!ds.rows.length) throw new Error(`Worksheet "${sheetName}" has no data rows.`);
        const mapping = guessMapping(ds.columns);

        if (kind === "source") {
          setSourceData(ds);
          setSourceMapping(mapping);
        } else {
          setTargetData(ds);
          setTargetMapping(mapping);
        }
        setCalculatedData(EMPTY_RESULTS);
        setShowOnMap(false);
        setSelectedSite(null);
        flash(`Switched to "${sheetName}" · ${ds.rows.length.toLocaleString()} rows`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read that worksheet.");
      } finally {
        setLoading(null);
      }
    },
    [flash],
  );

  const removeSource = useCallback(() => {
    sourceFileRef.current = null;
    setSourceFileName("");
    setSourceData(null);
    setSourceMapping(EMPTY_MAPPING);
    setPopupColumns(new Set());
    setCalculatedData(EMPTY_RESULTS);
    setSelectedSite(null);

    setShowOnMap(false);
    setShowVoronoi(false);
  }, []);

  const removeTarget = useCallback(() => {
    targetFileRef.current = null;
    setTargetFileName("");
    setTargetData(null);
    setTargetMapping(EMPTY_MAPPING);
    setPopupColumnsTarget(new Set());
  }, []);

  const clearSession = useCallback(() => {
    removeSource();
    removeTarget();
    setSearchTerm("");
    setFilterCol("");
    setFilterVals([]);
    flash("Session cleared");
  }, [removeSource, removeTarget, flash]);

  /* -------------------------------------------------- Distance Calculation */
  const toSites = useCallback((data: Dataset | null, mapping: ColumnMapping): Site[] => {
    if (!data || !mapping.lat || !mapping.lng) return [];
    const rows = data.rows;
    const n = rows.length;
    const out: Site[] = [];
    const idKey = mapping.id;
    const latKey = mapping.lat;
    const lngKey = mapping.lng;
    const azKey = mapping.azimuth;
    const radiusKey = mapping.radius;
    const bwKey = mapping.beamwidth;
    for (let i = 0; i < n; i++) {
      const row = rows[i];
      const latRaw = row[latKey];
      const lngRaw = row[lngKey];
      if (latRaw === undefined || latRaw === null || lngRaw === undefined || lngRaw === null) continue;

      const lat = typeof latRaw === "number"
        ? latRaw
        : parseFloat(String(latRaw).trim().replace(/,/g, "").replace(/[°\s]/g, ""));
      if (isNaN(lat) || lat < -90 || lat > 90) continue;

      const lng = typeof lngRaw === "number"
        ? lngRaw
        : parseFloat(String(lngRaw).trim().replace(/,/g, "").replace(/[°\s]/g, ""));
      if (isNaN(lng) || lng < -180 || lng > 180) continue;

      const idRaw = idKey ? row[idKey] : undefined;
      const id = idRaw !== undefined && idRaw !== null && String(idRaw).trim() !== ""
        ? String(idRaw).trim()
        : `Site ${i + 1}`;

      let azimuth: number | undefined;
      if (azKey) {
        const azRaw = row[azKey];
        if (azRaw !== undefined && azRaw !== null && String(azRaw).trim() !== "") {
          const numMatch = typeof azRaw === "number" ? azRaw : String(azRaw).trim().replace(/,/g, "").match(/[-+]?[0-9]*\.?[0-9]+/)?.[0];
          const az = typeof numMatch === "number" ? numMatch : numMatch ? parseFloat(numMatch) : NaN;
          if (!isNaN(az) && az >= 0 && az <= 360) azimuth = az % 360;
        }
      }

      let radius: number | undefined;
      if (radiusKey) {
        const rRaw = row[radiusKey];
        if (rRaw !== undefined && rRaw !== null && String(rRaw).trim() !== "") {
          const numMatch = typeof rRaw === "number" ? rRaw : String(rRaw).trim().replace(/,/g, "").match(/[-+]?[0-9]*\.?[0-9]+/)?.[0];
          const r = typeof numMatch === "number" ? numMatch : numMatch ? parseFloat(numMatch) : NaN;
          if (!isNaN(r) && r > 0 && isFinite(r)) radius = r;
        }
      }

      let beamwidth: number | undefined;
      if (bwKey) {
        const bwRaw = row[bwKey];
        if (bwRaw !== undefined && bwRaw !== null && String(bwRaw).trim() !== "") {
          const numMatch = typeof bwRaw === "number" ? bwRaw : String(bwRaw).trim().replace(/,/g, "").match(/[-+]?[0-9]*\.?[0-9]+/)?.[0];
          const bw = typeof numMatch === "number" ? numMatch : numMatch ? parseFloat(numMatch) : NaN;
          if (!isNaN(bw) && bw > 0 && bw <= 360) beamwidth = bw;
        }
      }

      out.push({ id, lat, lng, azimuth, radius, beamwidth, originalData: row });
    }
    return out;
  }, []);

  // Building a Site for every row allocates one object per row, so the lists are
  // memoised: the two counts below and the run itself all need the same lists,
  // and rebuilding them per count meant three full passes over the dataset.
  const sourceSites = useMemo(
    () => toSites(sourceData, sourceMapping),
    [toSites, sourceData, sourceMapping],
  );
  const targetSites = useMemo(
    () => toSites(targetData, targetMapping),
    [toSites, targetData, targetMapping],
  );

  const validSourceCount = sourceSites.length;
  const validTargetCount = targetSites.length;

  const handleDraw = useCallback(async () => {
    const parsedSource = sourceSites;
    if (!parsedSource.length) {
      setCalculatedData(EMPTY_RESULTS);
      flash("Map the file columns first — open the Fields tab");
      return;
    }

    setShowProgress(true);
    setProgress(0);
    setError(null);

    const parsedTarget = hasTarget ? targetSites : parsedSource;
    if (hasTarget && !parsedTarget.length) {
      setShowProgress(false);
      flash("The target dataset has no usable rows with the mapped columns");
      return;
    }

    if (calcMethod === "face") {
      const mult = getUnitMultiplier(distanceUnit);
      const kmLimit = maxDistance;
      const prune = (distanceOp === "<" || distanceOp === "<=") && maxDistance !== null;
      const rows = await computeFaceToFace(parsedSource, parsedTarget, {
        mode: calcMode,
        defaultBw: beamWidth,
        maxKm: prune ? kmLimit : null,
        onProgress: (p) => setProgress(p),
      });

      const keepDistance = (km: number): boolean => {
        if (km < 1e-6) return false;
        if (maxDistance === null || kmLimit === null) return true;
        switch (distanceOp) {
          case "<":
            return km < maxDistance - 1e-6;
          case "<=":
            return km <= maxDistance + 1e-6;
          case "=":
            return Math.abs(km - maxDistance) < 1e-4;
          case ">":
            return km > maxDistance + 1e-6;
          case ">=":
            return km >= maxDistance - 1e-6;
          default:
            return true;
        }
      };

      const distanceFilteredRows = rows.filter((r) => keepDistance(r.distanceKm));

      // Group candidate pairs by sourceId
      const pairsBySource = new Map<string, FacePair[]>();
      for (let i = 0; i < distanceFilteredRows.length; i++) {
        const r = distanceFilteredRows[i];
        let list = pairsBySource.get(r.sourceId);
        if (!list) {
          list = [];
          pairsBySource.set(r.sourceId, list);
        }
        list.push(r);
      }

      // Rank by distance and keep top N nearest facing neighbors per sector
      const keptRows: FacePair[] = [];
      const neighborsById = new Map<string, NeighborResult[]>();

      pairsBySource.forEach((pairs, srcId) => {
        // Prioritize facing pairs, sorted by ascending distance
        const facing = pairs
          .filter((p) => p.faceToFace)
          .sort((a, b) => a.distanceKm - b.distanceKm);

        const topFacing = facing.slice(0, nNeighbors);
        keptRows.push(...topFacing);

        if (topFacing.length > 0) {
          neighborsById.set(
            srcId,
            topFacing.map((r) => ({ to: r.targetId, dist: r.distanceKm * mult })),
          );
        }
      });

      const facingRows = keptRows.filter((r) => r.faceToFace);

      const srcIds = new Set(parsedSource.map((s) => s.id));
      const allSites2: Site[] = [];
      const addedIds = new Set<string>();
      for (const s of [...parsedSource, ...parsedTarget]) {
        if (addedIds.has(s.id)) continue;
        addedIds.add(s.id);
        allSites2.push({
          ...s,
          isSource: true,
          isTarget: hasTarget && !srcIds.has(s.id),
        });
      }
      const sitesWithNeighbors2: SiteWithNeighbors[] = allSites2.map((s) => ({
        ...s,
        neighbors: neighborsById.get(s.id) ?? [],
      }));

      const connections2: Connection[] = facingRows.map((r) => ({
        from: r.sourceId,
        to: r.targetId,
        distance: r.distanceKm * mult,
        faceToFace: r.faceToFace,
      }));

      setFaceRows(keptRows);
      setCalculatedData({
        sitesWithNeighbors: sitesWithNeighbors2,
        allSites: allSites2,
        connections: connections2,
      });
      setProgress(100);
      setShowProgress(false);
      setShowOnMap(true);
      setSidebarOpen(false);
      flash(
        `Face-to-face: matched ${facingRows.length.toLocaleString()} facing connections (max ${nNeighbors} nearest per sector) across ${allSites2.length.toLocaleString()} sectors`,
      );
      return;
    }

    // Progress is reported far more often than the UI can show it, and every
    // update re-renders the whole app, so only the newest value in each frame
    // is pushed to state.
    let progressFrame = 0;
    let latestProgress = 0;
    const onProgress = (p: number) => {
      latestProgress = p;
      if (progressFrame) return;
      progressFrame = requestAnimationFrame(() => {
        progressFrame = 0;
        setProgress(latestProgress);
      });
    };

    const res = await calculateDistancesAsync({
      mode: calcMode,
      method: calcMethod,
      sourceSites: parsedSource,
      targetSites: parsedTarget,
      nNeighbors,
      voronoiLayers,
      beamWidth,
      unit: distanceUnit,
      excludeZero: true,
      maxDistance:
        maxDistance !== null ? maxDistance * getUnitMultiplier(distanceUnit) : null,
      distanceOp,
      onProgress,
    });

    if (progressFrame) cancelAnimationFrame(progressFrame);
    setProgress(100);
    setCalculatedData(res);
    setShowProgress(false);
    setShowOnMap(true);
    setSidebarOpen(false);
    if (calcMethod === "voronoi") setShowVoronoi(true);
    if (calcMethod === "voronoi") {
      flash(
        `Generated Voronoi layer across ${res.allSites.length.toLocaleString()} sites`,
      );
    } else if (calcMethod === "sector") {
      const covered = res.sitesWithNeighbors.filter((s) => (s.neighbors.length > 0)).length;
      flash(
        `Matched ${res.connections.length.toLocaleString()} beam connections across ${res.allSites.length.toLocaleString()} sites (${covered.toLocaleString()} sectors with a hit)`,
      );
    } else {
      flash(
        `Calculated ${res.connections.length.toLocaleString()} connections across ${res.allSites.length.toLocaleString()} sites`,
      );
    }
  }, [
    sourceSites,
    targetSites,
    calcMode,
    calcMethod,
    nNeighbors,
    voronoiLayers,
    beamWidth,
    distanceUnit,
    excludeZero,
    maxDistance,
    distanceOp,
    hasTarget,
    flash,
  ]);

  /* ----------------------------------------------------- Column Filtering */
  const { sitesWithNeighbors, allSites, connections } = useMemo(() => {
    if (!filterCol || filterVals.length === 0) {
      return calculatedData;
    }

    let {
      sitesWithNeighbors: rawSites,
      allSites: rawAll,
      connections: rawConns,
    } = calculatedData;

    // A Set rather than Array.includes: this runs once per site, and a linear
    // scan over the picked values is the whole cost of the filter.
    const wanted = new Set(filterVals);
    rawSites = rawSites.filter((s) =>
      wanted.has(String(s.originalData?.[filterCol] ?? "").trim() || "(blank)"),
    );
    const keptSources = new Set(rawSites.map((s) => s.id));
    const keptIds = new Set(keptSources);
    rawConns
      .filter((c) => keptSources.has(c.from))
      .forEach((c) => keptIds.add(c.to));
    rawAll = rawAll.filter((s) => keptIds.has(s.id));
    rawConns = rawConns.filter((c) => keptSources.has(c.from));

    return { sitesWithNeighbors: rawSites, allSites: rawAll, connections: rawConns };
  }, [calculatedData, filterCol, filterVals]);

  const uniqueFilterVals = useMemo(
    () =>
      filterCol && sourceData
        ? Array.from(
            new Set(sourceData.rows.map((r) => String(r[filterCol] ?? "").trim() || "(blank)")),
          )
        : [],
    [filterCol, sourceData],
  );

  // Close search dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const searchSites = useMemo(
    () => (showOnMap && hasResults ? allSites : []),
    [showOnMap, hasResults, allSites],
  );

  // Fast map from lowercase ID -> Site for O(1) exact matching
  const searchSiteMap = useMemo(() => {
    const map = new Map<string, Site>();
    for (let i = 0; i < searchSites.length; i++) {
      map.set(searchSites[i].id.toLowerCase(), searchSites[i]);
    }
    return map;
  }, [searchSites]);

  const searchMatchingSites = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return [];
    const hits: Site[] = [];
    const MAX_HITS = 40;

    // Check ID first: overwhelming majority of searches match by ID
    for (let i = 0; i < searchSites.length; i++) {
      const s = searchSites[i];
      if (s.id.toLowerCase().includes(q)) {
        hits.push(s);
        if (hits.length >= MAX_HITS) return hits;
      }
    }

    // Check properties only if needed
    for (let i = 0; i < searchSites.length; i++) {
      const s = searchSites[i];
      if (s.id.toLowerCase().includes(q)) continue;
      if (s.originalData) {
        let match = false;
        const vals = Object.values(s.originalData);
        for (let j = 0; j < vals.length; j++) {
          const v = vals[j];
          if (v !== null && v !== undefined && String(v).toLowerCase().includes(q)) {
            match = true;
            break;
          }
        }
        if (match) {
          hits.push(s);
          if (hits.length >= MAX_HITS) return hits;
        }
      }
    }
    return hits;
  }, [searchSites, searchTerm]);

  useEffect(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) {
      setSelectedSite(null);
      setFocusSite(null);
      return;
    }
    const exact = searchSiteMap.get(q);
    if (exact) {
      setSelectedSite(exact.id);
      setFocusSite({ id: exact.id, timestamp: Date.now() });
      setShowOnMap(true);
    } else if (searchMatchingSites.length === 1) {
      setSelectedSite(searchMatchingSites[0].id);
      setFocusSite({ id: searchMatchingSites[0].id, timestamp: Date.now() });
      setShowOnMap(true);
    }
  }, [searchSiteMap, searchMatchingSites, searchTerm]);

  const handleSiteClick = useCallback((id: string | null) => {
    setSelectedSite(id);
    if (id === null) {
      setSearchTerm("");
      setFocusSite(null);
    } else {
      setSearchTerm(id);
      setFocusSite({ id, timestamp: Date.now() });
    }
    setShowDropdown(false);
  }, []);

  const beamRadiusCategories = useMemo(() => {
    if (!beamRadiusCol || !sourceData) return [];
    const counts = new Map<string, number>();
    for (let i = 0; i < sourceData.rows.length; i++) {
      const row = sourceData.rows[i];
      const val = row[beamRadiusCol];
      const strVal =
        val === null || val === undefined || String(val).trim() === ""
          ? "(blank)"
          : String(val).trim();
      counts.set(strVal, (counts.get(strVal) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([val, count]) => ({ val, count }));
  }, [beamRadiusCol, sourceData]);

  const beams = useMemo(() => {
    if (!showOnMap || !showBeams || allSites.length === 0) return [];
    if (calcMethod === "face") {
      const maxFaceDistById = new Map<string, number>();
      const facingIds = new Set<string>();
      if (faceRows) {
        for (const r of faceRows) {
          if (!r.faceToFace) continue;
          facingIds.add(r.sourceId);
          facingIds.add(r.targetId);
          for (const id of [r.sourceId, r.targetId]) {
            const prev = maxFaceDistById.get(id);
            if (prev === undefined || r.distanceKm > prev) maxFaceDistById.set(id, r.distanceKm);
          }
        }
      }
      const fanSites: SiteWithNeighbors[] = allSites.map((s) => ({
        ...s,
        neighbors: facingIds.has(s.id)
          ? [{ to: "", dist: maxFaceDistById.get(s.id) ?? 1 }]
          : [],
      }));
      const beamWidthById: Record<string, number> = {};
      const radiusById: Record<string, number> = {};
      for (const s of allSites) {
        if (s.beamwidth !== undefined && isFinite(s.beamwidth) && s.beamwidth > 0) {
          beamWidthById[s.id] = s.beamwidth;
        }
        if (beamRadiusMode === "column" && beamRadiusCol) {
          const rawVal = s.originalData?.[beamRadiusCol];
          const key =
            rawVal === null || rawVal === undefined || String(rawVal).trim() === ""
              ? "(blank)"
              : String(rawVal).trim();
          const radiusMeters = beamRadiusCategoryMap[key] ?? beamRadiusCategoryDefault;
          radiusById[s.id] = radiusMeters / 1000;
        }
      }
      return buildBeamPolygons(fanSites, fanSites, beamWidth, {
        radiusMode: beamRadiusMode,
        radiusValueKm: beamRadiusFixed / 1000,
        radiusUnit: "m",
        beamWidthById,
        radiusById: beamRadiusMode === "column" && beamRadiusCol ? radiusById : undefined,
      });
    }
    const beamWidthById: Record<string, number> = {};
    const radiusById: Record<string, number> = {};
    for (const s of sourceSites) {
      if (s.beamwidth !== undefined && isFinite(s.beamwidth) && s.beamwidth > 0) {
        beamWidthById[s.id] = s.beamwidth;
      }
      if (beamRadiusMode === "column" && beamRadiusCol) {
        const rawVal = s.originalData?.[beamRadiusCol];
        const key =
          rawVal === null || rawVal === undefined || String(rawVal).trim() === ""
            ? "(blank)"
            : String(rawVal).trim();
        const radiusMeters = beamRadiusCategoryMap[key] ?? beamRadiusCategoryDefault;
        radiusById[s.id] = radiusMeters / 1000;
      }
    }
    return buildBeamPolygons(sourceSites, sitesWithNeighbors, beamWidth, {
      radiusMode: beamRadiusMode,
      radiusValueKm: beamRadiusFixed / 1000,
      radiusUnit: "m",
      beamWidthById,
      radiusById: beamRadiusMode === "column" && beamRadiusCol ? radiusById : undefined,
    });
  }, [
    calcMethod,
    faceRows,
    allSites,
    sourceSites,
    sitesWithNeighbors,
    beamWidth,
    beamRadiusMode,
    beamRadiusFixed,
    beamRadiusCol,
    beamRadiusCategoryMap,
    beamRadiusCategoryDefault,
    distanceUnit,
  ]);

  const legendItems = useMemo(() => {
    const items: { label: string; color: string; count: number }[] = [];

    if (hasTarget) {
      let srcCount = 0;
      let tgtCount = 0;
      for (let i = 0; i < allSites.length; i++) {
        const s = allSites[i];
        if (s.isSource) srcCount++;
        else if (s.isTarget) tgtCount++;
      }
      items.push({
        label: "Source sites",
        color: sourceIconColor,
        count: srcCount || sourceSites.length,
      });
      items.push({
        label: "Target neighbours",
        color: neighborIconColor,
        count: tgtCount || targetSites.length,
      });
    } else {
      items.push({ label: "All sites", color: sourceIconColor, count: allSites.length });
    }

    if (showVoronoi && calcMethod === "voronoi") {
      items.push({
        label: "Voronoi layer",
        color: "#8b5cf6",
        count: allSites.length,
      });
    }

    if (calcMethod === "face") {
      const facing = faceRows?.filter((r) => r.faceToFace).length ?? 0;
      items.push({
        label: "Face-to-face pair",
        color: lineColor,
        count: facing,
      });
      items.push({
        label: "Not facing",
        color: NOT_FACE_COLOR,
        count: (faceRows?.length ?? 0) - facing,
      });
    }

    if (showBeams) {
      const matched = beams.filter((b) => b.properties.matched).length;
      items.push({
        label: "Beam · covered",
        color: MATCHED_BEAM_COLOR,
        count: matched,
      });
      items.push({
        label: "Beam · uncovered",
        color: UNMATCHED_BEAM_COLOR,
        count: beams.length - matched,
      });
    }
    return items;
  }, [
    allSites,
    sourceSites.length,
    targetSites.length,
    hasTarget,
    sourceIconColor,
    neighborIconColor,
    showVoronoi,
    calcMethod,
    beams,
    showBeams,
    faceRows,
    lineColor,
  ]);

  /* ------------------------------------------------------------- exports */
  const handleExportKmz = useCallback(async () => {
    let voronoiPolygons;
    if (calcMethod === "voronoi" && allSites.length >= 3) {
      voronoiPolygons =
        (await engineVoronoiCells(allSites).catch(() => null)) ??
        computeAllVoronoiPolygons(allSites);
    }
    exportKmzFile({
      sourceIcon: { url: "VECTOR_CIRCLE", color: sourceIconColor, scale: markerSize, opacity: 1 },
      neighborIcon: { url: "VECTOR_CIRCLE", color: neighborIconColor, scale: markerSize, opacity: 1 },
      allSites,
      sitesWithNeighbors,
      connections,
      lineColor,
      lineThickness,
      lineOpacity,
      showVoronoi,
      distanceUnit,
      calcMethod,
      voronoiLayers,
      nNeighbors,
      popupColumns,
      popupColumnsTarget,
      hasTarget,
      beams: showBeams ? beams : [],
      voronoiPolygons,
    });
    flash("KMZ exported");
  }, [
    allSites,
    sitesWithNeighbors,
    connections,
    sourceIconColor,
    neighborIconColor,
    markerSize,
    lineColor,
    lineThickness,
    lineOpacity,
    showVoronoi,
    distanceUnit,
    calcMethod,
    voronoiLayers,
    nNeighbors,
    popupColumns,
    popupColumnsTarget,
    hasTarget,
    beams,
    showBeams,
    flash,
  ]);


  const handleExportXlsx = useCallback(async () => {
    await exportExcelFile(
      sitesWithNeighbors,
      distanceUnit,
      calcMethod,
      "distances.xlsx",
      faceRows ?? undefined,
      allSites,
      hasTarget,
    );
    flash("Excel workbook exported");
  }, [sitesWithNeighbors, distanceUnit, calcMethod, faceRows, allSites, hasTarget, flash]);

  /* ---------------------------------------------------------- shortcuts */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "enter") {
        e.preventDefault();
        void handleDraw();
      } else if (k === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleDraw]);

  const canDraw = validSourceCount > 0 && !showProgress;

  /* ---------------------------------------------------------------- view */
  return (
    <div className="app-shell">
      {/* ============================ header ============================ */}
      <header className="app-header">
        <div className="brand">
          <button
            className="mobile-menu"
            onClick={() => setSidebarOpen((v) => !v)}
            title="Toggle input panel"
            aria-label="Toggle input panel"
          >
            <I.Menu />
          </button>
          <div className="brand-name">Sector To Site/Sector Distance</div>
        </div>
      </header>

      <div className="workspace">
        {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close" />}

        {/* ============================ sidebar =========================== */}
        <aside className={`sidebar ${sidebarOpen ? "is-open" : "collapsed"}`}>
          <div className="sidebar-mobile-head">
            CONFIGURATION
            <button onClick={() => setSidebarOpen(false)} aria-label="Close panel">
              <I.X size={16} />
            </button>
          </div>

          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
                <t.Icon />
                {t.label}
              </button>
            ))}
          </nav>

          <div className="sidebar-scroll">
            {/* ---------------------------------------------------- SOURCE */}
            {tab === "upload" && (
              <div className="panel-enter">
                <section className="sidebar-section intro-section">
                  <div className="section-kicker">Step 01</div>
                  <h1>Bring your coordinate data.</h1>
                  <p>
                    Drop a CSV or Excel export of your sites. Everything is parsed in your browser —
                    nothing is uploaded.
                  </p>
                </section>

                <section className="sidebar-section border-top">
                  <span className="unit-label calc-method-label">Input Data</span>
                  <div className="analysis-box">
                    <div className="analysis-header">
                      <div className="analysis-tablist" role="tablist" aria-label="Input data">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={calcMode === "all"}
                          className={`analysis-tab ${calcMode === "all" ? "active" : ""}`}
                          onClick={() => setCalcMode("all")}
                        >
                          <span>All Sites</span>
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={calcMode === "pairwise"}
                          className={`analysis-tab ${calcMode === "pairwise" ? "active" : ""}`}
                          onClick={() => setCalcMode("pairwise")}
                        >
                          <span>Source &amp; Target</span>
                        </button>
                      </div>
                    </div>
                    <div className="analysis-panel">
                      <p className="field-help">
                        {calcMode === "all"
                          ? "All Sites measures neighbours inside one file. Source & Target measures every source site against a second dataset."
                          : "Source & Target measures every source site against a second dataset."}
                      </p>

                      <div className="form-group">
                        <div className="mapping-label">
                          <label>File Dataset</label>
                          <span>{sourceData ? "loaded" : "required"}</span>
                        </div>
                        <FilePanel
                          fileName={sourceFileName}
                          data={sourceData}
                          loading={loading === "source"}
                          onFile={(f) => void handleFile(f, "source")}
                          onSheet={(s) => void handleSheetChange(s, "source")}
                          onRemove={removeSource}
                        />
                        {error && <div className="error-note">{error}</div>}
                      </div>

                      {calcMode === "pairwise" && (
                        <div className="form-group" style={{ marginTop: 16 }}>
                          <div className="mapping-label">
                            <label>Target Dataset</label>
                            <span>{targetData ? "loaded" : "optional"}</span>
                          </div>
                          <FilePanel
                            fileName={targetFileName}
                            data={targetData}
                            loading={loading === "target"}
                            onFile={(f) => void handleFile(f, "target")}
                            onSheet={(s) => void handleSheetChange(s, "target")}
                            onRemove={removeTarget}
                          />
                          <p className="field-help" style={{ marginTop: 8 }}>
                            Leave empty to measure the file sites against themselves.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            )}

            {/* ---------------------------------------------------- FIELDS */}
            {tab === "columns" && (
              <div className="panel-enter">
                <section className="sidebar-section intro-section compact">
                  <div className="section-kicker">Step 02</div>
                  <h1>Map your data columns.</h1>
                  <p>
                    Assign the site name, latitude and longitude columns used for spatial
                    calculations.
                  </p>
                </section>

                <section className="sidebar-section border-top">
                  <span className="unit-label calc-method-label">Column Mapping</span>
                  {calcMode === "pairwise" ? (
                    <div className="analysis-box">
                      <div className="analysis-header">
                        <div className="analysis-tablist" role="tablist" aria-label="Column mapping dataset">
                          <button
                            type="button"
                            role="tab"
                            aria-selected={fieldsDatasetTab === "source"}
                            className={`analysis-tab ${fieldsDatasetTab === "source" ? "active" : ""}`}
                            onClick={() => setFieldsDatasetTab("source")}
                          >
                            <span>File Columns</span>
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={fieldsDatasetTab === "target"}
                            className={`analysis-tab ${fieldsDatasetTab === "target" ? "active" : ""}`}
                            onClick={() => setFieldsDatasetTab("target")}
                          >
                            <span>Target Columns</span>
                          </button>
                        </div>
                      </div>
                      <div className="analysis-panel">
                        {fieldsDatasetTab === "source" ? (
                          <>
                            <div className="mapping-label" style={{ marginBottom: 12 }}>
                              <label>File Dataset</label>
                              <span>{sourceFileName || "not loaded"}</span>
                            </div>
                            <MappingFields
                              mapping={sourceMapping}
                              columns={sourceColumns}
                              onChange={setSourceMapping}
                              validCount={validSourceCount}
                              totalCount={sourceData?.rows.length ?? 0}
                            />
                          </>
                        ) : (
                          <>
                            <div className="mapping-label" style={{ marginBottom: 12 }}>
                              <label>Target Dataset</label>
                              <span>{targetFileName || "not loaded"}</span>
                            </div>
                            <MappingFields
                              mapping={targetMapping}
                              columns={targetColumns}
                              onChange={setTargetMapping}
                              validCount={validTargetCount}
                              totalCount={targetData?.rows.length ?? 0}
                            />
                          </>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="analysis-box">
                      <div className="analysis-panel">
                        <div className="mapping-label" style={{ marginBottom: 12 }}>
                          <label>File Dataset</label>
                          <span>{sourceFileName || "not loaded"}</span>
                        </div>
                        <MappingFields
                          mapping={sourceMapping}
                          columns={sourceColumns}
                          onChange={setSourceMapping}
                          validCount={validSourceCount}
                          totalCount={sourceData?.rows.length ?? 0}
                        />
                      </div>
                    </div>
                  )}
                </section>

                <section className="sidebar-section border-top">
                  <span className="unit-label calc-method-label">Popup Fields</span>
                  {calcMode === "pairwise" && targetColumns.length > 0 ? (
                    <div className="analysis-box">
                      <div className="analysis-header">
                        <div className="analysis-tablist" role="tablist" aria-label="Popup fields dataset">
                          <button
                            type="button"
                            role="tab"
                            aria-selected={popupDatasetTab === "source"}
                            className={`analysis-tab ${popupDatasetTab === "source" ? "active" : ""}`}
                            onClick={() => setPopupDatasetTab("source")}
                          >
                            <span>File Popups</span>
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={popupDatasetTab === "target"}
                            className={`analysis-tab ${popupDatasetTab === "target" ? "active" : ""}`}
                            onClick={() => setPopupDatasetTab("target")}
                          >
                            <span>Target Popups</span>
                          </button>
                        </div>
                      </div>
                      <div className="analysis-panel">
                        {popupDatasetTab === "source" ? (
                          <PopupFields
                            label="File popup fields"
                            columns={sourceColumns}
                            selected={popupColumns}
                            onChange={setPopupColumns}
                          />
                        ) : (
                          <PopupFields
                            label="Target popup fields"
                            columns={targetColumns}
                            selected={popupColumnsTarget}
                            onChange={setPopupColumnsTarget}
                          />
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="analysis-box">
                      <div className="analysis-panel">
                        <PopupFields
                          label="File popup fields"
                          columns={sourceColumns}
                          selected={popupColumns}
                          onChange={setPopupColumns}
                        />
                      </div>
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* ----------------------------------------------------- STYLE */}
            {tab === "style" && (
              <div className="panel-enter">
                <section className="sidebar-section intro-section compact">
                  <div className="section-kicker">Step 03</div>
                  <h1>Customize map appearance.</h1>
                  <p>Configure marker colours, connection lines, labels and the Voronoi diagram.</p>
                </section>

                <section className="sidebar-section border-top">
                  <span className="unit-label calc-method-label">Marker Styling</span>
                  <div className="analysis-box">
                    <div className="analysis-panel">
                      <ColorSwatches label="Source sites" value={sourceIconColor} onChange={setSourceIconColor} />
                      {hasTarget && (
                        <ColorSwatches
                          label="Target neighbours"
                          value={neighborIconColor}
                          onChange={setNeighborIconColor}
                        />
                      )}

                      <div className="range-setting" style={{ marginTop: 8 }}>
                        <div>
                          Marker scale <span>{markerSize.toFixed(1)}×</span>
                        </div>
                        <input
                          type="range"
                          min="0.5"
                          max="3"
                          step="0.1"
                          value={markerSize}
                          onChange={(e) => setMarkerSize(parseFloat(e.target.value))}
                        />
                      </div>
                    </div>
                  </div>
                </section>

                {calcMethod !== "voronoi" && (
                  <section className="sidebar-section border-top">
                    <span className="unit-label calc-method-label">Connection Lines</span>
                    <div className="analysis-box">
                      <div className="analysis-panel">
                        <ColorSwatches label="Line colour" value={lineColor} onChange={setLineColor} />

                        <div className="range-setting" style={{ marginTop: 8 }}>
                          <div>
                            Line thickness <span>{lineThickness}px</span>
                          </div>
                          <input
                            type="range"
                            min="1"
                            max="10"
                            step="1"
                            value={lineThickness}
                            onChange={(e) => setLineThickness(parseInt(e.target.value))}
                          />
                        </div>

                        <div className="range-setting" style={{ marginTop: 12 }}>
                          <div>
                            Line opacity <span>{lineOpacity}%</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            value={lineOpacity}
                            onChange={(e) => setLineOpacity(parseInt(e.target.value))}
                          />
                        </div>
                      </div>
                    </div>
                  </section>
                )}

                <section className="sidebar-section border-top">
                  <span className="unit-label calc-method-label">Display Options</span>
                  <div className="analysis-box">
                    <div className="analysis-panel">
                      <Toggle
                        label="Site labels"
                        hint="Always show names beside points"
                        checked={showSiteLabels}
                        onChange={setShowSiteLabels}
                      />
                      <Toggle
                        label="Sector beams"
                        hint="Draw azimuth beam wedges for each sector"
                        checked={showBeams}
                        onChange={setShowBeams}
                      />
                      <Toggle
                        label="Map legend"
                        hint="Colour key at the bottom of the map"
                        checked={showLegend}
                        onChange={setShowLegend}
                      />
                    </div>
                  </div>
                </section>
              </div>
            )}

            {/* ---------------------------------------------------- EXPORT */}
            {tab === "filter" && (
              <div className="panel-enter">
                <section className="sidebar-section intro-section compact">
                  <div className="section-kicker">Step 04</div>
                  <h1>Calculate &amp; export.</h1>
                  <p>Run the distance calculation, then share the result as KMZ or XLSX.</p>
                </section>

                <section className="sidebar-section border-top">
                  <span className="unit-label calc-method-label">Calculation method</span>
                  <div className="analysis-box">
                    <div className="analysis-header">
                      <div className="analysis-tablist" role="tablist" aria-label="Calculation method">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={calcMethod === "sector"}
                          className={`analysis-tab ${calcMethod === "sector" ? "active" : ""}`}
                          onClick={() => setCalcMethod("sector")}
                        >
                          <span>Sector Beam</span>
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={calcMethod === "face"}
                          className={`analysis-tab ${calcMethod === "face" ? "active" : ""}`}
                          onClick={() => setCalcMethod("face")}
                        >
                          <span>Face to Face</span>
                        </button>
                      </div>
                    </div>
                    <div className="analysis-panel">
                        {calcMethod === "sector" ? (
                          <p className="field-help">
                            For every sector, sites inside its azimuth beam (± beamwidth/2) are
                            ranked by distance and the nearest N are matched. Requires an azimuth
                            column.
                          </p>
                        ) : (
                          <p className="field-help">
                            For every pair, decides whether both sectors point at each other
                            within their beamwidth and reports distance plus both bearings.
                          </p>
                        )}

                        <div className="form-group">
                          <span className="field-label">Output Distance Unit</span>
                          <div className="unit-check-grid" role="group" aria-label="Output distance unit">
                            {(["km", "m", "mi", "ft"] as DistanceUnit[]).map((u) => (
                              <label
                                key={u}
                                className={`unit-check ${distanceUnit === u ? "active" : ""}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={distanceUnit === u}
                                  onChange={() => setDistanceUnit(u)}
                                />
                                {u}
                              </label>
                            ))}
                          </div>
                        </div>

                        <div className="form-group">
                          <div className="row-between" style={{ marginBottom: 6 }}>
                            <span className="field-label" style={{ margin: 0 }}>Horizontal Beamwidth</span>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <input
                                type="number"
                                min="10"
                                max="360"
                                step="1"
                                className="form-control num-control"
                                style={{ width: 68, height: 26, fontSize: 11, padding: "2px 6px" }}
                                value={beamWidth}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value);
                                  setBeamWidth(isNaN(val) ? 65 : Math.max(10, Math.min(360, val)));
                                }}
                              />
                              <span className="value-chip">°</span>
                            </div>
                          </div>
                          <input
                            type="range"
                            className="thin-slider"
                            min="10"
                            max="360"
                            step="1"
                            value={beamWidth}
                            onChange={(e) => setBeamWidth(parseInt(e.target.value) || 10)}
                          />
                        </div>

                        <div className="form-group">
                          <label className="row-between">
                            <span>Beam Radius Display</span>
                            <select
                              className="form-control sel-inline"
                              value={beamRadiusMode}
                              onChange={(e) => setBeamRadiusMode(e.target.value as BeamRadiusMode)}
                            >
                              <option value="auto">Auto</option>
                              <option value="value">Fixed</option>
                              <option value="column">Column Assign</option>
                            </select>
                          </label>
                          {beamRadiusMode === "value" && (
                            <div style={{ marginTop: 8 }}>
                              <div className="row-between" style={{ marginBottom: 4 }}>
                                <span className="field-help" style={{ margin: 0 }}>Fixed Radius (30 – 800 m)</span>
                                <span className="value-chip">{beamRadiusFixed} m</span>
                              </div>
                              <input
                                type="range"
                                className="thin-slider"
                                min="30"
                                max="800"
                                step="5"
                                value={beamRadiusFixed}
                                onChange={(e) => setBeamRadiusFixed(parseInt(e.target.value) || 30)}
                              />
                            </div>
                          )}
                          {beamRadiusMode === "column" && (
                            <div style={{ marginTop: 10 }}>
                              <div className="form-group" style={{ marginBottom: 8 }}>
                                <label className="field-label">Category Column</label>
                                <select
                                  className="form-control"
                                  value={beamRadiusCol}
                                  onChange={(e) => setBeamRadiusCol(e.target.value)}
                                >
                                  <option value="">— Select column (e.g. Band, Tech, Layer) —</option>
                                  {sourceColumns.map((c) => (
                                    <option key={c} value={c}>
                                      {c}
                                    </option>
                                  ))}
                                </select>
                              </div>

                              {beamRadiusCol ? (
                                <div style={{ marginTop: 8 }}>
                                  <div className="row-between" style={{ marginBottom: 8, padding: "4px 0" }}>
                                    <span className="field-label" style={{ margin: 0 }}>Default Fallback</span>
                                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                      <input
                                        type="number"
                                        min="30"
                                        max="800"
                                        step="5"
                                        className="form-control num-control"
                                        style={{ width: 75, height: 26, fontSize: 11, padding: "2px 6px" }}
                                        value={beamRadiusCategoryDefault}
                                        onChange={(e) => setBeamRadiusCategoryDefault(parseInt(e.target.value) || 30)}
                                      />
                                      <span className="value-chip">m</span>
                                    </div>
                                  </div>

                                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto", paddingRight: 2 }}>
                                    {beamRadiusCategories.map(({ val, count }) => {
                                      const assignedVal = beamRadiusCategoryMap[val] ?? beamRadiusCategoryDefault;
                                      return (
                                        <div
                                          key={val}
                                          className="row-between"
                                          style={{
                                            background: "rgba(0,0,0,0.02)",
                                            border: "1px solid #d2dedb",
                                            borderRadius: 6,
                                            padding: "6px 8px",
                                            gap: 8,
                                          }}
                                        >
                                          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                                            <strong
                                              style={{
                                                fontSize: 11,
                                                color: "#1e293b",
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                              }}
                                              title={val}
                                            >
                                              {val}
                                            </strong>
                                            <small style={{ fontSize: 9, color: "#64748b" }}>
                                              {count.toLocaleString()} sectors
                                            </small>
                                          </div>
                                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                                            <input
                                              type="number"
                                              min="30"
                                              max="800"
                                              step="5"
                                              className="form-control num-control"
                                              style={{ width: 75, height: 26, fontSize: 11, padding: "2px 6px" }}
                                              value={assignedVal}
                                              onChange={(e) => {
                                                const v = parseInt(e.target.value) || 30;
                                                setBeamRadiusCategoryMap((prev) => ({
                                                  ...prev,
                                                  [val]: v,
                                                }));
                                              }}
                                            />
                                            <span className="value-chip">m</span>
                                          </div>
                                        </div>
                                      );
                                    })}
                                    {beamRadiusCategories.length === 0 && (
                                      <p className="field-help" style={{ margin: 0 }}>No values found in this column.</p>
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <p className="field-help" style={{ margin: "4px 0 0" }}>
                                  Choose a column above to assign radius values for each category.
                                </p>
                              )}
                            </div>
                          )}
                        </div>

                        <div className="form-group">
                          <label className="field-label" htmlFor="maxN">
                            Max Nearest Neighbors (N)
                          </label>
                          <input
                            id="maxN"
                            className="form-control"
                            type="number"
                            min="1"
                            max="50"
                            step="1"
                            value={nNeighbors}
                            onChange={(e) =>
                              setNNeighbors(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))
                            }
                          />
                        </div>

                        <div className="form-group">
                          <label className="row-between">
                            <span className="field-label" style={{ margin: 0 }}>Distance Limit</span>
                            <span className="value-chip">km</span>
                          </label>
                          <div className="dual-input" style={{ marginTop: 4 }}>
                            <select
                              className="form-control"
                              style={{ width: "30%", flex: "none" }}
                              value={distanceOp}
                              onChange={(e) => setDistanceOp(e.target.value as DistanceOperator)}
                            >
                              <option value={"<"}>&lt;</option>
                              <option value={"<="}>&lt;=</option>
                              <option value="=">=</option>
                              <option value={">"}>&gt;</option>
                              <option value={">="}>&gt;=</option>
                            </select>
                            <input
                              className="form-control num-control"
                              style={{ width: "70%" }}
                              type="number"
                              placeholder="No limit (km)"
                              value={maxDistance ?? ""}
                              onChange={(e) =>
                                setMaxDistance(e.target.value ? parseFloat(e.target.value) : null)
                              }
                            />
                          </div>
                        </div>

                        {calcMethod === "sector" &&
                          !sourceMapping.azimuth &&
                          sourceColumns.length > 0 && (
                            <p className="field-help warn">
                              Map an Azimuth column in the Fields tab, or every sector is treated
                              as a full 360° omni beam.
                            </p>
                          )}
                        {calcMethod === "face" && sourceColumns.length > 0 && (
                          <p className="field-help warn">
                            Map Azimuth (and optionally a per-site Beamwidth) column in the Fields
                            tab. Sectors without an azimuth never count as facing.
                          </p>
                        )}
                      </div>
                    </div>
                </section>

                <section className="sidebar-section border-top">
                  <button className="connect-button" onClick={() => void handleDraw()} disabled={!canDraw}>
                    <I.Bolt />
                    {showProgress ? `Calculating ${Math.round(progress)}%` : "Calculate & Draw"}
                  </button>

                  {showProgress && (
                    <div className="progress-row">
                      <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${Math.min(progress, 100)}%` }} />
                      </div>
                      <span className="progress-pct">{Math.round(progress)}%</span>
                    </div>
                  )}

                  <div className="export-stack">
                    <button className="action-button action-blue" disabled={!hasResults} onClick={handleExportKmz}>
                      <I.Export /> Export KMZ
                    </button>
                    <button className="action-button action-outline" disabled={!hasResults} onClick={handleExportXlsx}>
                      <I.FileSheet /> Excel (XLSX)
                    </button>
                    <button className="action-button action-red-outline" onClick={clearSession}>
                      <I.Trash /> Clear session
                    </button>
                  </div>
                </section>
              </div>
            )}
          </div>
        </aside>

        {/* ========================== map workspace ======================== */}
        <main className="map-workspace">
          <div className="map-toolbar">
            <div className="map-search" ref={searchContainerRef} style={{ position: "relative" }}>
              <I.Search />
              <input
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setShowDropdown(true);
                }}
                onFocus={() => setShowDropdown(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (searchMatchingSites.length > 0) {
                      const q = searchTerm.trim().toLowerCase();
                      const exact = searchMatchingSites.find((s) => s.id.toLowerCase() === q);
                      const pick = exact || searchMatchingSites[0];
                      setSelectedSite(pick.id);
                      setSearchTerm(pick.id);
                      setFocusSite({ id: pick.id, timestamp: Date.now() });
                      setShowDropdown(false);
                      setShowOnMap(true);
                    }
                  } else if (e.key === "Escape") {
                    setShowDropdown(false);
                  }
                }}
                placeholder="Search site name or any field…"
              />
              {searchTerm && (
                <button
                  onClick={() => {
                    setSearchTerm("");
                    setSelectedSite(null);
                    setFocusSite(null);
                    setShowDropdown(false);
                  }}
                  aria-label="Clear search"
                >
                  <I.X size={13} />
                </button>
              )}

              {showDropdown && searchTerm.trim() && searchMatchingSites.length > 0 && (
                <div
                  className="search-dropdown"
                  style={{
                    position: "absolute",
                    top: "100%",
                    left: 0,
                    right: 0,
                    marginTop: 4,
                    background: "#ffffff",
                    borderRadius: 8,
                    boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
                    border: "1px solid #e2e8f0",
                    maxHeight: 250,
                    overflowY: "auto",
                    zIndex: 100,
                  }}
                >
                  {searchMatchingSites.slice(0, 20).map((s) => (
                    <div
                      key={s.id}
                      onClick={() => {
                        setSelectedSite(s.id);
                        setSearchTerm(s.id);
                        setFocusSite({ id: s.id, timestamp: Date.now() });
                        setShowDropdown(false);
                        setShowOnMap(true);
                      }}
                      style={{
                        padding: "8px 12px",
                        cursor: "pointer",
                        fontSize: 12,
                        borderBottom: "1px solid #f1f5f9",
                        backgroundColor: selectedSite === s.id ? "#f0fdf4" : "transparent",
                        fontWeight: selectedSite === s.id ? 700 : 500,
                        color: selectedSite === s.id ? "#15803d" : "#1e293b",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f8fafc")}
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.backgroundColor =
                          selectedSite === s.id ? "#f0fdf4" : "transparent")
                      }
                    >
                      <span>{s.id}</span>
                      <small style={{ color: "#64748b" }}>
                        {s.lat.toFixed(4)}, {s.lng.toFixed(4)}
                      </small>
                    </div>
                  ))}
                  {searchMatchingSites.length > 20 && (
                    <div
                      style={{
                        padding: "6px 12px",
                        fontSize: 11,
                        color: "#64748b",
                        backgroundColor: "#f8fafc",
                        textAlign: "center",
                      }}
                    >
                      Showing 20 of {searchMatchingSites.length.toLocaleString()} matches
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="toolbar-divider" />

            <div className="status-filter">
              <select
                value={filterCol}
                onChange={(e) => {
                  setFilterCol(e.target.value);
                  setFilterVals([]);
                }}
              >
                <option value="">All columns</option>
                {sourceColumns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              {filterCol && (
                <select
                  value={filterVals.length === 1 ? filterVals[0] : ""}
                  onChange={(e) => setFilterVals(e.target.value ? [e.target.value] : [])}
                >
                  <option value="">Any value</option>
                  {uniqueFilterVals.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="toolbar-count">
              {searchTerm.trim() ? (
                <>
                  <strong>{searchMatchingSites.length.toLocaleString()}</strong> matched (
                  {searchSites.length.toLocaleString()} sites)
                </>
              ) : (
                <>
                  <strong>{showOnMap && hasResults ? allSites.length.toLocaleString() : 0}</strong> /{" "}
                  {(sourceData?.rows.length ?? 0).toLocaleString()} points
                </>
              )}
            </div>
          </div>

          <div className="map-frame">
            <MapView
              sites={showOnMap && hasResults ? allSites : []}
              connections={showOnMap && hasResults && calcMethod !== "voronoi" ? connections : []}
              selectedSite={selectedSite}
              onSiteClick={handleSiteClick}
              focusSite={focusSite}
              lineThickness={lineThickness}
              lineColor={lineColor}
              lineOpacity={lineOpacity}
              markerIconUrl="VECTOR_CIRCLE"
              iconColor={sourceIconColor}
              iconOpacity={100}
              iconScale={markerSize}
              neighborMarkerIconUrl="VECTOR_CIRCLE"
              neighborIconColor={neighborIconColor}
              neighborIconOpacity={100}
              neighborIconScale={markerSize}
              showSiteLabels={showSiteLabels}
              markerSize={markerSize}
              singleIconMode={!hasTarget}
              sitesWithNeighbors={sitesWithNeighbors}
              nNeighbors={nNeighbors}
              distanceUnit={distanceUnit}
              popupColumns={popupColumns}
              popupColumnsTarget={popupColumnsTarget}
              showVoronoi={showOnMap && hasResults && showVoronoi}
              calcMethod={calcMethod}
              voronoiLayers={voronoiLayers}
              beams={showOnMap && hasResults && showBeams ? beams : []}
              beamWidth={beamWidth}
              faceMode={calcMethod === "face"}
              sidebarOpen={sidebarOpen}
            />

            {showOnMap && showLegend && hasResults && allSites.length > 0 && (
              <div className="map-footer-info align-start">
                <div className="legend-inline">
                  <div className="legend-title">{hasTarget ? "Source vs target" : "Sites"}</div>
                  <div className="legend-list">
                    {legendItems.map((it) => (
                      <span key={it.label}>
                        <i style={{ background: it.color }} />
                        {it.label} <b>{it.count.toLocaleString()}</b>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
