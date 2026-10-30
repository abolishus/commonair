// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package tokens

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// DefaultSkew tolerates small clock differences between the origin and relays.
const DefaultSkew = 30 * time.Second

// Token verification failures. Callers map them to HTTP statuses; the reason
// never reaches logs together with the token itself.
var (
	ErrMalformed    = errors.New("malformed token")
	ErrBadSignature = errors.New("bad token signature")
	ErrExpired      = errors.New("token expired")
	ErrNotYetValid  = errors.New("token not yet valid")
)

// Delivery sources (packages/contracts/src/enums.ts DELIVERY_SOURCES).
var deliverySources = map[string]bool{"origin": true, "relay": true, "p2p": true, "cdn": true}

// Same shape Zod's z.uuid() accepts (RFC 9562 versions 1-8, variant 10xx, nil and max).
var uuidRE = regexp.MustCompile(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$`)

// IsUUID reports whether s is a UUID in the form the contracts accept.
func IsUUID(s string) bool { return uuidRE.MatchString(s) }

// PlaybackClaims mirrors PlaybackClaims in packages/contracts/src/tokens.ts.
type PlaybackClaims struct {
	V    int
	SID  string
	CID  string
	Path string
	Src  string
	// RID is empty unless Src is "relay".
	RID string
	// DM is the data-mode ceiling in bit/s: 0 when absent; set only on origin live tokens (ADR 0018).
	DM  int64
	IAT int64
	EXP int64
}

// VerifyPlayback checks the token's signature with the origin public key, the
// claims schema, and expiry/issued-at with the given skew. It does not check
// src/rid/path binding; see Binding.Check.
func VerifyPlayback(pub ed25519.PublicKey, token string, now time.Time, skew time.Duration) (PlaybackClaims, error) {
	body, sig, ok := strings.Cut(token, ".")
	if !ok || body == "" || sig == "" || strings.Contains(sig, ".") {
		return PlaybackClaims{}, ErrMalformed
	}
	bodyBytes, err := DecodeB64URL(body)
	if err != nil {
		return PlaybackClaims{}, ErrMalformed
	}
	sigBytes, err := DecodeB64URL(sig)
	if err != nil {
		return PlaybackClaims{}, ErrMalformed
	}
	if len(pub) != ed25519.PublicKeySize || len(sigBytes) != ed25519.SignatureSize || !ed25519.Verify(pub, bodyBytes, sigBytes) {
		return PlaybackClaims{}, ErrBadSignature
	}
	claims, err := parseClaims(bodyBytes)
	if err != nil {
		return PlaybackClaims{}, ErrMalformed
	}
	nowS := now.Unix()
	skewS := int64(skew / time.Second)
	if claims.EXP+skewS < nowS {
		return PlaybackClaims{}, ErrExpired
	}
	if claims.IAT-skewS > nowS {
		return PlaybackClaims{}, ErrNotYetValid
	}
	return claims, nil
}

func parseClaims(b []byte) (PlaybackClaims, error) {
	var raw map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(b))
	if err := dec.Decode(&raw); err != nil || raw == nil {
		return PlaybackClaims{}, ErrMalformed
	}
	if dec.More() {
		return PlaybackClaims{}, ErrMalformed
	}
	var c PlaybackClaims
	v, err := jsonInt(raw["v"])
	if err != nil || v != 1 {
		return c, ErrMalformed
	}
	c.V = 1
	if c.SID, err = jsonString(raw["sid"]); err != nil || !IsUUID(c.SID) {
		return c, ErrMalformed
	}
	if c.CID, err = jsonString(raw["cid"]); err != nil || !IsUUID(c.CID) {
		return c, ErrMalformed
	}
	if c.Path, err = jsonString(raw["path"]); err != nil {
		return c, ErrMalformed
	}
	if c.Src, err = jsonString(raw["src"]); err != nil || !deliverySources[c.Src] {
		return c, ErrMalformed
	}
	if rid, present := raw["rid"]; present {
		if c.RID, err = jsonString(rid); err != nil || !IsUUID(c.RID) {
			return c, ErrMalformed
		}
	}
	// The contract's refine: rid is required exactly when src is relay.
	if (c.Src == "relay") != (c.RID != "") {
		return c, ErrMalformed
	}
	// The contract's second refine (ADR 0018): dm only on origin tokens for a live path.
	if dm, present := raw["dm"]; present {
		if c.DM, err = jsonInt(dm); err != nil || c.DM < 32000 || c.DM > 8000000 {
			return c, ErrMalformed
		}
		if c.Src != "origin" || strings.HasPrefix(c.Path, "vod/") {
			return c, ErrMalformed
		}
	}
	if c.IAT, err = jsonInt(raw["iat"]); err != nil {
		return c, ErrMalformed
	}
	if c.EXP, err = jsonInt(raw["exp"]); err != nil {
		return c, ErrMalformed
	}
	return c, nil
}

func jsonString(m json.RawMessage) (string, error) {
	if len(m) == 0 || m[0] != '"' {
		return "", ErrMalformed
	}
	var s string
	if err := json.Unmarshal(m, &s); err != nil {
		return "", ErrMalformed
	}
	return s, nil
}

// jsonInt accepts any JSON number that is an integer within JavaScript's safe
// range (what z.number().int() accepts), including forms such as 1e3 or 1.0.
func jsonInt(m json.RawMessage) (int64, error) {
	if len(m) == 0 || !(m[0] == '-' || (m[0] >= '0' && m[0] <= '9')) {
		return 0, ErrMalformed
	}
	if n, err := strconv.ParseInt(string(m), 10, 64); err == nil {
		if n > maxSafeInt || n < -maxSafeInt {
			return 0, ErrMalformed
		}
		return n, nil
	}
	f, err := strconv.ParseFloat(string(m), 64)
	if err != nil || math.Trunc(f) != f || math.Abs(f) > maxSafeInt {
		return 0, ErrMalformed
	}
	return int64(f), nil
}

const maxSafeInt = 1<<53 - 1

// Binding is what a relay requires of a viewer token beyond a valid signature.
type Binding struct {
	RelayID string
}

// ErrBinding means the token is genuine but not valid for this relay or path.
var ErrBinding = errors.New("token not valid for this relay or path")

// Check enforces src=relay, rid=this relay, and that hlsPath (for example
// "live/alice/720p/index.m3u8") lies strictly under the token's path.
func (b Binding) Check(c PlaybackClaims, hlsPath string) error {
	if c.Src != "relay" || c.RID == "" || !strings.EqualFold(c.RID, b.RelayID) {
		return ErrBinding
	}
	if c.Path == "" || !strings.HasPrefix(hlsPath, c.Path+"/") || len(hlsPath) == len(c.Path)+1 {
		return ErrBinding
	}
	return nil
}

// ParsePublicKey accepts the origin's Ed25519 public key as raw 32 bytes in
// base64url (the contract's form) or, defensively, as standard-base64 SPKI DER.
func ParsePublicKey(s string) (ed25519.PublicKey, error) {
	if raw, err := DecodeB64URL(s); err == nil && len(raw) == ed25519.PublicKeySize {
		return ed25519.PublicKey(raw), nil
	}
	der, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, errors.New("origin public key is neither raw base64url nor SPKI")
	}
	pk, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	ed, ok := pk.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("origin public key is not Ed25519")
	}
	return ed, nil
}
