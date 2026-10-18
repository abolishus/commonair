// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package tokens

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

type vectorFile struct {
	PrivateKeyPkcs8 string `json:"privateKeyPkcs8"`
	PublicKey       string `json:"publicKey"`
	Playback        struct {
		Claims map[string]any `json:"claims"`
		Token  string         `json:"token"`
	} `json:"playback"`
	Receipt struct {
		Payload ReceiptPayload `json:"payload"`
		Signed  SignedReceipt  `json:"signed"`
	} `json:"receipt"`
}

func loadVectors(t *testing.T) (vectorFile, ed25519.PrivateKey, ed25519.PublicKey) {
	t.Helper()
	raw, err := os.ReadFile("../../../packages/tokens/vectors.json")
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	der, err := base64.StdEncoding.DecodeString(v.PrivateKeyPkcs8)
	if err != nil {
		t.Fatal(err)
	}
	k, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		t.Fatal(err)
	}
	priv := k.(ed25519.PrivateKey)
	pub, err := ParsePublicKey(v.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if !pub.Equal(priv.Public()) {
		t.Fatal("vector public key does not match private key")
	}
	return v, priv, pub
}

// vectorNow is inside the vector token's validity window.
var vectorNow = time.Unix(1700000060, 0)

func sign(priv ed25519.PrivateKey, claims map[string]any) string {
	b, _ := json.Marshal(claims)
	return EncodeB64URL(b) + "." + EncodeB64URL(ed25519.Sign(priv, b))
}

func cloneClaims(c map[string]any) map[string]any {
	out := make(map[string]any, len(c))
	for k, v := range c {
		out[k] = v
	}
	return out
}

func TestVerifyPlaybackVector(t *testing.T) {
	v, _, pub := loadVectors(t)
	c, err := VerifyPlayback(pub, v.Playback.Token, vectorNow, DefaultSkew)
	if err != nil {
		t.Fatalf("vector token rejected: %v", err)
	}
	want := PlaybackClaims{
		V: 1, SID: "01890000-0000-7000-8000-000000000001", CID: "01890000-0000-7000-8000-000000000002",
		Path: "live/alice", Src: "relay", RID: "01890000-0000-7000-8000-000000000003",
		IAT: 1700000000, EXP: 1700000120,
	}
	if c != want {
		t.Fatalf("claims = %+v, want %+v", c, want)
	}
	b := Binding{RelayID: want.RID}
	if err := b.Check(c, "live/alice/index.m3u8"); err != nil {
		t.Fatalf("binding: %v", err)
	}
	if err := b.Check(c, "live/alice/720p/seg1.mp4"); err != nil {
		t.Fatalf("rendition binding: %v", err)
	}
}

func TestVerifyPlaybackTampered(t *testing.T) {
	v, _, pub := loadVectors(t)
	body, sig, _ := strings.Cut(v.Playback.Token, ".")
	claims, _ := DecodeB64URL(body)
	tampered := strings.Replace(string(claims), "live/alice", "live/mallo", 1)
	cases := map[string]string{
		"body":          EncodeB64URL([]byte(tampered)) + "." + sig,
		"signature":     body + "." + flipFirst(sig),
		"no dot":        body,
		"empty sig":     body + ".",
		"extra segment": v.Playback.Token + ".x",
		"empty":         "",
	}
	for name, tok := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := VerifyPlayback(pub, tok, vectorNow, DefaultSkew); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	otherPub, _, _ := ed25519.GenerateKey(nil)
	if _, err := VerifyPlayback(otherPub, v.Playback.Token, vectorNow, DefaultSkew); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("wrong key: %v", err)
	}
}

func flipFirst(s string) string {
	if s[0] == 'A' {
		return "B" + s[1:]
	}
	return "A" + s[1:]
}

func TestVerifyPlaybackExpiry(t *testing.T) {
	v, _, pub := loadVectors(t)
	tok := v.Playback.Token
	// exp 1700000120 + 30 s skew is the last accepted second.
	if _, err := VerifyPlayback(pub, tok, time.Unix(1700000150, 0), DefaultSkew); err != nil {
		t.Fatalf("within skew: %v", err)
	}
	if _, err := VerifyPlayback(pub, tok, time.Unix(1700000151, 0), DefaultSkew); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired: %v", err)
	}
	if _, err := VerifyPlayback(pub, tok, time.Unix(1699999970, 0), DefaultSkew); err != nil {
		t.Fatalf("early within skew: %v", err)
	}
	if _, err := VerifyPlayback(pub, tok, time.Unix(1699999969, 0), DefaultSkew); !errors.Is(err, ErrNotYetValid) {
		t.Fatalf("not yet valid: %v", err)
	}
}

func TestBinding(t *testing.T) {
	v, _, pub := loadVectors(t)
	c, err := VerifyPlayback(pub, v.Playback.Token, vectorNow, DefaultSkew)
	if err != nil {
		t.Fatal(err)
	}
	if err := (Binding{RelayID: "01890000-0000-7000-8000-000000000009"}).Check(c, "live/alice/index.m3u8"); !errors.Is(err, ErrBinding) {
		t.Fatalf("wrong rid accepted: %v", err)
	}
	b := Binding{RelayID: c.RID}
	for _, p := range []string{"live/bob/index.m3u8", "live/alicex/index.m3u8", "live/alice", "live/alice/", "live/index.m3u8"} {
		if err := b.Check(c, p); !errors.Is(err, ErrBinding) {
			t.Fatalf("path %q accepted", p)
		}
	}
	origin := c
	origin.Src, origin.RID = "origin", ""
	if err := b.Check(origin, "live/alice/index.m3u8"); !errors.Is(err, ErrBinding) {
		t.Fatal("src=origin accepted")
	}
}

func TestClaimsSchema(t *testing.T) {
	v, priv, pub := loadVectors(t)
	base := v.Playback.Claims
	mutate := func(f func(m map[string]any)) string {
		m := cloneClaims(base)
		f(m)
		return sign(priv, m)
	}
	bad := map[string]string{
		"v=2":             mutate(func(m map[string]any) { m["v"] = 2 }),
		"v string":        mutate(func(m map[string]any) { m["v"] = "1" }),
		"sid not uuid":    mutate(func(m map[string]any) { m["sid"] = "abc" }),
		"cid missing":     mutate(func(m map[string]any) { delete(m, "cid") }),
		"path number":     mutate(func(m map[string]any) { m["path"] = 5 }),
		"src unknown":     mutate(func(m map[string]any) { m["src"] = "peer" }),
		"relay no rid":    mutate(func(m map[string]any) { delete(m, "rid") }),
		"origin with rid": mutate(func(m map[string]any) { m["src"] = "origin" }),
		"exp fractional":  mutate(func(m map[string]any) { m["exp"] = 1700000120.5 }),
		"iat missing":     mutate(func(m map[string]any) { delete(m, "iat") }),
		"rid null":        mutate(func(m map[string]any) { m["rid"] = nil }),
	}
	for name, tok := range bad {
		t.Run(name, func(t *testing.T) {
			if _, err := VerifyPlayback(pub, tok, vectorNow, DefaultSkew); !errors.Is(err, ErrMalformed) {
				t.Fatalf("got %v, want ErrMalformed", err)
			}
		})
	}
	// Unknown keys are stripped by the contract's (non-strict) object schema.
	extra := mutate(func(m map[string]any) { m["extra"] = true })
	if _, err := VerifyPlayback(pub, extra, vectorNow, DefaultSkew); err != nil {
		t.Fatalf("extra key: %v", err)
	}
	notJSON := EncodeB64URL([]byte("[1]")) + "." + EncodeB64URL(ed25519.Sign(priv, []byte("[1]")))
	if _, err := VerifyPlayback(pub, notJSON, vectorNow, DefaultSkew); !errors.Is(err, ErrMalformed) {
		t.Fatalf("array claims: %v", err)
	}
}

func TestMalleableBase64Rejected(t *testing.T) {
	v, _, pub := loadVectors(t)
	body, sig, _ := strings.Cut(v.Playback.Token, ".")
	// The signature is 64 bytes = 86 chars with 4 unused trailing bits.
	last := sig[len(sig)-1]
	alt := strings.IndexByte(alphabet, last) ^ 1
	variants := map[string]string{
		"padded signature":   body + "." + sig + "==",
		"padded body":        body + "=." + sig,
		"std alphabet":       strings.NewReplacer("-", "+", "_", "/").Replace(body) + "." + strings.NewReplacer("-", "+", "_", "/").Replace(sig),
		"newline in body":    body[:10] + "\n" + body[10:] + "." + sig,
		"space":              body + " ." + sig,
		"non-canonical bits": body + "." + sig[:len(sig)-1] + string(alphabet[alt]),
	}
	for name, tok := range variants {
		t.Run(name, func(t *testing.T) {
			if tok == v.Playback.Token {
				t.Skip("variant identical to the original")
			}
			if _, err := VerifyPlayback(pub, tok, vectorNow, DefaultSkew); err == nil {
				t.Fatal("accepted a malleable variant")
			}
		})
	}
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

func TestDecodeB64URL(t *testing.T) {
	good := map[string]string{"": "", "Zg": "f", "Zm8": "fo", "Zm9v": "foo", "-_8": "\xfb\xff"}
	for in, want := range good {
		got, err := DecodeB64URL(in)
		if err != nil || string(got) != want {
			t.Fatalf("%q: %q %v", in, got, err)
		}
	}
	for _, in := range []string{"Z", "Zg==", "Zh", "Zm9v\r\n", "Zm+v", "Zm/v", "Z m9"} {
		if _, err := DecodeB64URL(in); err == nil {
			t.Fatalf("%q accepted", in)
		}
	}
}

func TestReceiptVector(t *testing.T) {
	v, priv, pub := loadVectors(t)
	payload, err := MarshalReceipt(v.Receipt.Payload)
	if err != nil {
		t.Fatal(err)
	}
	want, err := DecodeB64URL(v.Receipt.Signed.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != string(want) {
		t.Fatalf("payload bytes differ:\n got %s\nwant %s", payload, want)
	}
	signed, err := SignReceipt(priv, v.Receipt.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if signed != v.Receipt.Signed {
		t.Fatalf("signed receipt differs:\n got %+v\nwant %+v", signed, v.Receipt.Signed)
	}
	if b, ok := VerifyReceipt(pub, signed); !ok || string(b) != string(want) {
		t.Fatal("own receipt does not verify")
	}
	tampered := signed
	tampered.Payload = EncodeB64URL([]byte(strings.Replace(string(want), "31457280", "31457281", 1)))
	if _, ok := VerifyReceipt(pub, tampered); ok {
		t.Fatal("tampered receipt verified")
	}
}

func TestReceiptEmptyEntriesAndTime(t *testing.T) {
	b, err := MarshalReceipt(ReceiptPayload{V: 1, RelayID: "r", Nonce: "n"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(b), `"entries":[]}`) {
		t.Fatalf("nil entries must encode as []: %s", b)
	}
	if got := ISOTime(time.Unix(1700000000, 0)); got != "2023-11-14T22:13:20.000Z" {
		t.Fatalf("ISOTime = %s", got)
	}
	if got := ISOTime(time.Unix(1700000000, 123456789).In(time.FixedZone("x", 3600))); got != "2023-11-14T22:13:20.123Z" {
		t.Fatalf("ISOTime = %s", got)
	}
}

func TestNonceUnique(t *testing.T) {
	seen := map[string]bool{}
	for range 10_000 {
		n, err := NewNonce()
		if err != nil {
			t.Fatal(err)
		}
		if len(n) < 16 || len(n) > 64 {
			t.Fatalf("nonce length %d", len(n))
		}
		if seen[n] {
			t.Fatalf("duplicate nonce %s", n)
		}
		seen[n] = true
	}
}

func TestParsePublicKeySPKI(t *testing.T) {
	_, _, pub := loadVectors(t)
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParsePublicKey(base64.StdEncoding.EncodeToString(der))
	if err != nil || !got.Equal(pub) {
		t.Fatalf("SPKI: %v", err)
	}
	if _, err := ParsePublicKey("short"); err == nil {
		t.Fatal("garbage key accepted")
	}
}
