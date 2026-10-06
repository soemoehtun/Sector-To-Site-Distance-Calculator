package main

import (
	"encoding/xml"
	"io"
	"strconv"
	"strings"
)

// KML and GPX are both XML with Point geometries, so they share one streaming
// reader here instead of the DOMParser + togeojson path. Properties keep
// document order so the generated columns match the old implementation.

type orderedProps struct {
	keys []string
	vals map[string]string
}

func newProps() *orderedProps { return &orderedProps{vals: map[string]string{}} }

func (o *orderedProps) set(k, v string) {
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
}

func (o *orderedProps) get(k string) string { return o.vals[k] }

type vecPoint struct {
	lat, lon float64
	props    *orderedProps
}

func readKmlPoints(r io.Reader) ([]vecPoint, error) {
	dec := xml.NewDecoder(r)
	var out []vecPoint
	var cur *vecPoint
	inPlacemark := false
	geom := ""
	dataName := ""
	var name string
	var text strings.Builder

	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "Placemark":
				inPlacemark = true
				cur = &vecPoint{props: newProps()}
				geom = ""
				name = ""
			case "Data", "SimpleData":
				dataName = attrValue(t, "name")
				text.Reset()
			case "name":
				text.Reset()
			case "coordinates":
				text.Reset()
			case "Point", "LineString", "LinearRing", "Polygon", "MultiGeometry":
				if inPlacemark {
					geom = t.Name.Local
				}
			}
		case xml.CharData:
			text.Write(t)
		case xml.EndElement:
			switch t.Name.Local {
			case "name":
				if inPlacemark && name == "" {
					name = strings.TrimSpace(text.String())
				}
			case "Data", "SimpleData":
				if inPlacemark && dataName != "" {
					cur.props.set(dataName, strings.TrimSpace(text.String()))
				}
				dataName = ""
			case "coordinates":
				if inPlacemark {
					fields := strings.Fields(strings.TrimSpace(text.String()))
					if len(fields) >= 2 {
						lon, err1 := strconv.ParseFloat(fields[0], 64)
						lat, err2 := strconv.ParseFloat(fields[1], 64)
						if err1 == nil && err2 == nil {
							cur.lon, cur.lat = lon, lat
						}
					}
				}
			case "Placemark":
				if inPlacemark && cur != nil && geom == "Point" {
					if name != "" {
						cur.props.set("name", name)
					}
					out = append(out, *cur)
				}
				inPlacemark = false
				cur = nil
			}
		}
	}
	return out, nil
}

func readGpxPoints(r io.Reader) ([]vecPoint, error) {
	dec := xml.NewDecoder(r)
	var out []vecPoint
	var cur *vecPoint
	var text strings.Builder

	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "wpt", "trkpt", "rtept":
				lat, _ := strconv.ParseFloat(attrValue(t, "lat"), 64)
				lon, _ := strconv.ParseFloat(attrValue(t, "lon"), 64)
				cur = &vecPoint{lat: lat, lon: lon, props: newProps()}
			case "name", "desc", "cmt", "sym", "type":
				text.Reset()
			}
		case xml.CharData:
			text.Write(t)
		case xml.EndElement:
			switch t.Name.Local {
			case "name", "desc", "cmt", "sym", "type":
				if cur != nil {
					cur.props.set(t.Name.Local, strings.TrimSpace(text.String()))
				}
			case "wpt", "trkpt", "rtept":
				if cur != nil {
					out = append(out, *cur)
				}
				cur = nil
			}
		}
	}
	return out, nil
}

func pointsToTable(points []vecPoint, fileName string) (*table, error) {
	if len(points) == 0 {
		return nil, errf("no point features found in the file. only point geometries are supported")
	}
	// Column order matches geoJsonToDataset(): Latitude, Longitude, then every
	// property key in first-seen order.
	var keys []string
	seen := map[string]bool{"Latitude": true, "Longitude": true}
	for _, p := range points {
		for _, k := range p.props.keys {
			if !seen[k] {
				seen[k] = true
				keys = append(keys, k)
			}
		}
	}
	cols := append([]string{"Latitude", "Longitude"}, keys...)

	b := newTableBuilder(cols)
	row := make([]string, len(cols))
	for _, p := range points {
		row[0] = formatNumber(strconv.FormatFloat(p.lat, 'f', -1, 64))
		row[1] = formatNumber(strconv.FormatFloat(p.lon, 'f', -1, 64))
		for i, k := range keys {
			row[i+2] = p.props.get(k)
		}
		b.addRow(row)
	}
	return b.table(fileName), nil
}
