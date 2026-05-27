// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

// Package boxlite — synchronous Export/Import bindings.
//
// Unlike the rest of the Go SDK (which uses the async post-and-drain pattern
// via CGo callbacks), Export and ImportBox block the calling goroutine until
// the Rust side returns. Two reasons:
//
//   1. They are one-shot heavy operations — there's no value in scheduling
//      multiple in parallel from the same Runtime.
//   2. apps/runner's scale-down path needs strict ordering (stop → export →
//      upload → ack), and a synchronous API is the lowest-friction shape.
//
// If you need a context-aware variant later, wrap these calls in a goroutine.

package boxlite

/*
#include <stdlib.h>
#include "bridge.h"
*/
import "C"

import (
	"context"
	"unsafe"
)

// Export writes this box to a portable `.boxlite` archive at destPath.
// Caller must stop the box first; calling on a running box errors out
// to avoid corrupt disks.
//
// Blocking: this call holds the calling goroutine until the Rust export
// completes. ctx is currently advisory — no cancellation mid-archive.
func (b *Box) Export(ctx context.Context, destPath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	cPath := C.CString(destPath)
	defer C.free(unsafe.Pointer(cPath))

	var cerr C.CBoxliteError
	code := C.boxlite_box_export(b.handle, cPath, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// ImportBox imports a `.boxlite` archive and returns a handle to the new box.
// The imported box starts in the Stopped state — caller must Start() it.
//
//   - name: optional new name for the imported box. Empty string = unnamed.
//   - id:   optional box id to use verbatim. Empty string = mint a fresh id.
//
// Use id="" unless you need the `sandbox.id == box.id` invariant (cold
// migration). The id must pass `BoxID::parse` validation on the Rust side
// (URL-safe, ≤128 chars), otherwise an InvalidArgument error is returned.
func (r *Runtime) ImportBox(ctx context.Context, archivePath, name, id string) (*Box, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	cArchive := C.CString(archivePath)
	defer C.free(unsafe.Pointer(cArchive))

	var cName *C.char
	if name != "" {
		cName = C.CString(name)
		defer C.free(unsafe.Pointer(cName))
	}
	var cID *C.char
	if id != "" {
		cID = C.CString(id)
		defer C.free(unsafe.Pointer(cID))
	}

	var outHandle *C.CBoxHandle
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_import_box(r.handle, cArchive, cName, cID, &outHandle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	return newBoxFromHandle(r, outHandle, name), nil
}
