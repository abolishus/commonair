// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package tokens

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"regexp"
)

// The signed relay purge batch (batch 7 decision (x), ADR 0016 Amendment 1),
// mirroring packages/tokens/src/purge.ts: the answer to
// GET /api/relay/purges?after=<seq>, signed by the origin playback key the
// relay already holds as originPublicKey. Pinned by vectors.json (purge).

// PurgeBatchMaxItems mirrors PURGE_BATCH_MAX_ITEMS.
const PurgeBatchMaxItems = 500

// PurgePrefixMaxLength mirrors PURGE_PREFIX_MAX_LENGTH.
const PurgePrefixMaxLength = 256

var (
	purgePrefixRE = regexp.MustCompile(`^(?:live|dvr)/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*/)+$`)
	purgeReasonRE = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
)

// ErrNonCanonical means the signature is good but the payload bytes are not the
// canonical encoding of what they parse to.
var ErrNonCanonical = errors.New("non-canonical payload")

// PurgeItem is one evicted path prefix ("dvr/<vodId>/", "live/<slug>/", ...).
type PurgeItem struct {
	Seq    int64  `json:"seq"`
	Prefix string `json:"prefix"`
	Reason string `json:"reason"`
}

// PurgeBatch is the signed payload. Seq is the cursor for the next request:
// the last item's seq, or the request's `after` when Items is empty. Field
// order is the payload's byte order.
//
// Reset (present in the payload only when true) answers a relay whose cursor
// is older than the retained rows: it carries no items, and the relay evicts
// every cached live/ and dvr/ object, then continues from Seq.
type PurgeBatch struct {
	Seq   int64       `json:"seq"`
	Items []PurgeItem `json:"items"`
	Reset bool        `json:"reset,omitempty"`
}

// SignedPurgeBatch is the envelope: base64url payload bytes and signature.
type SignedPurgeBatch struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

// Validate applies the contract's schema rules.
func (b PurgeBatch) Validate() error {
	if b.Seq < 0 || b.Seq > maxSafeInt || len(b.Items) > PurgeBatchMaxItems || (b.Reset && len(b.Items) > 0) {
		return ErrMalformed
	}
	for i, it := range b.Items {
		if it.Seq < 1 || it.Seq > maxSafeInt || len(it.Prefix) > PurgePrefixMaxLength ||
			!purgePrefixRE.MatchString(it.Prefix) || !purgeReasonRE.MatchString(it.Reason) {
			return ErrMalformed
		}
		if i > 0 && it.Seq <= b.Items[i-1].Seq {
			return ErrMalformed
		}
	}
	if n := len(b.Items); n > 0 && b.Items[n-1].Seq != b.Seq {
		return ErrMalformed
	}
	return nil
}

// MarshalPurgeBatch produces the canonical payload bytes (JSON.stringify's).
func MarshalPurgeBatch(b PurgeBatch) ([]byte, error) {
	if b.Items == nil {
		b.Items = []PurgeItem{}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(b); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// SignPurgeBatch signs a batch with the origin key. The platform signs in
// TypeScript; this exists for tests and tools.
func SignPurgeBatch(key ed25519.PrivateKey, b PurgeBatch) (SignedPurgeBatch, error) {
	if err := b.Validate(); err != nil {
		return SignedPurgeBatch{}, err
	}
	payload, err := MarshalPurgeBatch(b)
	if err != nil {
		return SignedPurgeBatch{}, err
	}
	return SignedPurgeBatch{Payload: EncodeB64URL(payload), Signature: EncodeB64URL(ed25519.Sign(key, payload))}, nil
}

// VerifyPurgeBatch checks the signature with the origin public key, then the
// schema, then that the bytes are canonical. Errors: ErrMalformed,
// ErrBadSignature, ErrNonCanonical.
func VerifyPurgeBatch(pub ed25519.PublicKey, s SignedPurgeBatch) (PurgeBatch, error) {
	payload, err := DecodeB64URL(s.Payload)
	if err != nil {
		return PurgeBatch{}, ErrMalformed
	}
	sig, err := DecodeB64URL(s.Signature)
	if err != nil {
		return PurgeBatch{}, ErrMalformed
	}
	if len(pub) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize || !ed25519.Verify(pub, payload, sig) {
		return PurgeBatch{}, ErrBadSignature
	}
	// Both keys must be present and items must be an array, as the strict zod schema requires.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(payload, &raw); err != nil || raw == nil {
		return PurgeBatch{}, ErrMalformed
	}
	items, hasItems := raw["items"]
	if _, hasSeq := raw["seq"]; !hasSeq || !hasItems || len(items) == 0 || items[0] != '[' {
		return PurgeBatch{}, ErrMalformed
	}
	// The TS schema is z.literal(true).optional(): false, null or a string is malformed, not
	// merely non-canonical (which a bool would otherwise make it).
	if reset, has := raw["reset"]; has && string(reset) != "true" {
		return PurgeBatch{}, ErrMalformed
	}
	var b PurgeBatch
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil || dec.More() {
		return PurgeBatch{}, ErrMalformed
	}
	if err := b.Validate(); err != nil {
		return PurgeBatch{}, err
	}
	canonical, err := MarshalPurgeBatch(b)
	if err != nil || !bytes.Equal(canonical, payload) {
		return PurgeBatch{}, ErrNonCanonical
	}
	return b, nil
}
