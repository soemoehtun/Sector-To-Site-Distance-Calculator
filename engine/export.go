package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// ------------------------------------------------------------------ KMZ

type kmzSite struct {
	ID        string        `json:"id"`
	Lat       float64       `json:"lat"`
	Lon       float64       `json:"lon"`
	IsSource  bool          `json:"isSource"`
	IsTarget  bool          `json:"isTarget"`
	Fields    [][2]string   `json:"fields"`
	Neighbors []kmzNeighbor `json:"neighbors"`
}

type kmzNeighbor struct {
	To    string  `json:"to"`
	Dist  float64 `json:"dist"`
	Layer int32   `json:"layer"`
}

type kmzConn struct {
	From     string  `json:"from"`
	To       string  `json:"to"`
	Distance float64 `json:"distance"`
}

type kmzEdge struct {
	Lat1  float64 `json:"lat1"`
	Lng1  float64 `json:"lng1"`
	Lat2  float64 `json:"lat2"`
	Lng2  float64 `json:"lng2"`
	SiteA string  `json:"siteA"`
	SiteB string  `json:"siteB"`
}

// kmzPolygon holds a single Voronoi cell polygon (outer ring only).
// Each element of Ring is [lng, lat].
type kmzPolygon struct {
	SiteID string      `json:"siteId"`
	Ring   [][2]float64 `json:"ring"`
}

type kmzOptions struct {
	Sites               []kmzSite    `json:"sites"`
	Connections         []kmzConn    `json:"connections"`
	LineColor           string       `json:"lineColor"`
	LineThickness       float64      `json:"lineThickness"`
	LineOpacity         float64      `json:"lineOpacity"`
	SourceIconColor     string       `json:"sourceIconColor"`
	SourceIconOpacity   float64      `json:"sourceIconOpacity"`
	SourceIconScale     float64      `json:"sourceIconScale"`
	NeighborIconColor   string       `json:"neighborIconColor"`
	NeighborIconOpacity float64      `json:"neighborIconOpacity"`
	NeighborIconScale   float64      `json:"neighborIconScale"`
	ShowVoronoi         bool         `json:"showVoronoi"`
	VoronoiEdges        []kmzEdge    `json:"voronoiEdges"`
	VoronoiPolygons     []kmzPolygon `json:"voronoiPolygons"`
	DistanceUnit        string       `json:"distanceUnit"`
	CalcMethod          string       `json:"calcMethod"`
	VoronoiLayers       int          `json:"voronoiLayers"`
	NNeighbors          int          `json:"nNeighbors"`
	HasTarget           bool         `json:"hasTarget"`
	IconPngB64          string       `json:"iconPngB64"`
	PopupColumns        []string     `json:"popupColumns"`
	PopupColumnsTarget  []string     `json:"popupColumnsTarget"`
}

// hexToKmlColor is a port of hexToKmlColor() in src/lib/export.ts: #rrggbb plus
// an alpha byte become KML's aabbggrr.
func hexToKmlColor(hex string, opacity float64) string {
	rgb := "ff0000"
	h := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(hex), "#"))
	if len(h) == 6 {
		if _, err := strconv.ParseUint(h, 16, 32); err == nil {
			rgb = h
		}
	}
	if math.IsNaN(opacity) {
		opacity = 1
	}
	a := int(math.Round(math.Max(0, math.Min(1, opacity)) * 255))
	return strings.ToLower(
		pad2(a) + rgb[4:6] + rgb[2:4] + rgb[0:2],
	)
}

func pad2(n int) string {
	s := strconv.FormatInt(int64(n), 16)
	if len(s) < 2 {
		return "0" + s
	}
	return s
}

func xmlEscape(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '"':
			b.WriteString("&quot;")
		case '\'':
			b.WriteString("&apos;")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

var kmzLayerColors = []string{
	"#22c55e", "#eab308", "#ef4444", "#06b6d4", "#8b5cf6",
	"#ec4899", "#f97316", "#14b8a6", "#6366f1", "#a855f7",
}

func buildKmz(opts kmzOptions) ([]byte, error) {
	srcColor := hexToKmlColor(opts.SourceIconColor, opts.SourceIconOpacity)
	nbrColor := hexToKmlColor(opts.NeighborIconColor, opts.NeighborIconOpacity)
	lineColor := hexToKmlColor(opts.LineColor, opts.LineOpacity/100)
	srcScale := math.Max(0.1, math.Min(opts.SourceIconScale, 4))
	nbrScale := math.Max(0.1, math.Min(opts.NeighborIconScale, 4))
	iconHref := "http://maps.google.com/mapfiles/kml/paddle/wht-blank.png"

	var kml strings.Builder
	kml.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Sector To Site Distance Calculator Export</name>
  <open>1</open>
`)
	fmt.Fprintf(&kml, `  <Style id="sourceStyle">
    <IconStyle>
      <color>%s</color>
      <scale>%s</scale>
      <Icon>
        <href>%s</href>
      </Icon>
      <hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/>
    </IconStyle>
    <LabelStyle>
      <color>ffffffff</color>
      <scale>0.8</scale>
    </LabelStyle>
    <BalloonStyle>
      <text><![CDATA[$[description]]]></text>
    </BalloonStyle>
  </Style>
`, srcColor, trimNum(srcScale), iconHref)
	fmt.Fprintf(&kml, `  <Style id="neighborStyle">
    <IconStyle>
      <color>%s</color>
      <scale>%s</scale>
      <Icon>
        <href>%s</href>
      </Icon>
      <hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/>
    </IconStyle>
    <LabelStyle>
      <color>ffffffff</color>
      <scale>0.8</scale>
    </LabelStyle>
    <BalloonStyle>
      <text><![CDATA[$[description]]]></text>
    </BalloonStyle>
  </Style>
  <Style id="lineStyle">
    <LineStyle>
      <color>%s</color>
      <width>%s</width>
    </LineStyle>
    <BalloonStyle>
      <text><![CDATA[$[description]]]></text>
    </BalloonStyle>
  </Style>
  <Folder>
    <name>Sites</name>
    <open>1</open>
`, nbrColor, trimNum(nbrScale), iconHref, lineColor, trimNum(opts.LineThickness))

	for _, s := range opts.Sites {
		var extra strings.Builder
		for _, kv := range s.Fields {
			extra.WriteString(`<div style="margin-bottom:4px;font-size:12px;color:#1e293b;">
            <strong>` + xmlEscape(kv[0]) + `:</strong> ` + xmlEscape(kv[1]) + `
          </div>`)
		}

		var neighbor strings.Builder
		if s.IsSource || !opts.HasTarget {
			neighbor.WriteString(`<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #e2e8f0;">
        <div style="font-size:11px;font-weight:700;color:#64748b;margin-bottom:6px;text-transform:uppercase;">`)
			if opts.CalcMethod == "voronoi" {
				neighbor.WriteString("Voronoi Neighbors (" + itoa(opts.VoronoiLayers) + "-Layer)")
			} else {
				n := opts.NNeighbors
				if n == 0 {
					n = 3
				}
				neighbor.WriteString("Nearest " + itoa(n) + " Neighbors (" + itoa(len(s.Neighbors)) + " assigned)")
			}
			neighbor.WriteString(`</div>`)

			if len(s.Neighbors) == 0 {
				neighbor.WriteString(`<div style="margin-bottom:4px;font-size:12px;color:#64748b;">None</div>`)
			} else if opts.CalcMethod == "voronoi" {
				byLayer := map[int32][]kmzNeighbor{}
				var order []int
				for _, nb := range s.Neighbors {
					l := nb.Layer
					if l == 0 {
						l = 1
					}
					if _, ok := byLayer[l]; !ok {
						order = append(order, int(l))
					}
					byLayer[l] = append(byLayer[l], nb)
				}
				sort.Ints(order)
				for _, l := range order {
					color := kmzLayerColors[(l-1)%len(kmzLayerColors)]
					neighbor.WriteString(`<div style="margin-top:6px;margin-bottom:2px;padding:3px 0;border-bottom:1px solid #f1f5f9;">
                <div style="font-size:10px;font-weight:700;color:` + color + `;text-transform:uppercase;letter-spacing:0.04em;">Layer ` + itoa(l) + `</div>`)
					for _, nb := range byLayer[int32(l)] {
						neighbor.WriteString(`<div style="margin-bottom:2px;font-size:12px;color:#1e293b;padding-left:4px;">
                    <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:` + color + `;margin-right:4px;vertical-align:middle;"></span><strong>` +
							xmlEscape(nb.To) + `</strong> &ndash; ` + trimNum(math.Round(nb.Dist*1000)/1000) + ` ` + opts.DistanceUnit + `
                  </div>`)
					}
					neighbor.WriteString(`</div>`)
				}
			} else {
				for i, nb := range s.Neighbors {
					neighbor.WriteString(`<div style="margin-bottom:4px;font-size:12px;color:#1e293b;">
                <strong>` + itoa(i+1) + `. ` + xmlEscape(nb.To) + `:</strong> ` +
						trimNum(math.Round(nb.Dist*1000)/1000) + ` ` + opts.DistanceUnit + `
              </div>`)
				}
			}
			neighbor.WriteString(`</div>`)
		}

		styleURL := "#sourceStyle"
		if opts.HasTarget && s.IsTarget && !s.IsSource {
			styleURL = "#neighborStyle"
		}

		desc := `<div style="font-family:'Inter',Arial,sans-serif;min-width:160px;max-height:280px;overflow-y:auto;">
      <div style="font-size:13px;font-weight:600;color:#0f172a;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #e2e8f0;padding-right:16px;">
        ` + xmlEscape(s.ID) + `
      </div>
      <div>
        ` + extra.String() + `
      </div>
      ` + neighbor.String() + `
    </div>`

		kml.WriteString(`    <Placemark>
      <name>` + xmlEscape(s.ID) + `</name>
      <description><![CDATA[` + desc + `]]></description>
      <styleUrl>` + styleURL + `</styleUrl>
      <Point>
        <coordinates>` + trimNum(s.Lon) + `,` + trimNum(s.Lat) + `,0</coordinates>
      </Point>
    </Placemark>
`)
	}

	kml.WriteString(`  </Folder>
`)

	if opts.CalcMethod != "voronoi" && len(opts.Connections) > 0 {
		// Brute-force mode: add connection lines folder
		kml.WriteString(`  <Folder>
    <name>Connections</name>
    <open>1</open>
`)
		arrow := " ⇄ "
		if opts.HasTarget {
			arrow = " → "
		}
		siteIndex := make(map[string]int, len(opts.Sites))
		for i, s := range opts.Sites {
			if _, seen := siteIndex[s.ID]; !seen {
				siteIndex[s.ID] = i
			}
		}
		for _, c := range opts.Connections {
			i1, ok1 := siteIndex[c.From]
			i2, ok2 := siteIndex[c.To]
			if !ok1 || !ok2 {
				continue
			}
			p1, p2 := opts.Sites[i1], opts.Sites[i2]
			kml.WriteString(`    <Placemark>
      <name>` + xmlEscape(c.From) + arrow + xmlEscape(c.To) + ` | ` +
				trimNum(math.Round(c.Distance*1000)/1000) + ` ` + opts.DistanceUnit + `</name>
      <styleUrl>#lineStyle</styleUrl>
      <LineString>
        <coordinates>` + trimNum(p1.Lon) + `,` + trimNum(p1.Lat) + `,0 ` +
				trimNum(p2.Lon) + `,` + trimNum(p2.Lat) + `,0</coordinates>
      </LineString>
    </Placemark>
`)
		}
		kml.WriteString(`  </Folder>
`)
	}

	if opts.CalcMethod == "voronoi" && len(opts.VoronoiPolygons) > 0 {
		// Voronoi mode: add polygon cells folder
		kml.WriteString(`  <Style id="voronoiPolyStyle">
    <LineStyle><color>` + hexToKmlColor("#8b5cf6", 0.9) + `</color><width>1.5</width></LineStyle>
    <PolyStyle><color>` + hexToKmlColor("#8b5cf6", 0.15) + `</color><fill>1</fill><outline>1</outline></PolyStyle>
    <BalloonStyle><text><![CDATA[$[description]]]></text></BalloonStyle>
  </Style>
  <Folder>
    <name>Voronoi Polygons</name>
    <open>1</open>
`)
		for _, poly := range opts.VoronoiPolygons {
			if len(poly.Ring) < 3 {
				continue
			}
			var coords strings.Builder
			for i, pt := range poly.Ring {
				if i > 0 {
					coords.WriteString(" ")
				}
				coords.WriteString(trimNum(pt[0]) + "," + trimNum(pt[1]) + ",0")
			}
			kml.WriteString(`    <Placemark>
      <name>` + xmlEscape(poly.SiteID) + `</name>
      <styleUrl>#voronoiPolyStyle</styleUrl>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>` + coords.String() + `</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
`)
		}
		kml.WriteString(`  </Folder>
`)
	}

	kml.WriteString(`</Document>
</kml>`)

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("doc.kml")
	if err != nil {
		return nil, err
	}
	if _, err := w.Write([]byte(kml.String())); err != nil {
		return nil, err
	}
	if opts.IconPngB64 != "" {
		png, derr := base64.StdEncoding.DecodeString(opts.IconPngB64)
		if derr == nil {
			if w2, err := zw.Create("files/circle.png"); err == nil {
				w2.Write(png)
			}
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func trimNum(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e15 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// ------------------------------------------------------------------ XLSX

type xlsxRow struct {
	source string
	to     string
	dist   float64
	layer  int32
	rank   int
}

type xlsxRequest struct {
	Rows         []xlsxRow `json:"rows"`
	DistanceUnit string    `json:"distanceUnit"`
	CalcMethod   string    `json:"calcMethod"`
	SheetName    string    `json:"sheetName"`
}

// buildXlsx writes a minimal but valid workbook: the same "Detailed_Distances"
// sheet the SheetJS version produced, without needing a spreadsheet library.
func buildXlsx(req xlsxRequest) ([]byte, error) {
	// The SheetJS version sorted each site's neighbours by (layer, distance) and
	// reset the rank counter per site, so group first and sort inside a group.
	groups := make([]string, 0)
	bySource := map[string][]xlsxRow{}
	for _, r := range req.Rows {
		if _, ok := bySource[r.source]; !ok {
			groups = append(groups, r.source)
		}
		bySource[r.source] = append(bySource[r.source], r)
	}
	rows := make([]xlsxRow, 0, len(req.Rows))
	for _, g := range groups {
		grp := bySource[g]
		if req.CalcMethod == "voronoi" {
			sort.SliceStable(grp, func(a, b int) bool {
				la, lb := layerOf(grp[a].layer), layerOf(grp[b].layer)
				if la != lb {
					return la < lb
				}
				return grp[a].dist < grp[b].dist
			})
		}
		rows = append(rows, grp...)
	}

	headers := []string{"Source Site", "Neighbor Site", "Distance (" + req.DistanceUnit + ")"}
	if req.CalcMethod == "voronoi" {
		headers = append(headers, "Voronoi Layer")
	}
	headers = append(headers, "Rank")

	var sheet strings.Builder
	sheetRowCount := 1
	sheet.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	writeRow := func(cells []string) {
		sheet.WriteString(`<row>`)
		for i, c := range cells {
			sheet.WriteString(`<c r="` + colName(i) + itoa(sheetRowCount) + `" t="inlineStr"><is><t>` +
				xmlEscape(c) + `</t></is></c>`)
		}
		sheet.WriteString(`</row>`)
	}
	writeRow(headers)

	lastLayer := int32(-1)
	lastSource := "\x00"
	layerRank := 0
	rank := 0
	for _, r := range rows {
		rank++
		if r.source != lastSource {
			lastSource = r.source
			lastLayer = -1
		}
		if req.CalcMethod == "voronoi" {
			l := layerOf(r.layer)
			if int32(l) != lastLayer {
				lastLayer = int32(l)
				layerRank = 1
			} else {
				layerRank++
			}
			rank = layerRank
		}
		// The host passes the value already rounded the way the SheetJS path
		// rounds it (Number(dist.toFixed(3))), so writing the shortest exact
		// decimal here keeps the two workbooks cell for cell identical.
		cells := []string{r.source, r.to, strconv.FormatFloat(r.dist, 'f', -1, 64)}
		if req.CalcMethod == "voronoi" {
			cells = append(cells, itoa(layerOf(r.layer)))
		}
		cells = append(cells, itoa(rank))
		sheetRowCount++
		writeRow(cells)
	}
	sheet.WriteString(`</sheetData></worksheet>`)

	sheetName := req.SheetName
	if sheetName == "" {
		sheetName = "Detailed_Distances"
	}

	contentTypes := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`

	rootRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

	workbook := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="` + xmlEscape(sheetName) + `" sheetId="1" r:id="rId1"/></sheets></workbook>`

	wbRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	parts := []struct{ name, data string }{
		{"[Content_Types].xml", contentTypes},
		{"_rels/.rels", rootRels},
		{"xl/workbook.xml", workbook},
		{"xl/_rels/workbook.xml.rels", wbRels},
		{"xl/worksheets/sheet1.xml", sheet.String()},
	}
	for _, p := range parts {
		w, err := zw.Create(p.name)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write([]byte(p.data)); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func layerOf(l int32) int {
	if l == 0 {
		return 1
	}
	return int(l)
}

func colName(i int) string {
	name := ""
	i++
	for i > 0 {
		i--
		name = string(rune('A'+i%26)) + name
		i /= 26
	}
	return name
}
