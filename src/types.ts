export type Cell = string | number | null;
export type Row = Record<string, Cell>;

export interface Dataset {
  fileName: string;
  columns: string[];
  rows: Row[];
  /** Excel only — the worksheet this data came from. */
  sheetName?: string;
  /** Excel only — every worksheet available in the workbook. */
  sheetNames?: string[];
}

export interface ColumnMapping {
  id: string;
  lat: string;
  lng: string;
  /** Optional sector beam direction (degrees 0-360) for sector calculation. */
  azimuth: string;
  /** Optional sector beam radius (in the chosen distance unit) per site. */
  radius: string;
  /** Optional sector horizontal beamwidth (degrees) per site. */
  beamwidth: string;
}

export type CalcMode = "all" | "pairwise";
export type CalcMethod = "brute" | "voronoi" | "sector" | "face";
export type BeamRadiusMode = "auto" | "value" | "column";
export type FaceFilter = "all" | "face" | "not";
export type DistanceUnit = "km" | "m" | "mi" | "ft";
export type DistanceOperator = "<" | "<=" | "=" | ">" | ">=";
export type MatchFilter = "All" | "Match" | "Not Match";
export type SiteTypeFilter = "All" | "Source" | "Neighbor";

export interface IconConfig {
  url: string;
  color: string;
  scale: number;
  opacity: number;
}

export interface Site {
  id: string;
  lat: number;
  lng: number;
  originalData?: Row;
  /** Sector beam direction in degrees (0-360), when the source mapped one. */
  azimuth?: number;
  /** Sector beam radius in the chosen distance unit, when the source mapped one. */
  radius?: number;
  /** Sector horizontal beamwidth in degrees, when the source mapped one. */
  beamwidth?: number;
  isSource?: boolean;
  isTarget?: boolean;
  isNeighbor?: boolean;
}

export interface NeighborResult {
  to: string;
  dist: number;
  layer?: number;
}

export interface SiteWithNeighbors extends Site {
  neighbors: NeighborResult[];
}

export interface Connection {
  from: string;
  to: string;
  distance: number;
  /** Face-to-face method only: whether both sectors point at each other. */
  faceToFace?: boolean;
}

/** One evaluated source/target sector pair in face-to-face mode. */
export interface FacePair {
  sourceId: string;
  targetId: string;
  azA?: number;
  azB?: number;
  bwA?: number;
  bwB?: number;
  distanceKm: number;
  bearingAB: number;
  bearingBA: number;
  diffA?: number;
  diffB?: number;
  aFaces: boolean;
  bFaces: boolean;
  faceToFace: boolean;
}

export interface VoronoiEdge {
  lat1: number;
  lng1: number;
  lat2: number;
  lng2: number;
  siteA: string | null;
  siteB: string | null;
}

export interface CalculatedData {
  sitesWithNeighbors: SiteWithNeighbors[];
  allSites: Site[];
  connections: Connection[];
}

export type MapLayer = "light" | "dark" | "satellite" | "osm";

export const DEFAULT_MAP_LAYER: MapLayer = "satellite";

/**
 * Basemap definitions for MapLibre GL JS raster sources.
 */
export const BASEMAPS = [
  {
    id: "satellite",
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri",
    thumb: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/12/1852/3143",
    tileSize: 256,
    maxZoom: 19,
    bg: "#1a3a2a",
    accent: "#468058",
  },
  {
    id: "light",
    label: "Light",
    url: "https://{a-d}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    thumb: "https://a.basemaps.cartocdn.com/light_all/12/3143/1852.png",
    tileSize: 256,
    maxZoom: 20,
    bg: "#f8fafc",
    accent: "#cbd5e1",
  },
  {
    id: "dark",
    label: "Dark",
    url: "https://{a-d}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    thumb: "https://a.basemaps.cartocdn.com/dark_all/12/3143/1852.png",
    tileSize: 256,
    maxZoom: 20,
    bg: "#0f172a",
    accent: "#334155",
  },
  {
    id: "osm",
    label: "OSM",
    url: "https://{a-c}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
    thumb: "https://tile.openstreetmap.org/12/3143/1852.png",
    tileSize: 256,
    maxZoom: 19,
    bg: "#f0eadb",
    accent: "#fff",
  },
] as const;

export const PALETTE = [
  "#2563eb",
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#14b8a6",
  "#84cc16",
  "#a855f7",
  "#f43f5e",
  "#6366f1",
];

export const LAYER_COLORS = [
  "#22c55e",
  "#eab308",
  "#ef4444",
  "#06b6d4",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#14b8a6",
  "#6366f1",
  "#a855f7",
];

export const SOURCE_COLOR = "#22c55e";
export const NEIGHBOUR_COLOR = "#ef4444";
