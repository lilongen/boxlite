// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package boxlite

import "testing"

// TestIsBackupRef pins the backup-ref classifier: a ref is a backup archive iff
// it is an s3:// URL or its image *name* (final path segment, before the tag)
// starts with `backup-`. The intermediate-segment case is the regression the
// tightening fixes — the old strings.Contains(ref, "/backup-") matched it.
func TestIsBackupRef(t *testing.T) {
	cases := []struct {
		name string
		ref  string
		want bool
	}{
		{"s3 url", "s3://boxlite/abc.boxlite", true},
		{"backup image name", "reg.io/boxlite/backup-abc123:1700000000", true},
		{"backup image name no tag", "reg.io/boxlite/backup-abc123", true},
		{"plain oci image", "docker.io/library/ubuntu:24.04", false},
		{"oci image named ubuntu", "ubuntu:latest", false},
		// Regression: a registry/project path segment starting with `backup-`
		// must NOT classify a normal image as a backup archive.
		{"backup- in intermediate segment", "reg.io/backup-team/myimage:1", false},
		{"backup- in registry host", "backup-registry.io/proj/myimage:1", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isBackupRef(tc.ref); got != tc.want {
				t.Errorf("isBackupRef(%q) = %v, want %v", tc.ref, got, tc.want)
			}
		})
	}
}
