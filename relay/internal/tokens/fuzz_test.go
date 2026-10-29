// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package tokens

import (
	"bytes"
	"crypto/ed25519"
	"strings"
	"testing"
	"time"
)

// A signed token must have exactly one textual form, so decoding then encoding is the identity.
func FuzzDecodeB64URL(f *testing.F) {
	for _, s := range []string{"", "AA", "AB", "AAA=", "a-_b", "YQ\n", "////"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		b, err := DecodeB64URL(s)
		if err != nil {
			return
		}
		if got := EncodeB64URL(b); got != s {
			t.Fatalf("decode(%q) re-encodes as %q", s, got)
		}
	})
}

// Tokens arrive from viewers. Nothing they send may panic, and only bodies the key signed pass.
func FuzzVerifyPlayback(f *testing.F) {
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))
	pub, ok := key.Public().(ed25519.PublicKey)
	if !ok {
		f.Fatal("ed25519 public key has an unexpected type")
	}
	now := time.Unix(1_800_000_000, 0)
	sign := func(body string) string {
		return EncodeB64URL([]byte(body)) + "." + EncodeB64URL(ed25519.Sign(key, []byte(body)))
	}
	f.Add(sign(`{"v":1,"sid":"0190a0b0-0000-7000-8000-000000000001","cid":"0190a0b0-0000-7000-8000-000000000002","path":"live/alice","src":"origin","iat":1800000000,"exp":1800000600}`))
	f.Add(sign(`{"v":1}`))
	f.Add(sign(`not json`))
	f.Add("a.b.c")
	f.Add(".")
	f.Fuzz(func(t *testing.T, token string) {
		_, err := VerifyPlayback(pub, token, now, 30*time.Second)
		if err != nil {
			return
		}
		body, sig, _ := strings.Cut(token, ".")
		b, _ := DecodeB64URL(body)
		s, _ := DecodeB64URL(sig)
		if !ed25519.Verify(pub, b, s) {
			t.Fatalf("accepted a token the key did not sign: %q", token)
		}
	})
}
