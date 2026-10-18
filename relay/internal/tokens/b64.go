// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package tokens is the Go side of the CommonAir token formats
// (packages/contracts/src/tokens.ts): verifying origin-signed playback tokens
// and signing relay bandwidth receipts. Both are pinned against
// packages/tokens/vectors.json.
package tokens

import (
	"encoding/base64"
	"errors"
)

var errBase64 = errors.New("invalid base64url")

// EncodeB64URL encodes without padding (RFC 4648 §5), like Buffer "base64url".
func EncodeB64URL(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

// DecodeB64URL is a strict base64url decoder: it rejects padding, characters
// outside the URL-safe alphabet (Go's decoder would otherwise skip CR/LF) and
// non-canonical encodings (non-zero trailing bits), so a signed token has
// exactly one textual form.
func DecodeB64URL(s string) ([]byte, error) {
	if len(s)%4 == 1 {
		return nil, errBase64
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		ok := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_'
		if !ok {
			return nil, errBase64
		}
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil {
		return nil, errBase64
	}
	if EncodeB64URL(b) != s {
		return nil, errBase64
	}
	return b, nil
}
