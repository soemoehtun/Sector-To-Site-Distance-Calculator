package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"sort"
)

func errf(msg string) error { return errors.New(msg) }

// ---------------------------------------------------------------- base64 i/o
//
// Typed arrays cross the wasm boundary as base64 so the payload is a plain
// string: no SharedArrayBuffer, no cross-origin-isolation headers, and the
// engine still works from a file:// single-file build.

func f64ToB64(v []float64) string {
	if len(v) == 0 {
		return ""
	}
	buf := make([]byte, 8*len(v))
	for i, f := range v {
		binary.LittleEndian.PutUint64(buf[i*8:], math.Float64bits(f))
	}
	return base64.StdEncoding.EncodeToString(buf)
}

func i32ToB64(v []int32) string {
	if len(v) == 0 {
		return ""
	}
	buf := make([]byte, 4*len(v))
	for i, n := range v {
		binary.LittleEndian.PutUint32(buf[i*4:], uint32(n))
	}
	return base64.StdEncoding.EncodeToString(buf)
}

func b64ToF64(s string) ([]float64, error) {
	if s == "" {
		return nil, nil
	}
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	out := make([]float64, len(raw)/8)
	for i := range out {
		out[i] = math.Float64frombits(binary.LittleEndian.Uint64(raw[i*8:]))
	}
	return out, nil
}

func b64ToI32(s string) ([]int32, error) {
	if s == "" {
		return nil, nil
	}
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	out := make([]int32, len(raw)/4)
	for i := range out {
		out[i] = int32(binary.LittleEndian.Uint32(raw[i*4:]))
	}
	return out, nil
}

// -------------------------------------------------------------------- params

type params struct {
	nNeighbors int
	voronoiLay int
	mult       float64
	filter     distFilter
	method     string
	hasTarget  bool
	beamWidth  float64
}

type setupRequest struct {
	SourceIDs       []string `json:"sourceIds"`
	SourceLat       string   `json:"sourceLatB64"`
	SourceLon       string   `json:"sourceLonB64"`
	SourceAzimuth   string   `json:"sourceAzimuthB64,omitempty"`
	SourceBeamwidth string   `json:"sourceBeamwidthB64,omitempty"`
	TargetIDs       []string `json:"targetIds,omitempty"`
	TargetLat       string   `json:"targetLatB64,omitempty"`
	TargetLon       string   `json:"targetLonB64,omitempty"`
	HasTarget       bool     `json:"hasTarget"`
	NNeighbors      int      `json:"nNeighbors"`
	VoronoiLay      int      `json:"voronoiLayers"`
	BeamWidth       float64  `json:"beamWidth"`
	Unit            string   `json:"unit"`
	Method          string   `json:"method"`
	ExcludeZero     bool     `json:"excludeZero"`
	MaxDistance     *float64 `json:"maxDistance"`
	DistanceOp      string   `json:"distanceOp"`
}

// ------------------------------------------------------------------ session
//
// The session keeps point sets and the Voronoi triangulation alive across calls
// so a calculation and the Voronoi cell/edge rendering that follows it all share
// a single triangulation.

type session struct {
	p params

	srcLat, srcLon []float64
	srcIDs         []string
	src            *pointSet
	srcAz          []float64 // per-source azimuth (NaN when unmapped)
	srcBw          []float64 // per-source beamwidth (NaN when unmapped)

	tgtLat, tgtLon []float64
	tgtIDs         []string
	tgt            *pointSet
	tgtGrid        *gridIndex
	tgtGroup       []int32 // per-target id group; nil when not self-excluding
	srcGroup       []int32 // per-source id group, indexed by source index

	uniLat, uniLon []float64
	uniIDs         []string
	uni            *pointSet
	srcToUni       []int32

	del      *delaunay
	delOff   []int32
	delTgt   []int32
	delTri   triangleIndex
	delStamp []int32
	delLayer []int32
	delRun   int32
}

func (s *session) setup(req setupRequest) error {
	s.p = params{
		nNeighbors: req.NNeighbors,
		voronoiLay: req.VoronoiLay,
		mult:       unitMultiplier(req.Unit),
		method:     req.Method,
		hasTarget:  req.HasTarget,
		beamWidth:  req.BeamWidth,
		filter:     distFilter{excludeZero: req.ExcludeZero, op: req.DistanceOp},
	}
	if req.MaxDistance != nil {
		s.p.filter.hasMax = true
		s.p.filter.max = *req.MaxDistance
	}

	var err error
	if s.srcLat, err = b64ToF64(req.SourceLat); err != nil {
		return err
	}
	if s.srcLon, err = b64ToF64(req.SourceLon); err != nil {
		return err
	}
	s.srcIDs = req.SourceIDs
	if len(s.srcLat) != len(req.SourceIDs) || len(s.srcLon) != len(req.SourceIDs) {
		return errf("source coordinate/id length mismatch")
	}
	s.src = newPointSet(s.srcLat, s.srcLon)

	if req.SourceAzimuth != "" {
		if s.srcAz, err = b64ToF64(req.SourceAzimuth); err != nil {
			return err
		}
		if len(s.srcAz) != len(s.srcIDs) {
			return errf("source azimuth/source length mismatch")
		}
	} else {
		s.srcAz = nil
	}

	if req.SourceBeamwidth != "" {
		if s.srcBw, err = b64ToF64(req.SourceBeamwidth); err != nil {
			return err
		}
		if len(s.srcBw) != len(s.srcIDs) {
			return errf("source beamwidth/source length mismatch")
		}
	} else {
		s.srcBw = nil
	}

	if req.HasTarget {
		if s.tgtLat, err = b64ToF64(req.TargetLat); err != nil {
			return err
		}
		if s.tgtLon, err = b64ToF64(req.TargetLon); err != nil {
			return err
		}
		s.tgtIDs = req.TargetIDs
		if len(s.tgtLat) != len(req.TargetIDs) || len(s.tgtLon) != len(req.TargetIDs) {
			return errf("target coordinate/id length mismatch")
		}
	} else {
		s.tgtLat, s.tgtLon, s.tgtIDs = s.srcLat, s.srcLon, s.srcIDs
	}
	s.tgt = newPointSet(s.tgtLat, s.tgtLon)
	s.tgtGrid = buildGrid(s.tgtLat, s.tgtLon)

	// The JS keeps every target whose id differs from the *current source's*
	// id, so duplicate ids are removed pairwise rather than globally. Each
	// distinct id gets a small integer, which turns the per-candidate test into
	// a single int comparison instead of a map lookup. Assigned here rather than
	// per calc range, since it depends only on the id lists.
	if !s.p.hasTarget {
		group := make(map[string]int32, len(s.tgtIDs))
		s.tgtGroup = make([]int32, len(s.tgtIDs))
		for j, id := range s.tgtIDs {
			g, ok := group[id]
			if !ok {
				g = int32(len(group))
				group[id] = g
			}
			s.tgtGroup[j] = g
		}
		s.srcGroup = make([]int32, len(s.srcIDs))
		for i, id := range s.srcIDs {
			g, ok := group[id]
			if !ok {
				// id not present in the target set: the JS filter also matched
				// nothing, so nothing is excluded.
				g = -1
			}
			s.srcGroup[i] = g
		}
	} else {
		s.tgtGroup, s.srcGroup = nil, nil
	}

	// Unified list, matching the JS Map insertion order: sources first, then
	// target-only ids.
	s.uniLat = append(make([]float64, 0, len(s.srcLat)+len(s.tgtLat)), s.srcLat...)
	s.uniLon = append(make([]float64, 0, len(s.srcLon)+len(s.tgtLon)), s.srcLon...)
	s.uniIDs = append(make([]string, 0, len(s.srcIDs)+len(s.tgtIDs)), s.srcIDs...)
	uniIndex := make(map[string]int32, len(s.srcLat)+len(s.tgtLat))
	s.srcToUni = make([]int32, len(s.srcIDs))
	for i, id := range s.srcIDs {
		uniIndex[id] = int32(i)
		s.srcToUni[i] = int32(i)
	}
	if req.HasTarget {
		for i, id := range s.tgtIDs {
			if _, ok := uniIndex[id]; ok {
				continue
			}
			uniIndex[id] = int32(len(s.uniIDs))
			s.uniIDs = append(s.uniIDs, id)
			s.uniLat = append(s.uniLat, s.tgtLat[i])
			s.uniLon = append(s.uniLon, s.tgtLon[i])
		}
	}
	s.uni = newPointSet(s.uniLat, s.uniLon)
	s.del = nil
	return nil
}

func (s *session) ensureVoronoi() {
	if s.del != nil {
		return
	}
	pts := make([]point2, len(s.uniLat))
	for i := range s.uniLat {
		pts[i] = point2{x: s.uniLon[i], y: s.uniLat[i]}
	}
	s.del = triangulate(pts)
	s.delOff, s.delTgt = s.del.adjacency()
	s.delTri = s.del.indexTriangles()
	s.delStamp = make([]int32, len(pts))
	s.delLayer = make([]int32, len(pts))
}

type calcRequest struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

type calcResponse struct {
	// Count is the per-source offset table; neighbour index spaces are the
	// target array for brute force and the unified array for Voronoi.
	Count string `json:"count"`
	Idx   string `json:"idx"`
	Dist  string `json:"dist"`
	Layer string `json:"layer"`
	Start int    `json:"start"`
}

// calcRange computes neighbours for source indices [start,end).
func (s *session) calcRange(req calcRequest, onProgress func(float64)) (*calcResponse, error) {
	start, end := req.Start, req.End
	if start < 0 {
		start = 0
	}
	if end > len(s.srcIDs) {
		end = len(s.srcIDs)
	}
	if end < start {
		end = start
	}
	if s.p.method == "voronoi" {
		return s.calcVoronoi(start, end, onProgress), nil
	}
	// Sector and brute force share the same scanning engine; the only
	// difference is that sector additionally filters by the beam.
	res := bruteKNN(
		s.tgt, s.tgtGrid, s.tgtGroup, s.srcGroup, s.src,
		start, end, s.p.nNeighbors, s.p.mult, !s.p.hasTarget, s.p.filter,
		s.srcAz, s.srcBw, s.p.beamWidth,
		func(done, total int) {
			if onProgress != nil {
				onProgress(float64(done) / float64(total) * 100)
			}
		},
	)
	return &calcResponse{
		Count: i32ToB64(res.off),
		Idx:   i32ToB64(res.idx),
		Dist:  f64ToB64(res.dist),
		Layer: i32ToB64(res.layer),
		Start: start,
	}, nil
}

type nbRow struct {
	idx   int32
	dist  float64
	layer int32
}

func (s *session) calcVoronoi(start, end int, onProgress func(float64)) *calcResponse {
	s.ensureVoronoi()
	off := make([]int32, end-start+1)
	var idx, layers []int32
	var dists []float64
	uni := s.uni
	total := end - start
	if total < 1 {
		total = 1
	}

	for i := start; i < end; i++ {
		off[i-start] = int32(len(idx))
		srcUni := s.srcToUni[i]

		s.delRun++
		layerMap := s.del.neighborsNLayers(s.delOff, s.delTgt, srcUni, s.p.voronoiLay, s.delStamp, s.delLayer, s.delRun)

		// Duplicate coordinates produce no triangles; the JS code falls back to
		// the closest site by great-circle distance and uses its rings.
		if len(layerMap) == 0 {
			bestIdx := int32(-1)
			bestDist := math.Inf(1)
			for j := 0; j < len(uni.lat); j++ {
				if int32(j) == srcUni {
					continue
				}
				if d := uni.distKm(int(srcUni), j); d < bestDist {
					bestDist = d
					bestIdx = int32(j)
				}
			}
			if bestIdx >= 0 {
				s.delRun++
				layerMap = s.del.neighborsNLayers(s.delOff, s.delTgt, bestIdx, s.p.voronoiLay, s.delStamp, s.delLayer, s.delRun)
			}
		}

		rows := make([]nbRow, 0, len(layerMap))
		for j, layer := range layerMap {
			if j == srcUni {
				continue
			}
			rows = append(rows, nbRow{idx: j, dist: uni.distKm(int(srcUni), int(j)) * s.p.mult, layer: layer})
		}
		sort.Slice(rows, func(a, b int) bool { return rows[a].dist < rows[b].dist })
		for _, r := range rows {
			idx = append(idx, r.idx)
			dists = append(dists, r.dist)
			layers = append(layers, r.layer)
		}
		if onProgress != nil {
			onProgress(float64(i-start+1) / float64(total) * 100)
		}
	}
	off[end-start] = int32(len(idx))
	return &calcResponse{
		Count: i32ToB64(off),
		Idx:   i32ToB64(idx),
		Dist:  f64ToB64(dists),
		Layer: i32ToB64(layers),
		Start: start,
	}
}

// ----------------------------------------------------------------- voronoi io

type geomRequest struct {
	IDs   []string `json:"ids"`
	Lat   string   `json:"latB64"`
	Lon   string   `json:"lonB64"`
	Which string   `json:"which"`
}

type cellFeature struct {
	Type  string       `json:"type"`
	ID    string       `json:"id"`
	Props cellProps    `json:"properties"`
	Geom  cellGeometry `json:"geometry"`
}

type cellProps struct {
	SiteID string `json:"siteId"`
	Color  string `json:"color"`
}

type cellGeometry struct {
	Type        string        `json:"type"`
	Coordinates [][][]float64 `json:"coordinates"`
}

type cellsResponse struct {
	Features []cellFeature `json:"features"`
}

type edgesResponse struct {
	Edges []voronoiEdge `json:"edges"`
}

// triangulateOnce keeps the last triangulation so cells and edges for the same
// site list only pay for it once.
var (
	cacheKey string
	cacheDel *delaunay
	cacheTri triangleIndex
	cacheIDs []string
)

func triangulateCached(ids []string, lat, lon []float64) (*delaunay, triangleIndex) {
	key := ""
	if len(lat) > 0 {
		key = itoa(len(lat)) + ":" + ftoa(lat[0]) + "," + ftoa(lon[0]) + "," +
			ftoa(lat[len(lat)-1]) + "," + ftoa(lon[len(lon)-1]) + ":" + u64toa(sum64(lat)+sum64(lon))
	}
	if cacheDel != nil && cacheKey == key && len(cacheIDs) == len(ids) {
		return cacheDel, cacheTri
	}
	pts := make([]point2, len(lat))
	for i := range lat {
		pts[i] = point2{x: lon[i], y: lat[i]}
	}
	d := triangulate(pts)
	cacheDel = d
	cacheTri = d.indexTriangles()
	cacheKey = key
	cacheIDs = append([]string{}, ids...)
	return d, cacheTri
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [24]byte
	p := len(buf)
	for n > 0 {
		p--
		buf[p] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[p:])
}

func ftoa(f float64) string {
	b, _ := json.Marshal(f)
	return string(b)
}

func u64toa(v uint64) string {
	const digits = "0123456789abcdef"
	if v == 0 {
		return "0"
	}
	var buf [16]byte
	p := len(buf)
	for v > 0 {
		p--
		buf[p] = digits[v&0xf]
		v >>= 4
	}
	return string(buf[p:])
}

func sum64(v []float64) uint64 {
	var s uint64
	for _, f := range v {
		s = s*31 + uint64(int64(f*1e6))
	}
	return s
}

func decodeGeom(req geomRequest) ([]string, []float64, []float64, error) {
	lat, err := b64ToF64(req.Lat)
	if err != nil {
		return nil, nil, nil, err
	}
	lon, err := b64ToF64(req.Lon)
	if err != nil {
		return nil, nil, nil, err
	}
	return req.IDs, lat, lon, nil
}

func cellsFor(req geomRequest) (*cellsResponse, error) {
	ids, lat, lon, err := decodeGeom(req)
	if err != nil {
		return nil, err
	}
	out := &cellsResponse{Features: []cellFeature{}}
	if len(lat) < 3 {
		return out, nil
	}
	_, tri := triangulateCached(ids, lat, lon)
	for i := 0; i < len(lat); i++ {
		verts := cacheDel.cellPolygon(tri, int32(i))
		if len(verts) < 3 {
			continue
		}
		ring := make([][]float64, 0, len(verts)+1)
		for _, v := range verts {
			ring = append(ring, []float64{v.x, v.y})
		}
		ring = append(ring, []float64{verts[0].x, verts[0].y})
		out.Features = append(out.Features, cellFeature{
			Type:  "Feature",
			ID:    ids[i],
			Props: cellProps{SiteID: ids[i], Color: "#8b5cf6"},
			Geom:  cellGeometry{Type: "Polygon", Coordinates: [][][]float64{ring}},
		})
	}
	return out, nil
}

func edgesFor(req geomRequest) (*edgesResponse, error) {
	ids, lat, lon, err := decodeGeom(req)
	if err != nil {
		return nil, err
	}
	out := &edgesResponse{Edges: []voronoiEdge{}}
	if len(lat) < 3 {
		return out, nil
	}
	d, _ := triangulateCached(ids, lat, lon)
	out.Edges = d.edges(ids)
	return out, nil
}

type cellForSiteRequest struct {
	IDs     []string `json:"ids"`
	Lat     string   `json:"latB64"`
	Lon     string   `json:"lonB64"`
	Targets []string `json:"targets"`
}

type cellForSiteResponse struct {
	Features []cellFeature `json:"features"`
}

// cellsForSites returns the Voronoi cell of each requested site, used for the
// neighbour highlight on the map.
func cellsForSites(req cellForSiteRequest) (*cellForSiteResponse, error) {
	ids, lat, lon, err := decodeGeom(geomRequest{IDs: req.IDs, Lat: req.Lat, Lon: req.Lon})
	if err != nil {
		return nil, err
	}
	out := &cellForSiteResponse{Features: []cellFeature{}}
	if len(lat) < 3 {
		return out, nil
	}
	_, tri := triangulateCached(ids, lat, lon)
	index := make(map[string]int32, len(ids))
	for i, id := range ids {
		index[id] = int32(i)
	}
	for _, t := range req.Targets {
		idx, ok := index[t]
		if !ok {
			continue
		}
		verts := cacheDel.cellPolygon(tri, idx)
		if len(verts) < 3 {
			continue
		}
		ring := make([][]float64, 0, len(verts)+1)
		for _, v := range verts {
			ring = append(ring, []float64{v.x, v.y})
		}
		ring = append(ring, []float64{verts[0].x, verts[0].y})
		out.Features = append(out.Features, cellFeature{
			Type:  "Feature",
			ID:    t,
			Props: cellProps{SiteID: t, Color: "#8b5cf6"},
			Geom:  cellGeometry{Type: "Polygon", Coordinates: [][][]float64{ring}},
		})
	}
	return out, nil
}
