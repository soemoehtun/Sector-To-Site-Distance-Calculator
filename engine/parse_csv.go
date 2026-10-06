package main

import (
	"bytes"
	"encoding/csv"
	"strings"
	"unicode/utf8"
)

// table is the engine's columnar result. Every cell is returned as a string in
// one UTF-8 blob plus an offset table, which is what the app stores anyway
// (PapaParse runs with dynamicTyping off, and numeric conversion happens later
// in toNumber()), so no value semantics change.

type table struct {
	FileName   string   `json:"fileName"`
	Columns    []string `json:"columns"`
	Rows       int      `json:"rowCount"`
	BlobB64    string   `json:"blobB64"`
	OffsetsB64 string   `json:"offsetsB64"`
	ASCII      bool     `json:"ascii"`
	SheetName  string   `json:"sheetName,omitempty"`
	SheetNames []string `json:"sheetNames,omitempty"`
}

type tableBuilder struct {
	cols    []string
	blob    []byte
	offsets []int32
	count   int
	ascii   bool
}

func newTableBuilder(cols []string) *tableBuilder {
	return &tableBuilder{cols: cols, offsets: []int32{0}, ascii: true}
}

func (b *tableBuilder) addRow(values []string) {
	any := false
	for i := range b.cols {
		v := ""
		if i < len(values) {
			v = values[i]
		}
		if strings.TrimSpace(v) != "" {
			any = true
		}
		if !utf8.ValidString(v) {
			b.ascii = false
		}
		for j := 0; j < len(v); j++ {
			if v[j] >= 0x80 {
				b.ascii = false
				break
			}
		}
	}
	// PapaParse drops empty rows by default and the offsets table is what the
	// host walks to rebuild the rows, so a blank row must not be recorded at all.
	if !any {
		return
	}
	for i := range b.cols {
		v := ""
		if i < len(values) {
			v = values[i]
		}
		b.blob = append(b.blob, v...)
		b.offsets = append(b.offsets, int32(len(b.blob)))
	}
	b.count++
}

func (b *tableBuilder) table(fileName string) *table {
	offs := b.offsets
	if len(offs) == 0 || offs[0] != 0 {
		offs = append([]int32{0}, offs...)
	}
	return &table{
		FileName:   fileName,
		Columns:    b.cols,
		Rows:       b.count,
		BlobB64:    bytesToB64(b.blob),
		OffsetsB64: i32ToB64(offs),
		ASCII:      b.ascii,
	}
}

// ------------------------------------------------------------------ delimiter

// sniffDelimiter mirrors PapaParse's default: comma, with a fallback to
// semicolon, tab or pipe when the header line clearly has no commas.
func sniffDelimiter(data []byte) rune {
	end := bytes.IndexByte(data, '\n')
	if end < 0 {
		end = len(data)
	}
	line := data[:end]
	counts := map[rune]int{}
	for _, r := range string(line) {
		switch r {
		case ',', ';', '\t', '|':
			counts[r]++
		}
	}
	if counts[','] > 0 {
		return ','
	}
	best, bestN := rune(0), 0
	for _, r := range []rune{';', '\t', '|'} {
		if counts[r] > bestN {
			best, bestN = r, counts[r]
		}
	}
	if best == 0 {
		return ','
	}
	return best
}

func parseDelimited(data []byte, fileName string) (*table, error) {
	// Strip a UTF-8 BOM, which Excel exports add and PapaParse strips.
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})

	delim := sniffDelimiter(data)
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	r.ReuseRecord = true
	r.Comma = delim

	head, err := r.Read()
	if err != nil {
		return nil, errf("no columns found in file")
	}

	cols := make([]string, 0, len(head))
	for i, h := range head {
		name := strings.TrimSpace(h)
		if name == "" {
			name = "Column " + itoa(i+1)
		}
		cols = append(cols, name)
	}
	if len(cols) == 0 {
		return nil, errf("no columns found in file")
	}

	b := newTableBuilder(cols)
	for {
		rec, err := r.Read()
		if err != nil {
			break
		}
		b.addRow(rec)
	}
	return b.table(fileName), nil
}
