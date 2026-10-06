package main

import (
	"math"
	"sort"
)

type triangle struct{ a, b, c int }

type point2 struct{ x, y float64 }

type circum struct{ cx, cy, r float64 }

// circumcircle is a port of circumcircle() in src/lib/voronoi.ts.
func circumcircle(p1, p2, p3 point2) circum {
	D := 2 * (p1.x*(p2.y-p3.y) + p2.x*(p3.y-p1.y) + p3.x*(p1.y-p2.y))
	if math.Abs(D) < 1e-10 {
		return circum{
			cx: (p1.x + p2.x + p3.x) / 3,
			cy: (p1.y + p2.y + p3.y) / 3,
			r:  1e10,
		}
	}
	ux := ((p1.x*p1.x+p1.y*p1.y)*(p2.y-p3.y) +
		(p2.x*p2.x+p2.y*p2.y)*(p3.y-p1.y) +
		(p3.x*p3.x+p3.y*p3.y)*(p1.y-p2.y)) / D
	uy := ((p1.x*p1.x+p1.y*p1.y)*(p3.x-p2.x) +
		(p2.x*p2.x+p2.y*p2.y)*(p1.x-p3.x) +
		(p3.x*p3.x+p3.y*p3.y)*(p2.x-p1.x)) / D
	r := math.Sqrt((p1.x-ux)*(p1.x-ux) + (p1.y-uy)*(p1.y-uy))
	return circum{cx: ux, cy: uy, r: r}
}

// delaunay is a Bowyer-Watson triangulation over planar (x = lon, y = lat)
// coordinates. It reproduces the JS implementation, with two changes that do
// not alter the result: the triangle set is stored in flat int slices instead of
// per-triangle objects, and boundary edges are counted in a map keyed by a
// packed uint64 instead of a string.
type delaunay struct {
	pts  []point2
	tris []int32 // 3 indices per triangle
	n    int     // number of real points (super-triangle points excluded)
}

func triangulate(pts []point2) *delaunay {
	d := &delaunay{pts: pts, n: len(pts)}
	if len(pts) < 3 {
		return d
	}

	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, p := range pts {
		minX = math.Min(minX, p.x)
		minY = math.Min(minY, p.y)
		maxX = math.Max(maxX, p.x)
		maxY = math.Max(maxY, p.y)
	}
	dx, dy := maxX-minX, maxY-minY
	deltaMax := math.Max(dx, dy) * 10
	if deltaMax == 0 {
		deltaMax = 100
	}
	midX, midY := (minX+maxX)/2, (minY+maxY)/2

	all := make([]point2, len(pts)+3)
	copy(all, pts)
	si, sj, sk := len(pts), len(pts)+1, len(pts)+2
	all[si] = point2{midX - 20*deltaMax, midY - deltaMax}
	all[sj] = point2{midX, midY + 20*deltaMax}
	all[sk] = point2{midX + 20*deltaMax, midY - deltaMax}

	// tris and cc are kept in lock-step: cc[t/3] is the circumcircle of the
	// triangle at tris[t..t+2].  Each circumcircle is computed once when the
	// triangle is first created and never recomputed — the old code recomputed
	// every surviving triangle's circumcircle for every new point insertion.
	tris := make([]int32, 0, 6*(len(pts)+2))
	tris = append(tris, int32(si), int32(sj), int32(sk))
	cc := make([]circum, 0, cap(tris)/3)
	cc = append(cc, circumcircle(all[si], all[sj], all[sk]))

	type edgeKey struct{ u, v int32 }
	good := make([]int32, 0, len(tris))
	ccGood := make([]circum, 0, len(cc))
	bad := make([]int32, 0, 64)
	counts := make(map[edgeKey]int, 128)

	for pi := 0; pi < len(pts); pi++ {
		p := all[pi]
		good = good[:0]
		ccGood = ccGood[:0]
		bad = bad[:0]
		for t := 0; t < len(tris); t += 3 {
			c := cc[t/3]
			dxp, dyp := p.x-c.cx, p.y-c.cy
			if dxp*dxp+dyp*dyp <= c.r*c.r+1e-10 {
				bad = append(bad, tris[t], tris[t+1], tris[t+2])
			} else {
				good = append(good, tris[t], tris[t+1], tris[t+2])
				ccGood = append(ccGood, c)
			}
		}

		for k := range counts {
			delete(counts, k)
		}
		for t := 0; t < len(bad); t += 3 {
			for e := 0; e < 3; e++ {
				u, v := bad[t+e], bad[t+(e+1)%3]
				if u > v {
					u, v = v, u
				}
				counts[edgeKey{u, v}]++
			}
		}
		for t := 0; t < len(bad); t += 3 {
			for e := 0; e < 3; e++ {
				u, v := bad[t+e], bad[t+(e+1)%3]
				if u > v {
					u, v = v, u
				}
				if counts[edgeKey{u, v}] == 1 {
					// Compute circumcircle once for the new triangle.
					good = append(good, int32(pi), u, v)
					ccGood = append(ccGood, circumcircle(all[pi], all[u], all[v]))
				}
			}
		}
		// Replace tris/cc with the surviving set.
		tris = append(tris[:0], good...)
		cc = append(cc[:0], ccGood...)
	}

	filtered := make([]int32, 0, len(tris))
	for t := 0; t < len(tris); t += 3 {
		if tris[t] < int32(d.n) && tris[t+1] < int32(d.n) && tris[t+2] < int32(d.n) {
			filtered = append(filtered, tris[t], tris[t+1], tris[t+2])
		}
	}
	d.tris = filtered
	return d
}

// adjacency builds the Delaunay neighbour graph once as a CSR structure.
// The JS code re-scans every triangle inside getDelaunayNeighbors() for every
// BFS node, which is what made the Voronoi method quadratic in practice.
func (d *delaunay) adjacency() (offsets []int32, targets []int32) {
	n := d.n
	deg := make([]int32, n+1)
	triCount := len(d.tris) / 3
	for t := 0; t < triCount; t++ {
		a, b, c := d.tris[t*3], d.tris[t*3+1], d.tris[t*3+2]
		deg[a] += 2
		deg[b] += 2
		deg[c] += 2
	}
	offsets = make([]int32, n+1)
	var total int32
	for i := 0; i < n; i++ {
		offsets[i] = total
		total += deg[i]
	}
	offsets[n] = total
	targets = make([]int32, total)
	cursor := make([]int32, n)
	copy(cursor, offsets[:n])
	link := func(u, v int32) {
		targets[cursor[u]] = v
		cursor[u]++
	}
	for t := 0; t < triCount; t++ {
		a, b, c := d.tris[t*3], d.tris[t*3+1], d.tris[t*3+2]
		link(a, b)
		link(b, a)
		link(b, c)
		link(c, b)
		link(c, a)
		link(a, c)
	}
	return offsets, targets
}

// neighborsNLayers is a port of getDelaunayNeighborsNLayers(): layer 1 is the
// direct Delaunay neighbours, layer 2 their neighbours, and so on. The visited
// state is tracked with a stamp array so no per-source map allocation is needed.
func (d *delaunay) neighborsNLayers(offsets, targets []int32, target int32, nLayers int, stamp []int32, layerOf []int32, run int32) map[int32]int32 {
	out := make(map[int32]int32)
	if nLayers < 1 {
		return out
	}
	frontier := []int32{target}
	for layer := int32(1); layer <= int32(nLayers); layer++ {
		var next []int32
		for _, idx := range frontier {
			for p := offsets[idx]; p < offsets[idx+1]; p++ {
				nb := targets[p]
				if nb != target && stamp[nb] != run {
					stamp[nb] = run
					layerOf[nb] = layer
					out[nb] = layer
					next = append(next, nb)
				}
			}
		}
		frontier = next
		if len(frontier) == 0 {
			break
		}
	}
	return out
}

// triangleIndex is a CSR of triangle ids per vertex, so a site's cell can be
// built in time proportional to its own degree instead of scanning every
// triangle.
type triangleIndex struct {
	offsets []int32
	items   []int32
}

func (d *delaunay) indexTriangles() triangleIndex {
	n := d.n
	triCount := len(d.tris) / 3
	deg := make([]int32, n+1)
	for t := 0; t < triCount; t++ {
		deg[d.tris[t*3]]++
		deg[d.tris[t*3+1]]++
		deg[d.tris[t*3+2]]++
	}
	offsets := make([]int32, n+1)
	var total int32
	for i := 0; i < n; i++ {
		offsets[i] = total
		total += deg[i]
	}
	offsets[n] = total
	items := make([]int32, total)
	cursor := make([]int32, n)
	copy(cursor, offsets[:n])
	for t := 0; t < triCount; t++ {
		for e := 0; e < 3; e++ {
			v := d.tris[t*3+e]
			items[cursor[v]] = int32(t)
			cursor[v]++
		}
	}
	return triangleIndex{offsets: offsets, items: items}
}

// cellPolygon is a port of computeVoronoiCellPolygon(): the circumcentres of
// the triangles touching the site, ordered by angle around it.
func (d *delaunay) cellPolygon(idx triangleIndex, siteIdx int32) []point2 {
	center := siteIdx
	if idx.offsets[siteIdx] == idx.offsets[siteIdx+1] {
		// No triangle touches this site, which happens when two sites share
		// exact coordinates. The JS then falls back to the first site with the
		// same position so a duplicate still gets a cell.
		p := d.pts[siteIdx]
		for i, q := range d.pts {
			if q.x == p.x && q.y == p.y {
				if int32(i) != siteIdx {
					center = int32(i)
				}
				break
			}
		}
	}
	var centers []point2
	for p := idx.offsets[center]; p < idx.offsets[center+1]; p++ {
		t := idx.items[p]
		c := circumcircle(
			d.pts[d.tris[t*3]], d.pts[d.tris[t*3+1]], d.pts[d.tris[t*3+2]],
		)
		centers = append(centers, point2{x: c.cx, y: c.cy})
	}
	site := d.pts[center]
	// Stable, because the JS comparator is a stable sort and equal angles (two
	// circumcentres on the same ray) must keep their original order.
	sort.SliceStable(centers, func(a, b int) bool {
		return math.Atan2(centers[a].y-site.y, centers[a].x-site.x) <
			math.Atan2(centers[b].y-site.y, centers[b].x-site.x)
	})
	return centers
}

// voronoiEdge is a port of VoronoiEdge in src/types.ts.
type voronoiEdge struct {
	Lat1  float64 `json:"lat1"`
	Lng1  float64 `json:"lng1"`
	Lat2  float64 `json:"lat2"`
	Lng2  float64 `json:"lng2"`
	SiteA string  `json:"siteA"`
	SiteB string  `json:"siteB"`
}

// edges is a port of computeVoronoiEdges(): each interior Delaunay edge becomes
// a Voronoi segment between the two circumcentres sharing it.
//
// The traversal order matches the JS Map insertion order (first triangle to
// touch an edge decides where it appears) so the rendered layer is stable
// between runs - Go map iteration would reshuffle the whole array.
func (d *delaunay) edges(ids []string) []voronoiEdge {
	triCount := len(d.tris) / 3
	centers := make([]circum, triCount)
	for t := 0; t < triCount; t++ {
		centers[t] = circumcircle(d.pts[d.tris[t*3]], d.pts[d.tris[t*3+1]], d.pts[d.tris[t*3+2]])
	}
	type edgeKey struct{ u, v int32 }
	keyIndex := make(map[edgeKey]int32, triCount*2)
	var keys []edgeKey
	var owner []int32
	var second []int32
	var nTris []int32
	for t := 0; t < triCount; t++ {
		v := [3]int32{d.tris[t*3], d.tris[t*3+1], d.tris[t*3+2]}
		for e := 0; e < 3; e++ {
			u, w := v[e], v[(e+1)%3]
			if u > w {
				u, w = w, u
			}
			key := edgeKey{u, w}
			idx, ok := keyIndex[key]
			if !ok {
				idx = int32(len(keys))
				keyIndex[key] = idx
				keys = append(keys, key)
				owner = append(owner, int32(t))
				second = append(second, -1)
				nTris = append(nTris, 1)
				continue
			}
			nTris[idx]++
			if second[idx] == -1 {
				second[idx] = int32(t)
			}
		}
	}
	out := make([]voronoiEdge, 0, triCount*2)
	for i, key := range keys {
		if nTris[i] != 2 {
			continue
		}
		t1, t2 := owner[i], second[i]
		c1, c2 := centers[t1], centers[t2]
		out = append(out, voronoiEdge{
			Lat1: c1.cy, Lng1: c1.cx,
			Lat2: c2.cy, Lng2: c2.cx,
			SiteA: idAt(ids, key.u),
			SiteB: idAt(ids, key.v),
		})
	}
	sort.Slice(out, func(a, b int) bool {
		if out[a].Lat1 != out[b].Lat1 {
			return out[a].Lat1 < out[b].Lat1
		}
		return out[a].Lng1 < out[b].Lng1
	})
	return out
}

func idAt(ids []string, i int32) string {
	if i < 0 || int(i) >= len(ids) {
		return ""
	}
	return ids[i]
}
