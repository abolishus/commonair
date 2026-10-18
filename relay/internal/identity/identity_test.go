// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package identity

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoadOrCreateReusesKey(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "data")
	first, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Created || len(first.PublicB64) != 43 {
		t.Fatalf("first start: created=%v pub=%q", first.Created, first.PublicB64)
	}
	if runtime.GOOS != "windows" {
		st, err := os.Stat(filepath.Join(dir, KeyFile))
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o600 {
			t.Fatalf("key mode %v, want 0600", st.Mode().Perm())
		}
		if Insecure(dir) {
			t.Fatal("fresh key reported insecure")
		}
	}
	second, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	if second.Created || second.PublicB64 != first.PublicB64 || !second.Private.Equal(first.Private) {
		t.Fatal("restart did not reuse the key")
	}
}

func TestLoadRejectsGarbage(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, KeyFile), []byte("not a key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreate(dir); err == nil {
		t.Fatal("garbage key accepted (and must not be overwritten)")
	}
	data, _ := os.ReadFile(filepath.Join(dir, KeyFile))
	if string(data) != "not a key" {
		t.Fatal("existing key file was overwritten")
	}
}
