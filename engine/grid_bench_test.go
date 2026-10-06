package main

import (
	"fmt"
	"math/rand"
	"testing"
)

func genLattice(n int) ([]float64, []float64) {
	lat := make([]float64, n)
	lon := make([]float64, n)
	for i := range lat {
		lat[i] = 16 + float64(i%700)/100
		lon[i] = 95 + float64(i%900)/100
	}
	return lat, lon
}

func genClustered(n int) ([]float64, []float64) {
	rng := rand.New(rand.NewSource(7))
	lat := make([]float64, n)
	lon := make([]float64, n)
	for i := range lat {
		lat[i] = 16.8 + rng.NormFloat64()*0.5
		lon[i] = 96.2 + rng.NormFloat64()*0.5
	}
	return lat, lon
}

func genCountry(n int) ([]float64, []float64) {
	rng := rand.New(rand.NewSource(11))
	lat := make([]float64, n)
	lon := make([]float64, n)
	for i := range lat {
		lat[i] = rng.Float64()*20 + 9
		lon[i] = rng.Float64()*6 + 95
	}
	return lat, lon
}

func genGlobal(n int) ([]float64, []float64) {
	rng := rand.New(rand.NewSource(13))
	lat := make([]float64, n)
	lon := make([]float64, n)
	for i := range lat {
		lat[i] = rng.Float64()*180 - 90
		lon[i] = rng.Float64()*360 - 180
	}
	return lat, lon
}

func runCase(b *testing.B, name string, lat, lon []float64, k int) {
	n := len(lat)
	groups := make([]int32, n)
	for i := range groups {
		groups[i] = int32(i)
	}
	ps := newPointSet(lat, lon)
	g := buildGrid(lat, lon)
	_ = name
	b.ResetTimer()
	for it := 0; it < b.N; it++ {
		bruteKNN(ps, g, groups, groups, ps, 0, n, k, 1, true, distFilter{}, nil, nil, 0, nil)
	}
	b.StopTimer()
	b.ReportMetric(float64(g.latN*g.lonN)/float64(n), "cells/pt")
	b.ReportMetric(float64(g.cell), "cellDeg")
}

func BenchmarkLattice(b *testing.B) {
	lat, lon := genLattice(100000)
	runCase(b, "lattice", lat, lon, 3)
}
func BenchmarkClustered(b *testing.B) {
	lat, lon := genClustered(100000)
	runCase(b, "clustered", lat, lon, 3)
}
func BenchmarkCountry(b *testing.B) {
	lat, lon := genCountry(100000)
	runCase(b, "country", lat, lon, 3)
}
func BenchmarkGlobal(b *testing.B) { lat, lon := genGlobal(100000); runCase(b, "global", lat, lon, 3) }

func TestReportGridShapes(t *testing.T) {
	for _, c := range []struct {
		name string
		f    func(int) ([]float64, []float64)
	}{
		{"lattice", genLattice}, {"clustered", genClustered},
		{"country", genCountry}, {"global", genGlobal},
	} {
		lat, lon := c.f(100000)
		g := buildGrid(lat, lon)
		fmt.Printf("%-10s usable=%-5v latN=%-6d lonN=%-6d cell=%.6f cells/pt=%.2f\n",
			c.name, g.usable, g.latN, g.lonN, g.cell,
			float64(g.latN*g.lonN)/100000)
	}
}
