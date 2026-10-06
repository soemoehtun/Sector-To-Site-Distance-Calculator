import type {
  CalcMode,
  CalcMethod,
  CalculatedData,
  Connection,
  DistanceOperator,
  DistanceUnit,
  NeighborResult,
  Site,
  SiteWithNeighbors,
} from "@/types";
import {
  engineCalcRange,
  engineSetup,
} from "./engine";
import {
  buildDelaunayAdjacency,
  computeDelaunay,
  getDelaunayNeighborsNLayers,
} from "./voronoi";

/**
 * Haversine great-circle distance between two lat/lon points in kilometers.
 */
export function haversine(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function getUnitMultiplier(unit: DistanceUnit): number {
  switch (unit) {
    case "m":
      return 1000;
    case "ft":
      return 3280.84;
    case "mi":
      return 0.621371;
    case "km":
    default:
      return 1;
  }
}

/**
 * Forward azimuth (bearing) from (lat1,lon1) to (lat2,lon2), degrees clockwise
 * from north. This is the standard atan2-based great-circle initial bearing.
 */
export function bearingToSite(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const lat1r = (lat1 * Math.PI) / 180;
  const lat2r = (lat2 * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2r);
  const x =
    Math.cos(lat1r) * Math.sin(lat2r) -
    Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * Smallest angular difference between two headings in degrees, in [0,180].
 */
export function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * Whether a target at the given bearing lies inside a sector's beam:
 * |bearing - azimuth| <= beamwidth / 2.
 */
export function inBeam(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  azimuth: number | undefined,
  beamWidth: number,
): boolean {
  if (azimuth === undefined || !isFinite(azimuth) || beamWidth <= 0 || beamWidth >= 360) {
    return true;
  }
  return angleDiff(bearingToSite(lat1, lon1, lat2, lon2), azimuth) <= beamWidth / 2;
}

/** Distances at or below this are treated as "the same place". */
const ZERO_EPS = 1e-6;

/** Coordinates of the candidate sites, in flat arrays for a tight scan loop. */
interface TargetCoords {
  lat: Float64Array;
  lon: Float64Array;
  cosLat: Float64Array;
}

function toTargetCoords(sites: Site[]): TargetCoords {
  const n = sites.length;
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const cosLat = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const l = sites[i].lat;
    lat[i] = l;
    lon[i] = sites[i].lng;
    cosLat[i] = Math.cos((l * Math.PI) / 180);
  }
  return { lat, lon, cosLat };
}

/**
 * Whether a distance passes the max-distance filter.
 *
 * `maxDistance === null` (no limit) short-circuits to true, so the common case
 * never evaluates an operator per candidate.
 */
function passesMaxDistance(
  dist: number,
  maxDistance: number | null,
  op: DistanceOperator,
): boolean {
  if (maxDistance === null || isNaN(maxDistance)) return true;
  switch (op) {
    case "<":
      return dist < maxDistance;
    case "<=":
      return dist <= maxDistance;
    case ">":
      return dist > maxDistance;
    case ">=":
      return dist >= maxDistance;
    case "=":
      return dist === maxDistance;
    default:
      return true;
  }
}

/**
 * The n nearest candidates to one source site.
 *
 * Scans the candidates once, keeping only the n best in a sorted window, and
 * hands back the rows that ended up in it. This replaces the previous "build an
 * object for every candidate, filter, sort the lot, slice" approach, which cost
 * O(n log n) and a full set of allocations per source site.
 */
function bruteForceNeighbors(
  s1: Site,
  hasTarget: boolean,
  excludeZero: boolean,
  maxDistance: number | null,
  distanceOp: DistanceOperator,
  multiplier: number,
  k: number,
  target: TargetCoords,
  targetIds: string[],
  beamWidth: number,
): NeighborResult[] {
  const { lat, lon, cosLat } = target;
  const n = lat.length;
  const bestDist = new Float64Array(k);
  const bestIdx = new Int32Array(k);
  let filled = 0;
  const azimuth = s1.azimuth;

  // Same expressions, in the same order, as `haversine` above, so the distances
  // this produces are bit-for-bit what the old implementation produced.
  const lat1rad = (s1.lat * Math.PI) / 180;
  const cosLat1 = Math.cos(lat1rad);
  const minKmPerLatDeg = 111.1949 * multiplier;

  const effBeamWidth =
    s1.beamwidth !== undefined && isFinite(s1.beamwidth) && s1.beamwidth > 0
      ? s1.beamwidth
      : beamWidth;
  const hasBeam =
    effBeamWidth > 0 && effBeamWidth < 360 && azimuth !== undefined && isFinite(azimuth);
  const halfBeam = hasBeam ? effBeamWidth / 2 : 0;

  for (let j = 0; j < n; j++) {
    if (!hasTarget && targetIds[j] === s1.id) continue;

    // Fast meridian bound: great-circle distance is strictly >= R * |deltaLat|.
    // Once the window is filled, skip trigonometry if candidate cannot beat bestDist[k-1].
    if (filled === k && Math.abs(lat[j] - s1.lat) * minKmPerLatDeg >= bestDist[k - 1]) {
      continue;
    }

    // Sector filter: only keep candidates pointing into the beam. Checked after
    // the cheap latitude bound but before the full distance trigonometry.
    if (
      hasBeam &&
      angleDiff(bearingToSite(s1.lat, s1.lng, lat[j], lon[j]), azimuth) > halfBeam
    ) {
      continue;
    }

    const dLat = ((lat[j] - s1.lat) * Math.PI) / 180;
    const dLon = ((lon[j] - s1.lng) * Math.PI) / 180;
    const sLat = Math.sin(dLat / 2);
    const sLon = Math.sin(dLon / 2);
    const a =
      sLat * sLat +
      cosLat1 *
        cosLat[j] *
        sLon *
        sLon;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const dist = 6371 * c * multiplier;
    if (excludeZero && dist <= ZERO_EPS) continue;
    if (!passesMaxDistance(dist, maxDistance, distanceOp)) continue;

    if (filled === k) {
      // Equal distances keep the earlier candidate, matching the stable sort
      // of the full candidate list this replaced.
      if (dist >= bestDist[k - 1]) continue;
    }
    let p = filled < k ? filled : k - 1;
    while (p > 0 && bestDist[p - 1] > dist) {
      bestDist[p] = bestDist[p - 1];
      bestIdx[p] = bestIdx[p - 1];
      p--;
    }
    bestDist[p] = dist;
    bestIdx[p] = j;
    if (filled < k) filled++;
  }

  const out: NeighborResult[] = [];
  for (let p = 0; p < filled; p++) {
    out.push({ to: targetIds[bestIdx[p]], dist: bestDist[p] });
  }
  return out;
}

export interface CalculationOptions {
  mode: CalcMode;
  method: CalcMethod;
  sourceSites: Site[];
  targetSites: Site[];
  nNeighbors: number;
  voronoiLayers: number;
  /** Sector beam width in degrees (used when method === "sector"). */
  beamWidth: number;
  unit: DistanceUnit;
  excludeZero: boolean;
  maxDistance: number | null;
  distanceOp: DistanceOperator;
  onProgress?: (progress: number) => void;
}

/**
 * Asynchronously calculates distances in chunks to keep the UI responsive.
 */
export function calculateDistancesAsync(
  opts: CalculationOptions,
): Promise<CalculatedData> {
  return new Promise((resolve) => {
    const {
      mode,
      method,
      sourceSites,
      targetSites,
      nNeighbors,
      voronoiLayers,
      beamWidth,
      unit,
      excludeZero,
      maxDistance,
      distanceOp,
      onProgress,
    } = opts;

    if (!sourceSites.length) {
      resolve({ sitesWithNeighbors: [], allSites: [], connections: [] });
      return;
    }

    const hasTarget = mode === "pairwise" && targetSites.length > 0;
    const parsedTarget = hasTarget ? targetSites : sourceSites;

    // Build unified list of all sites
    const allSitesMap = new Map<string, Site>();
    sourceSites.forEach((s) => allSitesMap.set(s.id, { ...s, isSource: true }));
    if (hasTarget) {
      parsedTarget.forEach((s) => {
        if (!allSitesMap.has(s.id)) {
          allSitesMap.set(s.id, { ...s, isTarget: true, isSource: false });
        } else {
          allSitesMap.get(s.id)!.isTarget = true;
        }
      });
    } else {
      Array.from(allSitesMap.values()).forEach((s) => (s.isTarget = true));
    }
    const unifiedAllSites = Array.from(allSitesMap.values());

    if (!sourceSites.length || !parsedTarget.length || nNeighbors < 1) {
      resolve({
        sitesWithNeighbors: sourceSites.map((s) => ({ ...s, neighbors: [] })),
        allSites: unifiedAllSites,
        connections: [],
      });
      return;
    }

    const multiplier = getUnitMultiplier(unit);

    // The unified point list is needed by both the engine (it returns indices
    // into it) and the JavaScript fallback. The triangulation, though, is only
    // needed by the fallback: Bowyer-Watson is O(n^2), so building it eagerly
    // froze the main thread for tens of seconds on large datasets even though
    // the engine was about to do the work in wasm. It is built on first use
    // instead, and the engine index it does not need is built right away.
    let voronoiAllPts: Site[] | null = null;
    let voronoiTriangles: ReturnType<typeof computeDelaunay> | null = null;
    let voronoiAdjacency: Map<number, number[]> | null = null;

    if (method === "voronoi") {
      const combinedMap = new Map<string, Site>();
      sourceSites.forEach((s) => combinedMap.set(s.id, s));
      parsedTarget.forEach((s) => {
        if (!combinedMap.has(s.id)) combinedMap.set(s.id, s);
      });
      voronoiAllPts = Array.from(combinedMap.values());
    }

    const ensureTriangulation = () => {
      if (voronoiTriangles && voronoiAdjacency) return;
      const pts = voronoiAllPts!.map((t) => ({ x: t.lng, y: t.lat }));
      voronoiTriangles = computeDelaunay(pts);
      voronoiAdjacency = buildDelaunayAdjacency(voronoiTriangles);
    };

    // The Go/WASM engine keeps the dataset in its own memory and returns the
    // neighbour lists for a range of sources. It is optional: if it is not
    // available (or disagrees about anything) the JavaScript path below runs
    // unchanged.
    const engineIndexOf = new Map<string, number>();
    if (voronoiAllPts) {
      voronoiAllPts.forEach((s, i) => engineIndexOf.set(s.id, i));
    }
    const targetIds = parsedTarget.map((s) => s.id);
    const targetCoords = toTargetCoords(parsedTarget);
    const engineReady = engineSetup({
      sourceIds: sourceSites.map((s) => s.id),
      sourceLat: sourceSites.map((s) => s.lat),
      sourceLon: sourceSites.map((s) => s.lng),
      sourceAzimuth: sourceSites.map((s) => s.azimuth ?? NaN),
      sourceBeamwidth: sourceSites.map((s) => s.beamwidth ?? NaN),
      targetIds: hasTarget ? parsedTarget.map((s) => s.id) : undefined,
      targetLat: hasTarget ? parsedTarget.map((s) => s.lat) : undefined,
      targetLon: hasTarget ? parsedTarget.map((s) => s.lng) : undefined,
      hasTarget,
      nNeighbors,
      voronoiLayers,
      beamWidth,
      unit,
      // Face-to-face runs through computeFaceToFace directly; the engine's
      // setup only knows the three neighbour modes, so narrow it here.
      method: method === "face" ? "sector" : method,
      excludeZero,
      maxDistance,
      distanceOp,
    }).then(
      (ok) => {
        if (ok && onProgress) onProgress(2);
        return ok;
      },
      () => false,
    );

    const processedSites: SiteWithNeighbors[] = [];
    const total = sourceSites.length;
    let currentIndex = 0;
    const CHUNK_SIZE = 50;
    let engineTried = false;

    // Runs the whole source list through the engine in ranges, then reuses the
    // existing finalize() so the connections, isNeighbor flags and unified site
    // list are built exactly as before.
    const ENGINE_CHUNK = 1000;
    const engineStep = async (from: number) => {
      const uniIds = voronoiAllPts ? voronoiAllPts.map((s) => s.id) : null;
      // Brute force returns indices into the target list, Voronoi indices into
      // the unified list - the engine keeps the same convention.
      const idOf = (i: number) => (uniIds ? uniIds[i] : targetIds[i]);
      const collected: { site: Site; neighbors: NeighborResult[] }[] = [];
      for (let start = from; start < total; start += ENGINE_CHUNK) {
        const end = Math.min(start + ENGINE_CHUNK, total);
        const range = await engineCalcRange(idOf, start, end);
        if (!range) {
          engineFallback();
          return;
        }
        for (let i = 0; i < end - start; i++) {
          collected.push({
            site: sourceSites[start + i],
            neighbors: range.rows[i].map((r) =>
              method === "voronoi"
                ? { to: r.to, dist: r.dist, layer: r.layer }
                : { to: r.to, dist: r.dist },
            ),
          });
        }
        currentIndex = end;
        if (onProgress) onProgress(Math.round((end / total) * 90));
      }
      for (const c of collected) {
        processedSites.push({ ...c.site, neighbors: c.neighbors });
      }
      finalize();
    };

    const engineFallback = () => {
      // The engine failed part way: drop whatever it produced and redo the
      // whole list in JavaScript.
      processedSites.length = 0;
      currentIndex = 0;
      if (onProgress) onProgress(0);
      processChunk();
    };

    const processChunk = () => {
      const end = Math.min(currentIndex + CHUNK_SIZE, total);

      if (!engineTried) {
        engineTried = true;
        engineReady.then((ok) => {
          // The engine owns the dataset only once setup succeeded; without it
          // the JavaScript path has to run from the start, otherwise the
          // promise never settles and the progress bar spins forever.
          if (ok) engineStep(0);
          else processChunk();
        });
        return;
      }

      for (let i = currentIndex; i < end; i++) {
        const s1 = sourceSites[i];
        let neighbors: NeighborResult[] = [];

        if (method === "voronoi" && voronoiAllPts) {
          const srcIdx = engineIndexOf.get(s1.id);
          if (srcIdx !== undefined) {
            ensureTriangulation();
            let layerMap = getDelaunayNeighborsNLayers(
              voronoiTriangles!,
              srcIdx,
              voronoiLayers,
              voronoiAdjacency!,
            );

            // Handle degenerate duplicate coordinates fallback
            if (layerMap.size === 0) {
              let fallbackIdx = -1;
              let minDist = Infinity;
              voronoiAllPts.forEach((s, idx) => {
                if (idx !== srcIdx) {
                  const d = haversine(s1.lat, s1.lng, s.lat, s.lng);
                  if (d < minDist) {
                    minDist = d;
                    fallbackIdx = idx;
                  }
                }
              });
              if (fallbackIdx >= 0) {
                layerMap = getDelaunayNeighborsNLayers(
                  voronoiTriangles!,
                  fallbackIdx,
                  voronoiLayers,
                  voronoiAdjacency!,
                );
              }
            }

            const results: NeighborResult[] = [];
            layerMap.forEach((layer, idx) => {
              if (idx !== srcIdx) {
                const d =
                  haversine(
                    s1.lat,
                    s1.lng,
                    voronoiAllPts![idx].lat,
                    voronoiAllPts![idx].lng,
                  ) * multiplier;
                results.push({ to: voronoiAllPts![idx].id, dist: d, layer });
              }
            });
            results.sort((a, b) => a.dist - b.dist);
            neighbors = results;
          }
        } else {
          // Brute force N-NN. Targets are held in flat typed arrays and the top
          // nNeighbors are tracked in a sorted window, so each source costs one
          // pass over the targets instead of building and sorting a full array
          // of every distance. Equal distances keep the earlier target, which
          // is what a stable sort of the full list used to do.
          neighbors = bruteForceNeighbors(
            s1,
            hasTarget,
            excludeZero,
            maxDistance,
            distanceOp,
            multiplier,
            nNeighbors,
            targetCoords,
            targetIds,
            beamWidth,
          );
        }

        processedSites.push({ ...s1, neighbors });
      }

      currentIndex = end;
      const progress = Math.round((currentIndex / total) * 90);
      if (onProgress) onProgress(progress);

      if (currentIndex < total) {
        setTimeout(processChunk, 0);
      } else {
        finalize();
      }
    };

    const finalize = () => {
      if (onProgress) onProgress(95);

      const conns: Connection[] = [];
      const added = new Set<string>();

      if (method !== "voronoi") {
        processedSites.forEach((s) => {
          (s.neighbors || []).forEach((n) => {
            const pair = `${s.id}|${n.to}`;
            if (!added.has(pair)) {
              added.add(pair);
              conns.push({ from: s.id, to: n.to, distance: n.dist });
            }
          });
        });

        const neighborIds = new Set<string>();
        processedSites.forEach((s) => {
          s.neighbors?.forEach((n) => neighborIds.add(n.to));
        });

        unifiedAllSites.forEach((s) => {
          if (neighborIds.has(s.id)) {
            s.isNeighbor = true;
          }
        });
      }

      if (onProgress) onProgress(100);

      resolve({
        sitesWithNeighbors: processedSites,
        allSites: unifiedAllSites,
        connections: conns,
      });
    };

    setTimeout(processChunk, 0);
  });
}
