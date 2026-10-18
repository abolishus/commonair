// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package identity manages the relay's long-lived Ed25519 receipt-signing key.
package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/abolishus/commonair/relay/internal/tokens"
)

// KeyFile is the key's file name inside the data directory.
const KeyFile = "relay.key"

// Key is the relay's signing identity.
type Key struct {
	Private ed25519.PrivateKey
	// PublicB64 is the raw 32-byte public key in base64url (43 chars), as register expects.
	PublicB64 string
	// Created reports whether this call generated a new key.
	Created bool
}

// LoadOrCreate reads dataDir/relay.key (PKCS#8 PEM) or generates one on first
// start. The key file is created exclusively with mode 0600 so two relays
// sharing a data directory cannot silently overwrite each other's identity.
func LoadOrCreate(dataDir string) (Key, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return Key{}, fmt.Errorf("create data dir: %w", err)
	}
	path := filepath.Join(dataDir, KeyFile)
	k, err := load(path)
	if err == nil {
		return k, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return Key{}, err
	}
	k, err = create(path)
	if errors.Is(err, fs.ErrExist) {
		// Lost a race with a concurrent start; use the winner's key.
		return load(path)
	}
	return k, err
}

func load(path string) (Key, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Key{}, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" {
		return Key{}, fmt.Errorf("%s: not a PKCS#8 PEM private key", path)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return Key{}, fmt.Errorf("%s: %w", path, err)
	}
	priv, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return Key{}, fmt.Errorf("%s: not an Ed25519 key", path)
	}
	return fromPrivate(priv, false), nil
}

func create(path string) (Key, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return Key{}, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return Key{}, err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Key{}, err
	}
	if err := pem.Encode(f, &pem.Block{Type: "PRIVATE KEY", Bytes: der}); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return Key{}, err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return Key{}, err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return Key{}, err
	}
	return fromPrivate(priv, true), nil
}

func fromPrivate(priv ed25519.PrivateKey, created bool) Key {
	pub, _ := priv.Public().(ed25519.PublicKey)
	return Key{Private: priv, PublicB64: tokens.EncodeB64URL(pub), Created: created}
}

// Insecure reports whether the key file is readable by group or others.
func Insecure(dataDir string) bool {
	st, err := os.Stat(filepath.Join(dataDir, KeyFile))
	return err == nil && st.Mode().Perm()&0o077 != 0
}
