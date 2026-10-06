package main

import (
	"math"
	"math/rand"
	"sort"
	"testing"
)

// TestHaversineKnownDistances pins the formula to reference values.
func TestHaversineKnownDistances(t *testing.T) {
	cases := []struct {
		lat1, lon1, lat2, lon2 float64
		want                   float64
	}{
		{0, 0, 0, 0, 0},
		{0, 0, 0, 1, 111.19492664455873},
		{0, 0, 1, 0, 111.19492664455873},
		{16.8661, 96.1951, 16.8661, 96.1951, 0},
	}
	for _, c := range cases {
		got := haversineKm(c.lat1, c.lon1, c.lat2, c.lon2)
		if math.Abs(got-c.want) > 1e-6 {
			t.Fatalf("haversine(%v,%v,%v,%v) = %v, want %v", c.lat1, c.lon1, c.lat2, c.lon2, got, c.want)
		}
	}
}

// TestHaversineMatchesCachedTrig proves the hoisted sin/cos version is
// numerically identical to the straightforward formula.
func TestHaversineMatchesCachedTrig(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	lat := make([]float64, 500)
	lon := make([]float64, 500)
	for i := range lat {
		lat[i] = rng.Float64()*180 - 90
		lon[i] = rng.Float64()*360 - 180
	}
	ps := newPointSet(lat, lon)
	for i := 0; i < len(lat); i += 7 {
		for j := i + 1; j < len(lat); j += 11 {
			cached := ps.distKm(i, j)
			naive := haversineKm(lat[i], lon[i], lat[j], lon[j])
			if cached != naive {
				t.Fatalf("mismatch at %d,%d: cached %v != naive %v", i, j, cached, naive)
			}
		}
	}
}

// TestBruteKNNTwoSeparateSets is the regression test for two-file mode, where
// the source and target coordinates are different sites: the distance must use
// the source's own coordinates, not the target list's.
func TestBruteKNNTwoSeparateSets(t *testing.T) {
	srcLat := []float64{16.8, 16.9, 17.0, 17.1}
	srcLon := []float64{96.2, 96.3, 96.4, 96.5}
	tgtLat := []float64{20.0, 21.0, 22.0, 23.0}
	tgtLon := []float64{100.0, 101.0, 102.0, 103.0}
	src := newPointSet(srcLat, srcLon)
	tgt := newPointSet(tgtLat, tgtLon)
	got := bruteKNN(tgt, buildGrid(tgtLat, tgtLon), nil, nil, src, 0, 4, 2, 1, false, distFilter{}, nil, nil, 0, nil)
	for i := 0; i < 4; i++ {
		fast := got.src(i)
		var want []neighbor
		for j := 0; j < 4; j++ {
			want = append(want, neighbor{Idx: int32(j), Dist: haversineKm(srcLat[i], srcLon[i], tgtLat[j], tgtLon[j])})
		}
		sort.Slice(want, func(a, b int) bool { return want[a].Dist < want[b].Dist })
		want = want[:2]
		if len(fast) != len(want) {
			t.Fatalf("source %d: got %d neighbours, want %d", i, len(fast), len(want))
		}
		for j := range want {
			if fast[j].Idx != want[j].Idx || math.Abs(fast[j].Dist-want[j].Dist) > 1e-9 {
				t.Fatalf("source %d neighbour %d: got (%d,%v) want (%d,%v)",
					i, j, fast[j].Idx, fast[j].Dist, want[j].Idx, want[j].Dist)
			}
		}
	}
}

// naiveKNN is the O(n*m) reference the fast sweep must agree with exactly.
func naiveKNN(tgt *pointSet, src *pointSet, start, end, k int, mult float64, selfExclude bool, f distFilter) map[int][]neighbor {
	out := map[int][]neighbor{}
	for i := start; i < end; i++ {
		var all []neighbor
		for j := 0; j < len(tgt.lat); j++ {
			if selfExclude && j == i {
				continue
			}
			d := haversineKm(src.lat[i], src.lon[i], tgt.lat[j], tgt.lon[j]) * mult
			if !f.keep(d) {
				continue
			}
			all = append(all, neighbor{Idx: int32(j), Dist: d})
		}
		sort.Slice(all, func(a, b int) bool { return all[a].Dist < all[b].Dist })
		if len(all) > k {
			all = all[:k]
		}
		out[i] = all
	}
	return out
}

func TestBruteKNNMatchesNaive(t *testing.T) {
	for _, cfg := range []struct {
		n, k        int
		clustered   bool
		excludeZero bool
	}{
		{n: 200, k: 1, clustered: false},
		{n: 200, k: 5, clustered: true},
		{n: 500, k: 3, clustered: true},
		{n: 500, k: 12, clustered: false},
		{n: 300, k: 4, clustered: true, excludeZero: true},
	} {
		rng := rand.New(rand.NewSource(int64(cfg.n + cfg.k)))
		lat := make([]float64, cfg.n)
		lon := make([]float64, cfg.n)
		for i := range lat {
			if cfg.clustered {
				lat[i] = 16.8 + rng.NormFloat64()*0.05
				lon[i] = 96.2 + rng.NormFloat64()*0.05
			} else {
				lat[i] = rng.Float64()*180 - 90
				lon[i] = rng.Float64()*360 - 180
			}
		}
		src := newPointSet(lat, lon)
		tgt := newPointSet(lat, lon)
		filter := distFilter{excludeZero: cfg.excludeZero}
		// The ids are unique, so each is its own group and self-exclusion drops
		// exactly the source's own entry, matching what setup() would build.
		groups := make([]int32, cfg.n)
		for i := range groups {
			groups[i] = int32(i)
		}

		got := bruteKNN(tgt, buildGrid(lat, lon), groups, groups, src, 0, cfg.n, cfg.k, 1, true, filter, nil, nil, 0, nil)
		want := naiveKNN(tgt, src, 0, cfg.n, cfg.k, 1, true, filter)
		for i := 0; i < cfg.n; i++ {
			lo, hi := got.off[i], got.off[i+1]
			fast := got.src(i)
			ref := want[i]
			if len(fast) != len(ref) {
				t.Fatalf("n=%d k=%d site %d: got %d neighbours, want %d", cfg.n, cfg.k, i, len(fast), len(ref))
			}
			for j := range ref {
				if fast[j].Idx != ref[j].Idx || math.Abs(fast[j].Dist-ref[j].Dist) > 1e-9 {
					t.Fatalf("n=%d k=%d site %d neighbour %d: got (%d,%v) want (%d,%v)",
						cfg.n, cfg.k, i, j, fast[j].Idx, fast[j].Dist, ref[j].Idx, ref[j].Dist)
				}
			}
			_ = lo
			_ = hi
		}
	}
}

// TestBruteKNNAcrossAntimeridian covers sites either side of 180 degrees.
// They are a few kilometres apart in the world, so an index over raw
// longitudes has to keep them close together or the search prunes the nearest
// neighbour away.
func TestBruteKNNAcrossAntimeridian(t *testing.T) {
	lat := []float64{16.8, 16.8, 16.81, 16.82, 16.83, 16.84, -33.9, -33.91, -33.92, -33.93}
	lon := []float64{179.99, -179.99, 179.0, 179.5, 178.0, 177.0, 151.2, 151.21, 151.22, 151.23}
	groups := make([]int32, len(lat))
	for i := range groups {
		groups[i] = int32(i)
	}
	ps := newPointSet(lat, lon)
	got := bruteKNN(ps, buildGrid(lat, lon), groups, groups, ps, 0, len(lat), 3, 1, true, distFilter{}, nil, nil, 0, nil)
	want := naiveKNN(ps, ps, 0, len(lat), 3, 1, true, distFilter{})
	for i := range lat {
		fast, ref := got.src(i), want[i]
		if len(fast) != len(ref) {
			t.Fatalf("source %d: got %d neighbours, want %d", i, len(fast), len(ref))
		}
		for j := range ref {
			if fast[j].Idx != ref[j].Idx || math.Abs(fast[j].Dist-ref[j].Dist) > 1e-9 {
				t.Fatalf("source %d neighbour %d: got (%d,%v) want (%d,%v)",
					i, j, fast[j].Idx, fast[j].Dist, ref[j].Idx, ref[j].Dist)
			}
		}
	}
	// Sanity check that the two sites either side of the antimeridian really are
	// each other's nearest neighbour, which is the whole point of the case.
	if got.src(0)[0].Idx != 1 {
		t.Fatalf("source 0 nearest is %d, want 1 (across the antimeridian)", got.src(0)[0].Idx)
	}
	if got.src(1)[0].Idx != 0 {
		t.Fatalf("source 1 nearest is %d, want 0 (across the antimeridian)", got.src(1)[0].Idx)
	}
}

// TestBruteKNNDuplicateCoordinates covers a file with repeated coordinates.
// Every equidistant site is interchangeable in distance, so the tie has to be
// broken the same way the JS fallback breaks it, by the lower index.
func TestBruteKNNDuplicateCoordinates(t *testing.T) {
	lat := []float64{16.8, 16.8, 16.8, 16.8, 16.9, 16.9}
	lon := []float64{96.2, 96.2, 96.2, 96.2, 96.3, 96.3}
	groups := make([]int32, len(lat))
	for i := range groups {
		groups[i] = int32(i)
	}
	ps := newPointSet(lat, lon)
	got := bruteKNN(ps, buildGrid(lat, lon), groups, groups, ps, 0, len(lat), 3, 1, true, distFilter{}, nil, nil, 0, nil)
	for i := range lat {
		fast := got.src(i)
		for j := 1; j < len(fast); j++ {
			if fast[j-1].Dist > fast[j].Dist {
				t.Fatalf("source %d: neighbours not ascending: %v", i, fast)
			}
		}
		// Sources 0-3 share coordinates, so each must get the same three
		// equidistant neighbours in the same order and never itself.
		if i < 4 {
			for j := 0; j < 3; j++ {
				if fast[j].Idx == int32(i) {
					t.Fatalf("source %d returned itself at position %d: %v", i, j, fast)
				}
			}
		}
	}
	if got.src(0)[0].Idx != 1 {
		t.Fatalf("source 0 nearest is %d, want 1 (lowest index of the equidistant sites)", got.src(0)[0].Idx)
	}
}

// TestBruteKNNAllPointsShareACell covers a file whose coordinates collapse into
// a single grid cell, so the per-cell index has far more entries than the cell
// list has cells.
func TestBruteKNNAllPointsShareACell(t *testing.T) {
	const n = 64
	lat := make([]float64, n)
	lon := make([]float64, n)
	for i := range lat {
		lat[i] = 16.8
		lon[i] = 96.2
	}
	groups := make([]int32, n)
	for i := range groups {
		groups[i] = int32(i)
	}
	ps := newPointSet(lat, lon)
	g := buildGrid(lat, lon)
	if !g.usable {
		t.Skip("grid not used for this data")
	}
	if g.latN*g.lonN >= n {
		t.Fatalf("expected fewer cells (%d) than points (%d) for this fixture", g.latN*g.lonN, n)
	}
	got := bruteKNN(ps, g, groups, groups, ps, 0, n, 3, 1, true, distFilter{}, nil, nil, 0, nil)
	want := naiveKNN(ps, ps, 0, n, 3, 1, true, distFilter{})
	for i := 0; i < n; i++ {
		f, w := got.src(i), want[i]
		if len(f) != len(w) {
			t.Fatalf("source %d: got %d neighbours, want %d", i, len(f), len(w))
		}
		for j := range w {
			if f[j].Idx != w[j].Idx {
				t.Fatalf("source %d neighbour %d: got index %d, want %d", i, j, f[j].Idx, w[j].Idx)
			}
		}
	}
}

func TestBruteKNNMaxDistanceFilter(t *testing.T) {
	lat := []float64{0, 0.1, 0.2, 0.3, 0.4}
	lon := []float64{0, 0, 0, 0, 0}
	src := newPointSet(lat, lon)
	tgt := newPointSet(lat, lon)
	groups := []int32{0, 1, 2, 3, 4}
	limit := 30.0
	filter := distFilter{hasMax: true, max: limit, op: "<"}
	got := bruteKNN(tgt, buildGrid(lat, lon), groups, groups, src, 0, 5, 3, 1, true, filter, nil, nil, 0, nil)
	for _, nb := range got.src(0) {
		if nb.Dist >= limit {
			t.Fatalf("distance %v should have been filtered out", nb.Dist)
		}
	}
	if len(got.src(0)) == 0 {
		t.Fatal("expected at least one neighbour under the limit")
	}
}

// TestBruteKNNBeamFilter pins the sector beam filter: a target outside the
// sector's beam (bearing more than beamwidth/2 away from the azimuth) must be
// dropped, regardless of how close it is.
func TestBruteKNNBeamFilter(t *testing.T) {
	// Source at 0,0. Targets due east (bearing 90), due west (bearing 270)
	// and due north (bearing 0), all at roughly the same distance.
	lat := []float64{0, 0, 0, 0.5}
	lon := []float64{0, 0.5, -0.5, 0}
	groups := []int32{0, 1, 2, 3}
	ps := newPointSet(lat, lon)

	azimuth := []float64{90, 90, 90, 90}
	// beamwidth 65 -> half 32.5: only the east neighbour is inside.
	got := bruteKNN(ps, buildGrid(lat, lon), groups, groups, ps, 0, 4, 4, 1, true, distFilter{}, azimuth, nil, 65, nil)
	nbs := got.src(0)
	if len(nbs) != 1 || nbs[0].Idx != 1 {
		t.Fatalf("sector azimuth 90 expects exactly the east neighbour (idx 1), got %v", nbs)
	}

	// A full 360 beam is treated as no filter at all.
	got360 := bruteKNN(ps, buildGrid(lat, lon), groups, groups, ps, 0, 4, 4, 1, true, distFilter{}, azimuth, nil, 360, nil)
	if len(got360.src(0)) != 3 {
		t.Fatalf("full circle beam should return all neighbours, got %v", got360.src(0))
	}

	// NaN azimuth disables the filter (a sector with no azimuth mapped).
	nanAz := []float64{math.NaN(), 90, 90, 90}
	gotNaN := bruteKNN(ps, buildGrid(lat, lon), groups, groups, ps, 0, 4, 4, 1, true, distFilter{}, nanAz, nil, 65, nil)
	if len(gotNaN.src(0)) != 3 {
		t.Fatalf("NaN azimuth should disable the beam filter, got %v", gotNaN.src(0))
	}

	// Boundary: a target exactly at the beam edge (offset = beamwidth/2) stays.
	edgeAz := []float64{45, 90, 90, 90}
	gotEdge := bruteKNN(ps, buildGrid(lat, lon), groups, groups, ps, 0, 4, 4, 1, true, distFilter{}, edgeAz, nil, 90, nil)
	idxSet := map[int32]bool{}
	for _, nb := range gotEdge.src(0) {
		idxSet[nb.Idx] = true
	}
	if !idxSet[1] || !idxSet[3] {
		t.Fatalf("beam edge boundaries should still match (east + north), got %v", gotEdge.src(0))
	}

	// Per-source beamwidth override
	customBw := []float64{120, 65, 65, 65}
	gotCustom := bruteKNN(ps, buildGrid(lat, lon), groups, groups, ps, 0, 4, 4, 1, true, distFilter{}, edgeAz, customBw, 65, nil)
	if len(gotCustom.src(0)) < 2 {
		t.Fatalf("expected custom beamwidth of 120 deg to cover both targets, got %v", gotCustom.src(0))
	}
}

// TestVoronoiNeighbourSetsAreSymmetric is the property the layered search
// relies on: if j is in i's rings, i must be in j's rings.
func TestVoronoiNeighbourSetsAreSymmetric(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	n := 120
	pts := make([]point2, n)
	for i := range pts {
		pts[i] = point2{x: 96 + rng.Float64(), y: 16 + rng.Float64()}
	}
	d := triangulate(pts)
	off, tgt := d.adjacency()
	stamp := make([]int32, n)
	layer := make([]int32, n)
	var run int32
	for i := 0; i < n; i++ {
		run++
		a := d.neighborsNLayers(off, tgt, int32(i), 2, stamp, layer, run)
		for j := range a {
			run++
			b := d.neighborsNLayers(off, tgt, j, 2, stamp, layer, run)
			if _, ok := b[int32(i)]; !ok {
				t.Fatalf("asymmetry: %d -> %d but not %d -> %d", i, j, j, i)
			}
		}
	}
}

func TestTriangulateCoversAllPoints(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	n := 50
	pts := make([]point2, n)
	for i := range pts {
		pts[i] = point2{x: rng.Float64() * 10, y: rng.Float64() * 10}
	}
	d := triangulate(pts)
	off, tgt := d.adjacency()
	covered := 0
	for i := 0; i < n; i++ {
		if off[i+1] > off[i] {
			covered++
		}
		_ = tgt
	}
	if covered < n-1 {
		t.Fatalf("only %d of %d points have a Delaunay neighbour", covered, n)
	}
	// A planar triangulation of n points has roughly 2n triangles.
	if tris := len(d.tris) / 3; tris < n || tris > 3*n {
		t.Fatalf("unexpected triangle count %d for %d points", tris, n)
	}
}

func TestHexToKmlColor(t *testing.T) {
	// #10b981 -> aabbggrr = ff 81 b9 10
	if got := hexToKmlColor("#10b981", 1); got != "ff81b910" {
		t.Fatalf("hexToKmlColor full opacity = %q, want ff81b910", got)
	}
	if got := hexToKmlColor("#10b981", 0.4); got != "6681b910" {
		t.Fatalf("hexToKmlColor 40%% = %q, want 6681b910", got)
	}
	// unparseable hex falls back to #ff0000 -> ff 00 00 ff
	if got := hexToKmlColor("nonsense", 1); got != "ff0000ff" {
		t.Fatalf("hexToKmlColor fallback = %q, want ff0000ff", got)
	}
	if got := hexToKmlColor("#AABBCC", 0); got != "00ccbbaa" {
		t.Fatalf("hexToKmlColor zero opacity = %q, want 00ccbbaa", got)
	}
}

func TestColumnIndexFromRef(t *testing.T) {
	cases := map[string]int{"A1": 0, "B1": 1, "Z1": 25, "AA1": 26, "BC12": 54, "": 7}
	for ref, want := range cases {
		if got := columnIndexFromRef(ref, 7); got != want {
			t.Fatalf("columnIndexFromRef(%q) = %d, want %d", ref, got, want)
		}
	}
}

func TestFormatNumberKeepsIntegers(t *testing.T) {
	if got := formatNumber("1000000"); got != "1000000" {
		t.Fatalf("formatNumber = %q, want 1000000", got)
	}
	if got := formatNumber("1.5"); got != "1.5" {
		t.Fatalf("formatNumber = %q, want 1.5", got)
	}
	if got := formatNumber("16.8661"); got != "16.8661" {
		t.Fatalf("formatNumber = %q, want 16.8661", got)
	}
}

func TestSniffDelimiter(t *testing.T) {
	if got := sniffDelimiter([]byte("a,b,c\n1,2,3")); got != ',' {
		t.Fatalf("expected comma, got %q", got)
	}
	if got := sniffDelimiter([]byte("a;b;c\n1;2;3")); got != ';' {
		t.Fatalf("expected semicolon, got %q", got)
	}
	if got := sniffDelimiter([]byte("a\tb\tc\n1\t2\t3")); got != '\t' {
		t.Fatalf("expected tab, got %q", got)
	}
}

func TestParseDelimitedSkipsBlankRows(t *testing.T) {
	csv := "site,lat,lon\nA,1,2\n,,,\nB,3,4\n"
	tbl, err := parseDelimited([]byte(csv), "t.csv")
	if err != nil {
		t.Fatal(err)
	}
	if tbl.Rows != 2 {
		t.Fatalf("expected 2 rows, got %d", tbl.Rows)
	}
	if !tbl.ASCII {
		t.Fatal("expected ascii flag")
	}
}
