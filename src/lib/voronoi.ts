import type { Site } from "@/types";


export interface Point2D {
  x: number; // longitude
  y: number; // latitude
}

export interface Triangle {
  a: number;
  b: number;
  c: number;
}

export interface Circumcircle {
  cx: number;
  cy: number;
  r: number;
}

export interface VoronoiCellPolygonFeature {
  type: "Feature";
  id: string;
  properties: {
    siteId: string;
    color: string;
  };
  geometry: {
    type: "Polygon";
    coordinates: number[][][];
  };
}

/**
 * Circumcircle calculation for 3 points in 2D space.
 */
export function circumcircle(
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
): Circumcircle {
  const ax = p1.x,
    ay = p1.y;
  const bx = p2.x,
    by = p2.y;
  const cx = p3.x,
    cy = p3.y;
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(D) < 1e-10) {
    return { cx: (ax + bx + cx) / 3, cy: (ay + by + cy) / 3, r: 1e10 };
  }
  const ux =
    ((ax * ax + ay * ay) * (by - cy) +
      (bx * bx + by * by) * (cy - ay) +
      (cx * cx + cy * cy) * (ay - by)) /
    D;
  const uy =
    ((ax * ax + ay * ay) * (cx - bx) +
      (bx * bx + by * by) * (ax - cx) +
      (cx * cx + cy * cy) * (bx - ax)) /
    D;
  const r = Math.sqrt((ax - ux) * (ax - ux) + (ay - uy) * (ay - uy));
  return { cx: ux, cy: uy, r };
}

/**
 * Bowyer-Watson Delaunay triangulation operating in planar projected space (x = lng, y = lat).
 * Circumcircles are cached per triangle so each is computed only once.
 */
export function computeDelaunay(pts: Point2D[]): Triangle[] {
  const n = pts.length;
  if (n < 3) return [];

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  pts.forEach((p) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  });

  const dx = maxX - minX,
    dy = maxY - minY;
  const deltaMax = Math.max(dx, dy) * 10 || 100;
  const midX = (minX + maxX) / 2,
    midY = (minY + maxY) / 2;

  const superPts: Point2D[] = [
    { x: midX - 20 * deltaMax, y: midY - deltaMax },
    { x: midX, y: midY + 20 * deltaMax },
    { x: midX + 20 * deltaMax, y: midY - deltaMax },
  ];

  const allPts = pts.concat(superPts);
  const si = n,
    sj = n + 1,
    sk = n + 2;

  // triangles and triCC are kept in sync: triCC[i] is the circumcircle of triangles[i].
  // Each circumcircle is computed once when the triangle is created.
  let triangles: Triangle[] = [{ a: si, b: sj, c: sk }];
  let triCC: Circumcircle[] = [circumcircle(allPts[si], allPts[sj], allPts[sk])];

  const edgeKey = (u: number, v: number): number =>
    u < v ? u * 10000000 + v : v * 10000000 + u;
  const edgeCount = new Map<number, number>();

  for (let pi = 0; pi < n; pi++) {
    const p = allPts[pi];
    const badTriangles: Triangle[] = [];
    const goodTriangles: Triangle[] = [];
    const goodCC: Circumcircle[] = [];

    for (let i = 0; i < triangles.length; i++) {
      const tri = triangles[i];
      const { cx, cy, r } = triCC[i];
      const dist2 = (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy);
      if (dist2 <= r * r + 1e-10) {
        badTriangles.push(tri);
      } else {
        goodTriangles.push(tri);
        goodCC.push(triCC[i]);
      }
    }

    edgeCount.clear();
    for (let i = 0; i < badTriangles.length; i++) {
      const tri = badTriangles[i];
      const k1 = edgeKey(tri.a, tri.b);
      const k2 = edgeKey(tri.b, tri.c);
      const k3 = edgeKey(tri.c, tri.a);
      edgeCount.set(k1, (edgeCount.get(k1) || 0) + 1);
      edgeCount.set(k2, (edgeCount.get(k2) || 0) + 1);
      edgeCount.set(k3, (edgeCount.get(k3) || 0) + 1);
    }

    for (let i = 0; i < badTriangles.length; i++) {
      const tri = badTriangles[i];
      const k1 = edgeKey(tri.a, tri.b);
      if (edgeCount.get(k1) === 1) {
        goodTriangles.push({ a: pi, b: tri.a, c: tri.b });
        goodCC.push(circumcircle(allPts[pi], allPts[tri.a], allPts[tri.b]));
      }
      const k2 = edgeKey(tri.b, tri.c);
      if (edgeCount.get(k2) === 1) {
        goodTriangles.push({ a: pi, b: tri.b, c: tri.c });
        goodCC.push(circumcircle(allPts[pi], allPts[tri.b], allPts[tri.c]));
      }
      const k3 = edgeKey(tri.c, tri.a);
      if (edgeCount.get(k3) === 1) {
        goodTriangles.push({ a: pi, b: tri.c, c: tri.a });
        goodCC.push(circumcircle(allPts[pi], allPts[tri.c], allPts[tri.a]));
      }
    }

    triangles = goodTriangles;
    triCC = goodCC;
  }

  return triangles.filter((tri) => tri.a < n && tri.b < n && tri.c < n);
}


/**
 * Returns a Set of point indices that are Delaunay-adjacent to targetIdx.
 */
export function getDelaunayNeighbors(
  triangles: Triangle[],
  targetIdx: number,
): Set<number> {
  const neighbors = new Set<number>();
  triangles.forEach((tri) => {
    const verts = [tri.a, tri.b, tri.c];
    if (verts.includes(targetIdx)) {
      verts.forEach((v) => {
        if (v !== targetIdx) neighbors.add(v);
      });
    }
  });
  return neighbors;
}

/**
 * Turns a triangulation into an adjacency list, so neighbour lookups are O(deg)
 * instead of a full scan of every triangle.
 *
 * The neighbour order is identical to `getDelaunayNeighbors` (triangles in
 * order, other two vertices in a-b-c order, first occurrence wins) so callers
 * that sort by distance afterwards stay bit-for-bit compatible.
 */
export function buildDelaunayAdjacency(
  triangles: Triangle[],
): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  const push = (u: number, v: number) => {
    const list = adj.get(u);
    if (list === undefined) adj.set(u, [v]);
    else list.push(v);
  };

  for (let i = 0; i < triangles.length; i++) {
    const { a, b, c } = triangles[i];
    // One insertion per vertex, listing the other two in a-b-c order, which is
    // exactly what scanning `verts = [a, b, c]` per triangle would have added.
    push(a, b);
    push(a, c);
    push(b, a);
    push(b, c);
    push(c, a);
    push(c, b);
  }

  // Drop repeated edges in place, keeping the first occurrence, so the BFS
  // below does not revisit the same vertex.
  adj.forEach((list) => {
    if (list.length < 2) return;
    let w = 1;
    for (let r = 1; r < list.length; r++) {
      const v = list[r];
      let seen = false;
      for (let c = 0; c < w; c++) {
        if (list[c] === v) {
          seen = true;
          break;
        }
      }
      if (!seen) list[w++] = v;
    }
    list.length = w;
  });

  return adj;
}

/**
 * N-ring Voronoi neighbours via BFS through a prebuilt Delaunay adjacency
 * graph. Same layers and same insertion order as
 * `getDelaunayNeighborsNLayers`, but without rescanning the triangulation.
 */
export function neighborLayersFromAdjacency(
  adj: Map<number, number[]>,
  targetIdx: number,
  nLayers: number,
): Map<number, number> {
  if (nLayers < 1) return new Map();
  const layerMap = new Map<number, number>();
  let frontier = new Set<number>([targetIdx]);

  for (let layer = 1; layer <= nLayers; layer++) {
    const nextFrontier = new Set<number>();
    frontier.forEach((idx) => {
      const list = adj.get(idx);
      if (list === undefined) return;
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        if (n !== targetIdx && !layerMap.has(n)) {
          layerMap.set(n, layer);
          nextFrontier.add(n);
        }
      }
    });
    frontier = nextFrontier;
  }
  return layerMap;
}

/**
 * N-ring Voronoi neighbors via BFS through Delaunay adjacency graph.
 * Layer 1 = direct Delaunay neighbors, Layer 2 = neighbors of neighbors, etc.
 * Returns Map of neighborIdx → layerNumber (1-indexed).
 */
export function getDelaunayNeighborsNLayers(
  triangles: Triangle[],
  targetIdx: number,
  nLayers: number,
  adj?: Map<number, number[]>,
): Map<number, number> {
  if (nLayers < 1) return new Map();
  if (adj) return neighborLayersFromAdjacency(adj, targetIdx, nLayers);
  return neighborLayersFromAdjacency(
    buildDelaunayAdjacency(triangles),
    targetIdx,
    nLayers,
  );
}

export interface VoronoiIndex {
  circumcenters: { lng: number; lat: number }[];
  vertexTriangles: number[][];
}

export function buildVoronoiIndex(
  triangles: Triangle[],
  pts: Point2D[],
): VoronoiIndex {
  const circumcenters = new Array<{ lng: number; lat: number }>(triangles.length);
  for (let i = 0; i < triangles.length; i++) {
    const tri = triangles[i];
    const c = circumcircle(pts[tri.a], pts[tri.b], pts[tri.c]);
    circumcenters[i] = { lng: c.cx, lat: c.cy };
  }

  const vertexTriangles: number[][] = Array.from({ length: pts.length }, () => []);
  for (let i = 0; i < triangles.length; i++) {
    const tri = triangles[i];
    if (tri.a < pts.length) vertexTriangles[tri.a].push(i);
    if (tri.b < pts.length) vertexTriangles[tri.b].push(i);
    if (tri.c < pts.length) vertexTriangles[tri.c].push(i);
  }

  return { circumcenters, vertexTriangles };
}

/**
 * Compute the closed Voronoi cell polygon for a single site from Delaunay triangulation.
 * Returns array of {lat, lng} vertices in angular order around the site.
 */
export function computeVoronoiCellPolygon(
  triangles: Triangle[],
  pts: Point2D[],
  siteIdx: number,
  index?: VoronoiIndex,
): { lat: number; lng: number }[] {
  let targetIndex = siteIdx;
  let centers: { lng: number; lat: number }[];

  if (index && index.vertexTriangles[targetIndex] !== undefined) {
    const triIdxs = index.vertexTriangles[targetIndex];
    if (triIdxs.length === 0) {
      const p = pts[targetIndex];
      if (!p) return [];
      const dupIdx = pts.findIndex((otherP) => otherP.x === p.x && otherP.y === p.y);
      if (dupIdx !== -1 && dupIdx !== targetIndex) {
        targetIndex = dupIdx;
      }
    }
    const finalIdxs = index.vertexTriangles[targetIndex] || [];
    if (finalIdxs.length === 0) return [];
    centers = finalIdxs.map((t) => index.circumcenters[t]);
  } else {
    let adjTris = triangles.filter(
      (tri) =>
        tri.a === targetIndex || tri.b === targetIndex || tri.c === targetIndex,
    );

    if (adjTris.length === 0) {
      const p = pts[targetIndex];
      if (!p) return [];
      const dupIdx = pts.findIndex((otherP) => otherP.x === p.x && otherP.y === p.y);
      if (dupIdx !== -1 && dupIdx !== targetIndex) {
        targetIndex = dupIdx;
        adjTris = triangles.filter(
          (tri) =>
            tri.a === targetIndex || tri.b === targetIndex || tri.c === targetIndex,
        );
      }
    }

    if (adjTris.length === 0) return [];

    centers = adjTris.map((tri) => {
      const c = circumcircle(pts[tri.a], pts[tri.b], pts[tri.c]);
      return { lng: c.cx, lat: c.cy };
    });
  }

  const sitePt = pts[targetIndex];
  centers.sort((a, b) => {
    const angleA = Math.atan2(a.lat - sitePt.y, a.lng - sitePt.x);
    const angleB = Math.atan2(b.lat - sitePt.y, b.lng - sitePt.x);
    return angleA - angleB;
  });

  return centers;
}

/**
 * Compute Voronoi cell polygons for all sites in dataset.
 */
export function computeAllVoronoiPolygons(
  targets: Site[],
): VoronoiCellPolygonFeature[] {
  if (targets.length < 3) return [];
  const pts: Point2D[] = targets.map((t) => ({ x: t.lng, y: t.lat }));
  const triangles = computeDelaunay(pts);
  if (triangles.length === 0) return [];

  const vIndex = buildVoronoiIndex(triangles, pts);
  const features: VoronoiCellPolygonFeature[] = [];

  targets.forEach((site, i) => {
    const polyVertices = computeVoronoiCellPolygon(triangles, pts, i, vIndex);
    if (polyVertices.length < 3) return;

    const ring = [
      ...polyVertices.map((p) => [p.lng, p.lat]),
      [polyVertices[0].lng, polyVertices[0].lat],
    ];

    features.push({
      type: "Feature",
      id: site.id,
      properties: {
        siteId: site.id,
        color: "#8b5cf6",
      },
      geometry: {
        type: "Polygon",
        coordinates: [ring],
      },
    });
  });

  return features;
}


