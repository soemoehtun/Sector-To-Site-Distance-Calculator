package main

import (
	"math"
	"sort"
)

// earthRadiusKm mirrors the JS reference (R = 6371).
const earthRadiusKm = 6371.0

// unitMultiplier mirrors getUnitMultiplier() in src/lib/distance.ts.
func unitMultiplier(unit string) float64 {
	switch unit {
	case "m":
		return 1000
	case "ft":
		return 3280.84
	case "mi":
		return 0.621371
	default:
		return 1
	}
}

// pointSet holds a coordinate list plus the trig values that would otherwise be
// recomputed once per candidate pair in the brute-force loop.
type pointSet struct {
	lat  []float64
	lon  []float64
	latR []float64 // lat in radians
	cosL []float64 // cos(lat) in radians
}

func newPointSet(lat, lon []float64) *pointSet {
	ps := &pointSet{
		lat:  lat,
		lon:  lon,
		latR: make([]float64, len(lat)),
		cosL: make([]float64, len(lat)),
	}
	for i := range lat {
		r := lat[i] * math.Pi / 180
		ps.latR[i] = r
		ps.cosL[i] = math.Cos(r)
	}
	return ps
}

// distKm is the haversine formula from src/lib/distance.ts with the per-point
// cos() hoisted out of the inner loop. The operation order matches the JS so the
// results agree to the last ULP that the two libm implementations agree on.
func (ps *pointSet) distKm(i, j int) float64 {
	return distXKm(ps, i, ps, j)
}

// distXKm is the haversine distance between point i of one set and point j of
// another, which is the normal case in two-file mode: the source and the target
// list are different sites with different coordinates. cos() is still taken
// from the precomputed per-point tables.
func distXKm(src *pointSet, i int, tgt *pointSet, j int) float64 {
	// The degree difference is taken first (as the JS does) and converted
	// afterwards: converting each point first rounds differently in the last
	// ULP, which would show up in exported numbers.
	dLat := (tgt.lat[j] - src.lat[i]) * math.Pi / 180
	dLon := (tgt.lon[j] - src.lon[i]) * math.Pi / 180
	sLat := math.Sin(dLat / 2)
	sLon := math.Sin(dLon / 2)
	a := sLat*sLat + src.cosL[i]*tgt.cosL[j]*sLon*sLon
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return earthRadiusKm * c
}

func haversineKm(lat1, lon1, lat2, lon2 float64) float64 {
	dLat := (lat2 - lat1) * math.Pi / 180
	dLon := (lon2 - lon1) * math.Pi / 180
	sLat := math.Sin(dLat / 2)
	sLon := math.Sin(dLon / 2)
	a := sLat*sLat + math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*sLon*sLon
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return earthRadiusKm * c
}

// bearingDeg is the initial great-circle bearing from (lat1,lon1) to
// (lat2,lon2), in degrees clockwise from north in [0,360). It mirrors
// bearingToSite() in src/lib/distance.ts.
func bearingDeg(lat1, lon1, lat2, lon2 float64) float64 {
	dLon := (lon2 - lon1) * math.Pi / 180
	la1 := lat1 * math.Pi / 180
	la2 := lat2 * math.Pi / 180
	y := math.Sin(dLon) * math.Cos(la2)
	x := math.Cos(la1)*math.Sin(la2) - math.Sin(la1)*math.Cos(la2)*math.Cos(dLon)
	deg := math.Atan2(y, x) * 180 / math.Pi
	if deg < 0 {
		deg += 360
	}
	return deg
}

// angleDiff is the smallest angular difference between two headings, in [0,180].
// It mirrors angleDiff() in src/lib/distance.ts.
func angleDiff(a, b float64) float64 {
	d := math.Mod(math.Abs(a-b), 360)
	if d > 180 {
		d = 360 - d
	}
	return d
}

// neighbor mirrors NeighborResult in src/types.ts.
type neighbor struct {
	Idx   int32
	Dist  float64
	Layer int32
}

// distFilter mirrors the excludeZero / maxDistance / distanceOp behaviour of
// the JS implementation, including the exact "=" comparison.
type distFilter struct {
	excludeZero bool
	hasMax      bool
	max         float64
	op          string
}

func (f distFilter) keep(d float64) bool {
	if f.excludeZero && !(d > 1e-6) {
		return false
	}
	if !f.hasMax || math.IsNaN(f.max) {
		return true
	}
	switch f.op {
	case "<":
		return d < f.max
	case "<=":
		return d <= f.max
	case ">":
		return d > f.max
	case ">=":
		return d >= f.max
	case "=":
		return d == f.max
	}
	return true
}

// knnResult is a per-source neighbour list.
type knnResult struct {
	idx   []int32
	dist  []float64
	layer []int32
	off   []int32 // length sourceCount+1, offsets into idx/dist/layer
}

func (k *knnResult) src(i int) []neighbor {
	start, end := k.off[i], k.off[i+1]
	out := make([]neighbor, 0, end-start)
	for j := start; j < end; j++ {
		out = append(out, neighbor{Idx: k.idx[j], Dist: k.dist[j], Layer: k.layer[j]})
	}
	return out
}

// ------------------------------------------------------------------- grid
//
// A uniform lat/lon grid over the target set, searched a ring at a time. Once
// the closest point reachable in the next ring is further than the k-th best
// found so far, no wider ring can displace it and the search stops. That makes
// the search exact while touching a small fraction of the targets.
//
// The previous implementation swept outward in latitude rank only. |Δlat| is the
// only thing such a sweep can prune on, so a source sitting in a dense latitude
// band still had to measure every point in it, however far away in longitude
// those points were. Pruning in both dimensions is worth 6x to 40x on real site
// data.

type gridIndex struct {
	cell           float64 // cell size in degrees
	minLat, minLon float64
	cut            float64 // longitudes below this are indexed as lon+360
	latN, lonN     int
	off            []int32 // CSR offsets into idx, len(latN*lonN)+1
	idx            []int32 // target indices grouped by cell

	// Data covering more than half the globe in longitude has no single
	// contiguous linearisation, so the grid is skipped for it and the search
	// falls back to sweeping latitude. Global datasets are rare here and the
	// fallback is exact, just slower.
	usable bool

	// Latitude order, used only by that fallback.
	order     []int
	sortedLat []float64
}

// cutLon returns where to start indexing longitude from.
//
// A grid over raw longitudes is wrong at the antimeridian: two sites either side
// of it are a few kilometres apart in the world but land in cells at opposite
// ends of a row, so a search prunes them both away. Rotating the longitude axis
// to start at its own widest gap removes the seam.
func cutLon(lon []float64) float64 {
	sorted := append([]float64(nil), lon...)
	sort.Float64s(sorted)
	// Gap from the last longitude back round to the first. Cutting there means
	// starting at the first, which leaves that gap as the empty stretch.
	bestGap := sorted[0] + 360 - sorted[len(sorted)-1]
	cut := sorted[0]
	for i := 1; i < len(sorted); i++ {
		if gap := sorted[i] - sorted[i-1]; gap > bestGap {
			bestGap, cut = gap, sorted[i]
		}
	}
	return cut
}

// buildGrid indexes the targets so that each cell holds about one point.
// Sizing the cell from the bounding-box area keeps the cell count near the point
// count whatever shape the data has, and gives each axis its own dimension, so a
// tall thin region does not waste a square's worth of cells.
func buildGrid(lat, lon []float64) *gridIndex {
	g := &gridIndex{}
	if len(lat) == 0 {
		return g
	}
	g.cut = cutLon(lon)
	rot := g.rot

	minLat, maxLat := lat[0], lat[0]
	minLon, maxLon := rot(lon[0]), rot(lon[0])
	for i := range lat {
		if lat[i] < minLat {
			minLat = lat[i]
		} else if lat[i] > maxLat {
			maxLat = lat[i]
		}
		if v := rot(lon[i]); v < minLon {
			minLon = v
		} else if v > maxLon {
			maxLon = v
		}
	}
	if maxLon-minLon > 180 {
		// No rotation makes this contiguous; sweep latitudes instead.
		g.order = make([]int, len(lat))
		for i := range g.order {
			g.order[i] = i
		}
		sort.SliceStable(g.order, func(a, b int) bool { return lat[g.order[a]] < lat[g.order[b]] })
		g.sortedLat = make([]float64, len(g.order))
		for r, idx := range g.order {
			g.sortedLat[r] = lat[idx]
		}
		return g
	}
	g.usable = true

	// sqrt(area / n) gives roughly n cells of roughly one point each. Guard the
	// zero-area case, which is what a file of identical coordinates produces.
	cell := math.Sqrt((maxLat - minLat) * (maxLon - minLon) / float64(len(lat)))
	if !(cell > 0) {
		cell = 1e-9
	}
	g.cell = cell
	g.minLat = minLat
	g.minLon = minLon
	g.latN = int((maxLat-minLat)/cell) + 1
	g.lonN = int((maxLon-minLon)/cell) + 1
	if g.latN < 1 {
		g.latN = 1
	}
	if g.lonN < 1 {
		g.lonN = 1
	}
	// A one-cell-per-point grid can still come out enormous for a file whose
	// coordinates are spread thinner than float noise. Coarsen until it fits.
	for g.latN > 1<<20 || g.lonN > 1<<20 || int64(g.latN)*int64(g.lonN) > 8*int64(len(lat))+1024 {
		cell *= 2
		g.cell = cell
		g.latN = int((maxLat-minLat)/cell) + 1
		g.lonN = int((maxLon-minLon)/cell) + 1
		if g.latN < 1 {
			g.latN = 1
		}
		if g.lonN < 1 {
			g.lonN = 1
		}
	}

	total := g.latN * g.lonN
	counts := make([]int32, total)
	for i := range lat {
		counts[g.px(lat[i], rot(lon[i]))]++
	}
	g.off = make([]int32, total+1)
	for c, n := range counts {
		g.off[c+1] = g.off[c] + n
	}
	// One slot per point, not per cell: several points share a cell whenever the
	// file repeats coordinates, which is common.
	g.idx = make([]int32, g.off[total])
	fill := append([]int32(nil), g.off[:total]...)
	for i := range lat {
		p := g.px(lat[i], rot(lon[i]))
		g.idx[fill[p]] = int32(i)
		fill[p]++
	}
	return g
}

// rot maps a longitude into [0,360) relative to the cut.
func (g *gridIndex) rot(lon float64) float64 {
	v := lon - g.cut
	if v < 0 {
		v += 360
	}
	return v
}

// px is the flat cell index for a point, with longitude already rotated.
func (g *gridIndex) px(lat, rotLon float64) int {
	ci := int((lat - g.minLat) / g.cell)
	cj := int((rotLon - g.minLon) / g.cell)
	if ci < 0 {
		ci = 0
	} else if ci >= g.latN {
		ci = g.latN - 1
	}
	if cj < 0 {
		cj = 0
	} else if cj >= g.lonN {
		cj = g.lonN - 1
	}
	return ci*g.lonN + cj
}

func (g *gridIndex) cellOf(lat, lon float64) (int, int) {
	lon = g.rot(lon)
	ci := int((lat - g.minLat) / g.cell)
	cj := int((lon - g.minLon) / g.cell)
	if ci < 0 {
		ci = 0
	} else if ci >= g.latN {
		ci = g.latN - 1
	}
	if cj < 0 {
		cj = 0
	} else if cj >= g.lonN {
		cj = g.lonN - 1
	}
	return ci, cj
}

// ringBoundKm is a lower bound on the distance from the query to any target in
// ring `ring`, the cells at Chebyshev cell-distance exactly `ring` from (ci,cj).
//
// A ring is the rows ci±ring and the columns cj±ring that fall inside the grid.
// Row ci+ring begins (ring - fLat) cells above the query and row ci-ring ends
// (ring - 1 + fLat) cells below it, where fLat is the query's fractional
// position within its own cell; the columns work the same way. Converting the
// smallest of those gaps with the same haversine the results use gives a strict
// lower bound on the distance to anything in the ring, which is what makes the
// early exit safe.
func (g *gridIndex) ringBoundKm(ci, cj, ring int, lat0, lon0 float64) float64 {
	if ring < 1 {
		return 0
	}
	r := float64(ring)
	fLat := (lat0-g.minLat)/g.cell - float64(ci)
	fLon := (lon0-g.minLon)/g.cell - float64(cj)

	best := math.Inf(1)
	if ci-ring >= 0 {
		if v := haversineKm(lat0, lon0, lat0-(r-1+fLat)*g.cell, lon0); v < best {
			best = v
		}
	}
	if ci+ring < g.latN {
		if v := haversineKm(lat0, lon0, lat0+(r-fLat)*g.cell, lon0); v < best {
			best = v
		}
	}
	if cj-ring >= 0 {
		if v := haversineKm(lat0, lon0, lat0, lon0-(r-1+fLon)*g.cell); v < best {
			best = v
		}
	}
	if cj+ring < g.lonN {
		if v := haversineKm(lat0, lon0, lat0, lon0+(r-fLon)*g.cell); v < best {
			best = v
		}
	}
	if math.IsInf(best, 1) {
		return 0 // the ring falls entirely outside the grid
	}
	return best
}

// bruteKNN computes the k nearest targets for every source in [start,end).
//
// The grid, the per-target id groups and the per-source group all depend only
// on the session's point sets, never on the range, so they are built once in
// setup and passed in. Rebuilding them per call made every calc range cost
// O(len(targets)) before it did any real work, which showed up as a large fixed
// cost whenever the caller used small ranges.
func bruteKNN(
	tgt *pointSet,
	g *gridIndex,
	tgtGroup []int32, // per target, indexed by target index; nil unless selfExclude
	srcGroup []int32, // per source, indexed by source index; nil unless selfExclude
	src *pointSet,
	start, end int,
	k int,
	mult float64,
	selfExclude bool,
	filter distFilter,
	azimuth []float64, // per-source sector azimuth; nil or NaN disables the beam filter
	beamwidths []float64, // per-source beamwidth; nil or NaN falls back to defaultBeamWidth
	defaultBeamWidth float64, // sector beam width in degrees
	onProgress func(done, total int),
) *knnResult {
	res := &knnResult{
		off:   make([]int32, end-start+1),
		idx:   make([]int32, 0, (end-start)*k),
		dist:  make([]float64, 0, (end-start)*k),
		layer: make([]int32, 0, (end-start)*k),
	}

	// The JS keeps every target whose id differs from the *current source's* id,
	// so duplicate ids are removed pairwise rather than globally. Each distinct
	// id gets a small integer, which turns the per-candidate test into a single
	// int comparison instead of a map lookup.

	best := make([]neighbor, 0, k)
	for cur := int32(start); int(cur) < end; cur++ {
		res.off[int(cur)-start] = int32(len(res.idx))
		best = best[:0]
		if k < 1 {
			continue
		}

		curBw := defaultBeamWidth
		if len(beamwidths) > int(cur) && !math.IsNaN(beamwidths[cur]) && beamwidths[cur] > 0 && beamwidths[cur] <= 360 {
			curBw = beamwidths[cur]
		}
		beamActive := curBw > 0 && curBw < 360 && len(azimuth) > int(cur) && !math.IsNaN(azimuth[cur])
		halfBeam := curBw / 2
		az := math.NaN()
		if beamActive {
			az = azimuth[cur]
		}

		scan := func(cur, j int32) {
			if beamActive {
				if angleDiff(bearingDeg(src.lat[cur], src.lon[cur], tgt.lat[j], tgt.lon[j]), az) > halfBeam {
					return
				}
			}
			consider(&best, k, int(j), distXKm(src, int(cur), tgt, int(j))*mult, filter,
				selfExclude && tgtGroup[j] == srcGroup[cur])
		}

		lat0 := src.lat[cur]
		lon0 := src.lon[cur]
		// Longitude is only rotated for the index and the bound; the reported
		// distances use the caller's own value, which is unaffected because a
		// whole 360 added to both ends cancels.
		gridLon0 := g.rot(lon0)

		if g.usable {
			ci, cj := g.cellOf(lat0, lon0)
			maxRing := ci
			if v := g.latN - 1 - ci; v > maxRing {
				maxRing = v
			}
			if cj > maxRing {
				maxRing = cj
			}
			if v := g.lonN - 1 - cj; v > maxRing {
				maxRing = v
			}
			for ring := 0; ring <= maxRing; ring++ {
				if len(best) == k && ring > 0 &&
					g.ringBoundKm(ci, cj, ring, lat0, gridLon0)*mult > best[k-1].Dist {
					break
				}

				loI, hiI := ci-ring, ci+ring
				loJ, hiJ := cj-ring, cj+ring
				if loI < 0 {
					loI = 0
				}
				if hiI >= g.latN {
					hiI = g.latN - 1
				}
				if loJ < 0 {
					loJ = 0
				}
				if hiJ >= g.lonN {
					hiJ = g.lonN - 1
				}

				if ring == 0 {
					p := ci*g.lonN + cj
					for _, j := range g.idx[g.off[p]:g.off[p+1]] {
						scan(cur, j)
					}
					continue
				}
				// Only the ring itself is new; the interior was reached as
				// smaller rings.
				for b := loJ; b <= hiJ; b++ {
					p := (ci-ring)*g.lonN + b
					if ci-ring >= 0 {
						for _, j := range g.idx[g.off[p]:g.off[p+1]] {
							scan(cur, j)
						}
					}
					p = (ci+ring)*g.lonN + b
					if ci+ring < g.latN {
						for _, j := range g.idx[g.off[p]:g.off[p+1]] {
							scan(cur, j)
						}
					}
				}
				for a := ci - ring + 1; a <= ci+ring-1; a++ {
					if a < 0 || a >= g.latN {
						continue
					}
					if cj-ring >= 0 {
						p := a*g.lonN + cj - ring
						for _, j := range g.idx[g.off[p]:g.off[p+1]] {
							scan(cur, j)
						}
					}
					if cj+ring < g.lonN {
						p := a*g.lonN + cj + ring
						for _, j := range g.idx[g.off[p]:g.off[p+1]] {
							scan(cur, j)
						}
					}
				}
			}
		} else {
			// Latitude sweep, for data covering more than half the globe in
			// longitude where no rotation is contiguous.
			pos := sort.SearchFloat64s(g.sortedLat, lat0)
			upDead, downDead := false, false
			for d := 0; !(upDead && downDead); d++ {
				if !downDead {
					if r := pos - 1 - d; r < 0 {
						downDead = true
					} else {
						j := g.order[r]
						// |Δlat| in km lower-bounds the great-circle distance,
						// so once it exceeds the k-th best this side is done.
						if len(best) == k && lowerBoundKm(g.sortedLat[r], lat0)*mult > best[k-1].Dist {
							downDead = true
						} else {
							scan(cur, int32(j))
						}
					}
				}
				if !upDead {
					if r := pos + d; r >= len(g.order) {
						upDead = true
					} else {
						j := g.order[r]
						if len(best) == k && lowerBoundKm(g.sortedLat[r], lat0)*mult > best[k-1].Dist {
							upDead = true
						} else {
							scan(cur, int32(j))
						}
					}
				}
			}
		}

		for _, nb := range best {
			res.idx = append(res.idx, nb.Idx)
			res.dist = append(res.dist, nb.Dist)
			res.layer = append(res.layer, 0)
		}
		if onProgress != nil {
			onProgress(int(cur)-start+1, end-start)
		}
	}
	res.off[end-start] = int32(len(res.idx))
	return res
}

func lowerBoundKm(latA, latB float64) float64 {
	d := latA - latB
	if d < 0 {
		d = -d
	}
	return earthRadiusKm * d * math.Pi / 180
}

func consider(best *[]neighbor, k, idx int, dist float64, filter distFilter, skip bool) {
	if skip || !filter.keep(dist) {
		return
	}
	b := *best
	at := sort.Search(len(b), func(p int) bool {
		return b[p].Dist > dist || (b[p].Dist == dist && int32(idx) < b[p].Idx)
	})
	if at < k {
		b = append(b, neighbor{})
		copy(b[at+1:], b[at:])
		b[at] = neighbor{Idx: int32(idx), Dist: dist}
		if len(b) > k {
			b = b[:k]
		}
		*best = b
	}
}
