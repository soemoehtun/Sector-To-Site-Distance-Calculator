/**
 * Sector beam coverage polygons.
 *
 * Each sector is drawn as a wedge: the site location at the apex, sweeping
 * `beamWidth` degrees either side of its azimuth, out to the distance of its
 * farthest matched neighbour (or a default radius when nothing matched). The
 * wedge is built with an equirectangular projection from the site, which is
 * accurate enough for a coverage overlay at telecom scale and much cheaper than
 * a great-circle polyline per sector.
 */
import type { BeamRadiusMode, DistanceUnit, Site, SiteWithNeighbors } from "@/types";
import { getUnitMultiplier } from "./distance";

export interface BeamFeature extends GeoJSON.Feature {
  properties: {
    siteId: string;
    azimuth: number;
    beamWidth: number;
    matched: boolean;
    radiusKm: number;
    color: string;
  };
  geometry: {
    type: "Polygon";
    coordinates: number[][][];
  };
}

/** Approximate conversion: 1 degree of latitude ~ 111.32 km. */
const KM_PER_DEG_LAT = 111.32;
const ARC_SEGMENTS = 10;

function pointAtKm(lat0: number, lon0: number, bearingDeg: number, radiusKm: number): [number, number] {
  const rad = (bearingDeg * Math.PI) / 180;
  const lat = lat0 + (radiusKm / KM_PER_DEG_LAT) * Math.cos(rad);
  const lon =
    lon0 +
    (radiusKm / (KM_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180))) * Math.sin(rad);
  return [lon, lat];
}

function wedgeRing(
  lat0: number,
  lon0: number,
  azimuth: number,
  beamWidth: number,
  radiusKm: number,
): number[][] {
  const half = beamWidth / 2;
  const ring: number[][] = [[lon0, lat0]];
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const angle = azimuth - half + (i * beamWidth) / ARC_SEGMENTS;
    ring.push(pointAtKm(lat0, lon0, ((angle % 360) + 360) % 360, radiusKm));
  }
  ring.push([lon0, lat0]);
  return ring;
}

export interface BuildBeamOptions {
  /**
   * How each sector's beam radius is chosen:
   *  - "auto": farthest matched neighbour distance x1.15 (min 0.2 km), or
   *    `defaultRadiusKm` when nothing matched.
   *  - "value": a fixed `radiusValueKm` for every sector.
   *  - "column": a per-site radius read from the mapped `Site.radius` column,
   *    interpreted in `radiusUnit`; falls back to automatic when unmapped.
   */
  radiusMode?: BeamRadiusMode;
  /** Fixed radius in km (used when radiusMode === "value"). */
  radiusValueKm?: number;
  /** Unit the radius column (and value input) is expressed in. */
  radiusUnit?: DistanceUnit;
  /** Max distance of matched neighbors used as the auto beam radius cap. */
  defaultRadiusKm?: number;
  matchedColor?: string;
  unmatchedColor?: string;
  /**
   * Per-site beamwidth overrides, keyed by site id. When a site has no entry
   * here the shared `beamWidth` argument is used. Sectors without an azimuth
   * still draw an omnidirectional wedge.
   */
  beamWidthById?: Record<string, number>;
  /**
   * Per-site radius in km (used when radiusMode === "column" with category assignment).
   */
  radiusById?: Record<string, number>;
}

/**
 * Builds one beam polygon per source site. Sectors without a mapped azimuth get
 * a full 360° omni wedge, and sectors that matched nothing get the default
 * radius so their direction is still visible.
 */
export function buildBeamPolygons(
  sourceSites: Site[],
  sitesWithNeighbors: SiteWithNeighbors[],
  beamWidth: number,
  opts: BuildBeamOptions = {},
): BeamFeature[] {
  const mode = opts.radiusMode ?? "auto";
  const radiusUnitKm = 1 / getUnitMultiplier(opts.radiusUnit ?? "km");
  const defaultRadiusKm = opts.defaultRadiusKm ?? 2;
  const matchedColor = opts.matchedColor ?? "#22c55e";
  const unmatchedColor = opts.unmatchedColor ?? "#ef4444";

  const autoRadiusById = new Map<string, number>();
  for (const s of sitesWithNeighbors) {
    if (!s.neighbors || s.neighbors.length === 0) continue;
    let max = 0;
    for (const n of s.neighbors) if (n.dist > max) max = n.dist;
    if (max > 0) autoRadiusById.set(s.id, Math.max(max * 1.15, 0.2));
  }

  const radiusFor = (s: Site): number => {
    if (mode === "column" && opts.radiusById && s.id in opts.radiusById) {
      return opts.radiusById[s.id];
    }
    if (mode === "value") return opts.radiusValueKm ?? defaultRadiusKm;
    if (mode === "column" && s.radius !== undefined && isFinite(s.radius) && s.radius > 0) {
      return s.radius * radiusUnitKm;
    }
    return autoRadiusById.get(s.id) ?? defaultRadiusKm;
  };

  const features: BeamFeature[] = [];
  const beamWidthById = opts.beamWidthById;
  for (const s of sourceSites) {
    const anyAz = s.azimuth !== undefined && isFinite(s.azimuth);
    if (!anyAz) continue;
    const siteBw =
      beamWidthById && s.id in beamWidthById ? beamWidthById[s.id] : beamWidth;
    const faceBw =
      s.beamwidth !== undefined && isFinite(s.beamwidth) && s.beamwidth > 0
        ? s.beamwidth
        : siteBw;
    const beamWidthDeg = faceBw;
    const matched = autoRadiusById.has(s.id);
    const radiusKm = radiusFor(s);
    if (s.lat === s.lng && s.lat === 0) continue;

    features.push({
      type: "Feature",
      properties: {
        siteId: s.id,
        azimuth: anyAz ? s.azimuth! : 0,
        beamWidth: beamWidthDeg,
        matched,
        radiusKm,
        color: matched ? matchedColor : unmatchedColor,
      },
      geometry: {
        type: "Polygon",
        coordinates: [wedgeRing(s.lat, s.lng, anyAz ? s.azimuth! : 0, beamWidthDeg, radiusKm)],
      },
    });
  }
  return features;
}