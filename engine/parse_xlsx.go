package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"io"
	"strconv"
	"strings"
)

// XLSX is a zip of XML parts, so reading one needs no third-party dependency:
// archive/zip + encoding/xml replaces the SheetJS bundle. That keeps the wasm
// binary small and avoids pulling excelize in.

type xlWorkbook struct {
	Sheets struct {
		Sheet []struct {
			Name string `xml:"name,attr"`
			ID   string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
		} `xml:"sheet"`
	} `xml:"sheets"`
}

type xlRels struct {
	Rel []struct {
		ID     string `xml:"Id,attr"`
		Target string `xml:"Target,attr"`
	} `xml:"Relationship"`
}

type xlsxFile struct {
	zr        *zip.Reader
	sheetPath map[string]string // sheet name -> part path
	order     []string
	shared    []string
	loaded    map[string]bool
}

func openXlsx(data []byte) (*xlsxFile, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, errf("this file is not a readable .xlsx workbook")
	}
	x := &xlsxFile{zr: zr, sheetPath: map[string]string{}, loaded: map[string]bool{}}

	wbPart := x.part("xl/workbook.xml")
	if wbPart == nil {
		return nil, errf("this file is not a readable .xlsx workbook")
	}
	var wb xlWorkbook
	if err := xml.Unmarshal(wbPart, &wb); err != nil {
		return nil, errf("this workbook could not be read")
	}

	relsPart := x.part("xl/_rels/workbook.xml.rels")
	relTarget := map[string]string{}
	if relsPart != nil {
		var rels xlRels
		if err := xml.Unmarshal(relsPart, &rels); err == nil {
			for _, r := range rels.Rel {
				relTarget[r.ID] = r.Target
			}
		}
	}

	for _, sh := range wb.Sheets.Sheet {
		target := relTarget[sh.ID]
		if target == "" {
			target = "worksheets/sheet" + itoa(len(x.order)+1) + ".xml"
		}
		target = strings.TrimPrefix(target, "/xl/")
		if !strings.HasPrefix(target, "xl/") {
			target = "xl/" + target
		}
		x.sheetPath[sh.Name] = target
		x.order = append(x.order, sh.Name)
	}
	if len(x.order) == 0 {
		return nil, errf("this workbook has no worksheets")
	}
	return x, nil
}

func (x *xlsxFile) part(name string) []byte {
	for _, f := range x.zr.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				return nil
			}
			defer rc.Close()
			data, err := io.ReadAll(rc)
			if err != nil {
				return nil
			}
			return data
		}
	}
	return nil
}

func (x *xlsxFile) sheetNames() []string { return x.order }

// sharedStrings returns the shared string table, cached per workbook.
func (x *xlsxFile) sharedStrings() []string {
	if x.loaded["ss"] {
		return x.shared
	}
	x.loaded["ss"] = true
	data := x.part("xl/sharedStrings.xml")
	if data == nil {
		return nil
	}
	dec := xml.NewDecoder(strings.NewReader(string(data)))
	var out []string
	var cur *strings.Builder
	inSI := false
	depth := 0
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				inSI = true
				cur = &strings.Builder{}
				depth = 0
			case "t":
				if inSI {
					depth++
				}
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				if inSI && depth > 0 {
					depth--
				}
			case "si":
				if inSI && cur != nil {
					out = append(out, cur.String())
					inSI = false
				}
			}
		case xml.CharData:
			if inSI && depth > 0 && cur != nil {
				cur.Write(t)
			}
		}
	}
	x.shared = out
	return out
}

// readSheet streams one worksheet into rows of strings, mirroring
// XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false }).
func (x *xlsxFile) readSheet(name string) ([][]string, error) {
	path, ok := x.sheetPath[name]
	if !ok {
		return nil, errf("worksheet \"" + name + "\" was not found")
	}
	rc, err := x.open(path)
	if err != nil {
		return nil, errf("worksheet \"" + name + "\" could not be opened")
	}
	defer rc.Close()

	shared := x.sharedStrings()
	dec := xml.NewDecoder(rc)
	rows := [][]string{}
	var cur []string
	colAt := 0
	inRow := false
	cellBuf := &strings.Builder{}
	cellType := ""
	cellInline := false

	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "row":
				inRow = true
				cur = nil
				colAt = 0
			case "c":
				if !inRow {
					continue
				}
				ref := attrValue(t, "r")
				cellType = attrValue(t, "t")
				cellInline = cellType == "inlineStr"
				colAt = columnIndexFromRef(ref, colAt)
				cellBuf.Reset()
			case "v", "t":
				if inRow {
					cellBuf.Reset()
				}
			}
		case xml.CharData:
			cellBuf.Write(t)
		case xml.EndElement:
			switch t.Name.Local {
			case "v", "t":
				if !inRow {
					continue
				}
				v := cellBuf.String()
				if cellInline {
					// inline string: the <t> inside <is> is the value
					if cellType == "inlineStr" {
						v = strings.TrimSpace(v)
					}
				} else if cellType == "s" {
					if idx, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && idx >= 0 && idx < len(shared) {
						v = shared[idx]
					} else {
						v = ""
					}
				} else if cellType == "b" {
					if strings.TrimSpace(v) == "1" {
						v = "TRUE"
					} else {
						v = "FALSE"
					}
				} else {
					v = formatNumber(v)
				}
				if cur == nil {
					cur = []string{}
				}
				for len(cur) <= colAt {
					cur = append(cur, "")
				}
				cur[colAt] = v
				cellBuf.Reset()
			case "c":
				if inRow && cur == nil {
					cur = []string{}
				}
				if inRow && cur != nil && len(cur) <= colAt {
					for len(cur) <= colAt {
						cur = append(cur, "")
					}
				}
			case "row":
				if inRow && cur != nil {
					any := false
					for _, v := range cur {
						if strings.TrimSpace(v) != "" {
							any = true
							break
						}
					}
					if any {
						rows = append(rows, cur)
					}
				}
				inRow = false
				cur = nil
			}
		}
	}
	return rows, nil
}

func (x *xlsxFile) open(path string) (io.ReadCloser, error) {
	for _, f := range x.zr.File {
		if f.Name == path {
			return f.Open()
		}
	}
	return nil, errf("missing part " + path)
}

// formatNumber keeps Excel's stored value readable: 1 stays "1", 1.5 stays
// "1.5", and a float that is really an integer is not printed as 1e+06.
func formatNumber(v string) string {
	t := strings.TrimSpace(v)
	if t == "" {
		return ""
	}
	if !strings.ContainsAny(t, ".eE") {
		return t
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return t
	}
	if f == float64(int64(f)) && f < 1e15 && f > -1e15 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// columnIndexFromRef turns "BC12" into the zero-based column 54, keeping the
// previous column when a cell has no reference attribute.
func columnIndexFromRef(ref string, fallback int) int {
	n := 0
	seen := false
	for _, r := range ref {
		if r >= 'A' && r <= 'Z' {
			n = n*26 + int(r-'A') + 1
			seen = true
		} else if r >= 'a' && r <= 'z' {
			n = n*26 + int(r-'a') + 1
			seen = true
		} else {
			break
		}
	}
	if !seen {
		return fallback
	}
	return n - 1
}

func attrValue(start xml.StartElement, name string) string {
	for _, a := range start.Attr {
		if a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}

func parseXlsx(data []byte, fileName, sheetName string) (*table, error) {
	x, err := openXlsx(data)
	if err != nil {
		return nil, err
	}
	target := sheetName
	if target == "" {
		target = x.order[0]
	}
	rows, err := x.readSheet(target)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, errf("worksheet \"" + target + "\" is empty")
	}
	head := rows[0]
	cols := make([]string, 0, len(head))
	for i, h := range head {
		name := strings.TrimSpace(h)
		if name == "" {
			name = "Column " + itoa(i+1)
		}
		cols = append(cols, name)
	}
	b := newTableBuilder(cols)
	for _, r := range rows[1:] {
		b.addRow(r)
	}
	t := b.table(fileName)
	t.SheetName = target
	t.SheetNames = x.sheetNames()
	return t, nil
}

func bytesToB64(v []byte) string {
	if len(v) == 0 {
		return ""
	}
	return base64.StdEncoding.EncodeToString(v)
}
