//go:build js && wasm

package main

import (
	"encoding/json"
	"strings"
	"syscall/js"
)

// The engine is exposed on globalThis as __site2site with JSON in / JSON out.
// Every entry point is synchronous: the host runs it inside a Web Worker, so
// blocking is fine and the wasm module never has to deal with promises.
//
// Errors are reported by returning null and setting __site2siteError, because a
// Go function called from JS cannot throw across the wasm boundary. Wrapping
// successes in an envelope would copy large payloads twice, so the wrapper
// checks for null instead.

type engineAPI struct {
	sess session
}

var api = &engineAPI{}

const errGlobal = "__site2siteError"

func setErr(err error) {
	msg := "engine error"
	if err != nil {
		msg = err.Error()
	}
	js.Global().Set(errGlobal, msg)
}

func clearErr() {
	js.Global().Set(errGlobal, "")
}

func main() {
	js.Global().Set("__site2site", js.ValueOf(map[string]any{
		"setup":        js.FuncOf(api.setup),
		"calc":         js.FuncOf(api.calc),
		"parseText":    js.FuncOf(api.parseText),
		"parseXlsx":    js.FuncOf(api.parseXlsx),
		"parseKml":     js.FuncOf(api.parseKml),
		"parseGpx":     js.FuncOf(api.parseGpx),
		"voronoiCells": js.FuncOf(api.voronoiCells),
		"voronoiEdges": js.FuncOf(api.voronoiEdges),
		"cellsFor":     js.FuncOf(api.cellsFor),
		"buildKmz":     js.FuncOf(api.buildKmz),
		"buildXlsx":    js.FuncOf(api.buildXlsx),
		"version":      "1",
	}))
	<-make(chan struct{})
}

// argStr returns argument i as a string. Objects are stringified with JSON so
// the JS side can pass plain literals; Value.String() would give "[object
// Object]".
func argStr(args []js.Value, i int) string {
	if i >= len(args) {
		return ""
	}
	v := args[i]
	if v.Type() == js.TypeObject {
		if s := js.Global().Get("JSON").Call("stringify", v); s.Type() == js.TypeString {
			return s.String()
		}
		return ""
	}
	return v.String()
}

func arg(args []js.Value, i int) string {
	if i >= len(args) {
		return ""
	}
	return args[i].String()
}

func argBytes(args []js.Value, i int) []byte {
	if i >= len(args) {
		return nil
	}
	view := js.Global().Get("Uint8Array").New(args[i])
	out := make([]byte, view.Length())
	js.CopyBytesToGo(out, view)
	return out
}

func unmarshalArg(args []js.Value, dst any) error {
	return json.Unmarshal([]byte(argStr(args, 0)), dst)
}

func marshalOrFail(v any) any {
	out, err := json.Marshal(v)
	if err != nil {
		setErr(err)
		return nil
	}
	return string(out)
}

func (a *engineAPI) setup(_ js.Value, args []js.Value) any {
	var req setupRequest
	if err := unmarshalArg(args, &req); err != nil {
		setErr(err)
		return nil
	}
	if err := a.sess.setup(req); err != nil {
		setErr(err)
		return nil
	}
	clearErr()
	return true
}

func (a *engineAPI) calc(_ js.Value, args []js.Value) any {
	var req calcRequest
	if err := unmarshalArg(args, &req); err != nil {
		setErr(err)
		return nil
	}
	res, err := a.sess.calcRange(req, nil)
	if err != nil {
		setErr(err)
		return nil
	}
	out, err := json.Marshal(res)
	if err != nil {
		setErr(err)
		return nil
	}
	clearErr()
	return string(out)
}

func tableResult(t *table) any {
	out, err := json.Marshal(t)
	if err != nil {
		setErr(err)
		return nil
	}
	return string(out)
}

func (a *engineAPI) parseText(_ js.Value, args []js.Value) any {
	tbl, err := parseDelimited(argBytes(args, 0), arg(args, 1))
	if err != nil {
		setErr(err)
		return nil
	}
	clearErr()
	return tableResult(tbl)
}

func (a *engineAPI) parseXlsx(_ js.Value, args []js.Value) any {
	tbl, err := parseXlsx(argBytes(args, 0), arg(args, 1), arg(args, 2))
	if err != nil {
		setErr(err)
		return nil
	}
	clearErr()
	return tableResult(tbl)
}

func (a *engineAPI) parseKml(_ js.Value, args []js.Value) any {
	points, err := readKmlPoints(strings.NewReader(string(argBytes(args, 0))))
	if err != nil {
		setErr(err)
		return nil
	}
	tbl, err := pointsToTable(points, arg(args, 1))
	if err != nil {
		setErr(err)
		return nil
	}
	clearErr()
	return tableResult(tbl)
}

func (a *engineAPI) parseGpx(_ js.Value, args []js.Value) any {
	points, err := readGpxPoints(strings.NewReader(string(argBytes(args, 0))))
	if err != nil {
		setErr(err)
		return nil
	}
	tbl, err := pointsToTable(points, arg(args, 1))
	if err != nil {
		setErr(err)
		return nil
	}
	clearErr()
	return tableResult(tbl)
}

func (a *engineAPI) voronoiCells(_ js.Value, args []js.Value) any {
	var req geomRequest
	if err := unmarshalArg(args, &req); err != nil {
		setErr(err)
		return nil
	}
	res, err := cellsFor(req)
	if err != nil {
		setErr(err)
		return nil
	}
	clearErr()
	return marshalOrFail(res)
}

func (a *engineAPI) voronoiEdges(_ js.Value, args []js.Value) any {
	var req geomRequest
	if err := unmarshalArg(args, &req); err != nil {
		setErr(err)
		return nil
	}
	res, err := edgesFor(req)
	if err != nil {
		setErr(err)
		return nil
	}
	clearErr()
	return marshalOrFail(res)
}

func (a *engineAPI) cellsFor(_ js.Value, args []js.Value) any {
	var req cellForSiteRequest
	if err := unmarshalArg(args, &req); err != nil {
		setErr(err)
		return nil
	}
	res, err := cellsForSites(req)
	if err != nil {
		setErr(err)
		return nil
	}
	clearErr()
	return marshalOrFail(res)
}

func (a *engineAPI) buildKmz(_ js.Value, args []js.Value) any {
	var req kmzOptions
	if err := unmarshalArg(args, &req); err != nil {
		setErr(err)
		return nil
	}
	out, err := buildKmz(req)
	if err != nil {
		setErr(err)
		return nil
	}
	clearErr()
	return bytesToB64(out)
}

func (a *engineAPI) buildXlsx(_ js.Value, args []js.Value) any {
	var req xlsxRequest
	if err := unmarshalArg(args, &req); err != nil {
		setErr(err)
		return nil
	}
	out, err := buildXlsx(req)
	if err != nil {
		setErr(err)
		return nil
	}
	clearErr()
	return bytesToB64(out)
}
