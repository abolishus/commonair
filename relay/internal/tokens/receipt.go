// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package tokens

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"time"
)

// ReceiptEntry mirrors ReceiptEntry in packages/contracts/src/shapes.ts.
type ReceiptEntry struct {
	SessionID string `json:"sessionId"`
	Segments  int64  `json:"segments"`
	Bytes     int64  `json:"bytes"`
}

// ReceiptPayload mirrors ReceiptPayload. Field order matters only for
// reproducing the shared vector; verifiers check the exact signed bytes.
type ReceiptPayload struct {
	V           int            `json:"v"`
	RelayID     string         `json:"relayId"`
	Nonce       string         `json:"nonce"`
	PeriodStart string         `json:"periodStart"`
	PeriodEnd   string         `json:"periodEnd"`
	Entries     []ReceiptEntry `json:"entries"`
}

// MaxReceiptEntries is the contract's per-receipt limit.
const MaxReceiptEntries = 50_000

// SignedReceipt is the body of POST /api/relay/receipts.
type SignedReceipt struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

// ISOTime formats like JavaScript's Date.prototype.toISOString (UTC, milliseconds).
func ISOTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// NewNonce returns 32 hex characters (128 random bits), within the contract's 16–64.
func NewNonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// MarshalReceipt produces the payload bytes the relay signs: the same JSON
// JSON.stringify emits for this shape (no HTML escaping, no trailing newline).
func MarshalReceipt(p ReceiptPayload) ([]byte, error) {
	if p.Entries == nil {
		p.Entries = []ReceiptEntry{}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(p); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// SignReceipt signs the exact payload bytes with the relay key.
func SignReceipt(key ed25519.PrivateKey, p ReceiptPayload) (SignedReceipt, error) {
	b, err := MarshalReceipt(p)
	if err != nil {
		return SignedReceipt{}, err
	}
	return SignReceiptBytes(key, b), nil
}

// SignReceiptBytes signs already-serialized payload bytes.
func SignReceiptBytes(key ed25519.PrivateKey, payload []byte) SignedReceipt {
	return SignedReceipt{Payload: EncodeB64URL(payload), Signature: EncodeB64URL(ed25519.Sign(key, payload))}
}

// VerifyReceipt checks a signed receipt against a relay public key and returns
// the decoded payload bytes. The relay uses it to validate receipts it reloads
// from disk; the platform has its own implementation.
func VerifyReceipt(pub ed25519.PublicKey, r SignedReceipt) ([]byte, bool) {
	payload, err := DecodeB64URL(r.Payload)
	if err != nil {
		return nil, false
	}
	sig, err := DecodeB64URL(r.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, false
	}
	return payload, ed25519.Verify(pub, payload, sig)
}
