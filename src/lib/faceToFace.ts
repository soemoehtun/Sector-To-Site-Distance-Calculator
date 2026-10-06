/**
 * Face-to-Face sector distance calculation.
 *
 * For every (source, target) sector pair the tool evaluates whether the two
 * sectors actually point at each other:
 *
 *   1. Great-circle (Haversine) distance between the sites (km/m).
 *   2. Great-circle bearing A→B and its reciprocal B→A, normalized to 0-360.
 *   3. Azimuth difference: smallest circular angular difference between
 *      sector azimuth and bearing towards the other site.
 *   4. Sector faces the other site when azimuthDiff <= beamwidth / 2.
 *   5. FACE-TO-FACE <=> both sectors are within their beamwidths.
 */
import type { CalcMode, FacePair, Site } from "@/types";
import { angleDiff } from "./distance";

export interface FaceToFaceOptions {
  mode: CalcMode;
  /** Beamwidth used when a site has no mapped beamwidth column. */
  defaultBw: number;
  /** Optional hard distance cap in km; pairs beyond it are skipped. */
  maxKm: number | null;
  /** Progress callback */
  onProgress?: (pct: number) => void;
}

const KM_PER_DEG = 111.32;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const CELL_SIZE_DEG = 0.5; // ~55 km grid cells

interface Sector {
  id: string;
  lat: number;
  lng: number;
  latRad: number;
  lngRad: number;
  cosLat: number;
  sinLat: number;
  azimuth?: number;
  beamwidth?: number;
}

function toSector(s: Site): Sector {
  const latRad = s.lat * DEG_TO_RAD;
  const lngRad = s.lng * DEG_TO_RAD;
  return {
    id: s.id,
    lat: s.lat,
    lng: s.lng,
    latRad,
    lngRad,
    cosLat: Math.cos(latRad),
    sinLat: Math.sin(latRad),
    azimuth: s.azimuth,
    beamwidth: s.beamwidth,
  };
}

function effectiveBeamwidth(s: Sector, defaultBw: number): number {
  const bw = s.beamwidth;
  if (bw === undefined || !isFinite(bw) || bw <= 0) return defaultBw;
  return Math.min(bw, 360);
}

function evaluate(
  a: Sector,
  b: Sector,
  defaultBw: number,
  maxKm: number | null,
): FacePair | null {
  const dLatDeg = Math.abs(a.lat - b.lat);
  if (maxKm !== null && dLatDeg > maxKm / KM_PER_DEG) return null;
  const dLngDeg = Math.abs(a.lng - b.lng) * Math.max(a.cosLat, 0.05);
  if (maxKm !== null && dLngDeg > maxKm / KM_PER_DEG) return null;

  // Fast Haversine
  const sinDlat = Math.sin((b.latRad - a.latRad) * 0.5);
  const sinDlng = Math.sin((b.lngRad - a.lngRad) * 0.5);
  const h = sinDlat * sinDlat + a.cosLat * b.cosLat * sinDlng * sinDlng;
  const distanceKm = 12742 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  if (maxKm !== null && distanceKm > maxKm) return null;

  // True geodesic forward bearing A -> B
  const dLngRad = b.lngRad - a.lngRad;
  const yA = Math.sin(dLngRad) * b.cosLat;
  const xA = a.cosLat * b.sinLat - a.sinLat * b.cosLat * Math.cos(dLngRad);
  const bearingAB = ((Math.atan2(yA, xA) * RAD_TO_DEG) + 360) % 360;

  // True geodesic forward bearing B -> A
  const yB = Math.sin(-dLngRad) * a.cosLat;
  const xB = b.cosLat * a.sinLat - b.sinLat * a.cosLat * Math.cos(-dLngRad);
  const bearingBA = ((Math.atan2(yB, xB) * RAD_TO_DEG) + 360) % 360;

  const bwA = effectiveBeamwidth(a, defaultBw);
  const bwB = effectiveBeamwidth(b, defaultBw);

  let azA = a.azimuth;
  let azB = b.azimuth;
  if (azA !== undefined && (!isFinite(azA) || azA < 0 || azA >= 360)) azA = undefined;
  if (azB !== undefined && (!isFinite(azB) || azB < 0 || azB >= 360)) azB = undefined;

  const diffA = azA === undefined ? undefined : angleDiff(azA, bearingAB);
  const diffB = azB === undefined ? undefined : angleDiff(azB, bearingBA);

  const aFaces = azA !== undefined && diffA !== undefined && diffA <= bwA / 2;
  const bFaces = azB !== undefined && diffB !== undefined && diffB <= bwB / 2;

  return {
    sourceId: a.id,
    targetId: b.id,
    azA: azA === undefined ? undefined : Math.round(azA * 10) / 10,
    azB: azB === undefined ? undefined : Math.round(azB * 10) / 10,
    bwA: Math.round(bwA * 10) / 10,
    bwB: Math.round(bwB * 10) / 10,
    distanceKm: Math.round(distanceKm * 1000) / 1000,
    bearingAB: Math.round(bearingAB * 10) / 10,
    bearingBA: Math.round(bearingBA * 10) / 10,
    diffA: diffA === undefined ? undefined : Math.round(diffA * 10) / 10,
    diffB: diffB === undefined ? undefined : Math.round(diffB * 10) / 10,
    aFaces,
    bFaces,
    faceToFace: aFaces && bFaces,
  };
}

class SpatialGrid {
  private grid = new Map<string, Sector[]>();

  constructor(sectors: Sector[]) {
    for (let i = 0; i < sectors.length; i++) {
      const s = sectors[i];
      const gx = Math.floor(s.lng / CELL_SIZE_DEG);
      const gy = Math.floor(s.lat / CELL_SIZE_DEG);
      const key = `${gx}:${gy}`;
      let cell = this.grid.get(key);
      if (!cell) {
        cell = [];
        this.grid.set(key, cell);
      }
      cell.push(s);
    }
  }

  query(lat: number, lng: number, radiusKm: number): Sector[] {
    const latDelta = radiusKm / KM_PER_DEG;
    const cosL = Math.cos(lat * DEG_TO_RAD);
    const lngDelta = radiusKm / (KM_PER_DEG * Math.max(cosL, 0.05));

    const minGx = Math.floor((lng - lngDelta) / CELL_SIZE_DEG);
    const maxGx = Math.floor((lng + lngDelta) / CELL_SIZE_DEG);
    const minGy = Math.floor((lat - latDelta) / CELL_SIZE_DEG);
    const maxGy = Math.floor((lat + latDelta) / CELL_SIZE_DEG);

    const result: Sector[] = [];
    for (let gy = minGy; gy <= maxGy; gy++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        const cell = this.grid.get(`${gx}:${gy}`);
        if (cell) {
          for (let i = 0; i < cell.length; i++) {
            result.push(cell[i]);
          }
        }
      }
    }
    return result;
  }
}

export async function computeFaceToFace(
  sources: Site[],
  targets: Site[],
  opts: FaceToFaceOptions,
): Promise<FacePair[]> {
  const { defaultBw, maxKm, onProgress } = opts;
  const rows: FacePair[] = [];
  const radiusCap = maxKm !== null ? maxKm : 150;
  const BATCH_SIZE = 400;

  if (opts.mode === "pairwise") {
    const src = sources.map(toSector);
    const tgt = targets.map(toSector);
    const grid = new SpatialGrid(tgt);

    for (let i = 0; i < src.length; i++) {
      const a = src[i];
      const candidates = maxKm !== null || tgt.length > 500
        ? grid.query(a.lat, a.lng, radiusCap)
        : tgt;

      for (let j = 0; j < candidates.length; j++) {
        const b = candidates[j];
        if (a.id === b.id) continue;
        const row = evaluate(a, b, defaultBw, maxKm);
        if (row) rows.push(row);
      }

      if (i % BATCH_SIZE === 0) {
        if (onProgress) onProgress(Math.round((i / src.length) * 100));
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (onProgress) onProgress(100);
    return rows;
  }

  // Single-file mode: emit each unique pair
  const sec = sources.map(toSector);
  const grid = new SpatialGrid(sec);

  for (let i = 0; i < sec.length; i++) {
    const a = sec[i];
    const candidates = maxKm !== null || sec.length > 500
      ? grid.query(a.lat, a.lng, radiusCap)
      : sec;

    for (let j = 0; j < candidates.length; j++) {
      const b = candidates[j];
      if (a.id >= b.id) continue;
      const row = evaluate(a, b, defaultBw, maxKm);
      if (row) rows.push(row);
    }

    if (i % BATCH_SIZE === 0) {
      if (onProgress) onProgress(Math.round((i / sec.length) * 100));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (onProgress) onProgress(100);
  return rows;
}