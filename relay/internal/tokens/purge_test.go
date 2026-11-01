// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package tokens

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"testing"
)

// b7Vectors are the batch 7 sections of packages/tokens/vectors.json.
type b7Vectors struct {
	PublicKey        string `json:"publicKey"`
	PlaybackDvrRelay struct {
		Claims map[string]any `json:"claims"`
		Token  string         `json:"token"`
	} `json:"playbackDvrRelay"`
	Purge struct {
		Batch     PurgeBatch       `json:"batch"`
		Canonical string           `json:"canonical"`
		Signed    SignedPurgeBatch `json:"signed"`
		Cases     []struct {
			Name   string           `json:"name"`
			Signed SignedPurgeBatch `json:"signed"`
			Error  *string          `json:"error"`
		} `json:"cases"`
	} `json:"purge"`
	Standing struct {
		PublicKey string `json:"publicKey"`
		Kid       string `json:"kid"`
		Canonical string `json:"canonical"`
		Signed    struct {
			Payload   string `json:"payload"`
			Signature string `json:"signature"`
		} `json:"signed"`
		Cases []struct {
			Name   string `json:"name"`
			Signed struct {
				Payload   string `json:"payload"`
				Signature string `json:"signature"`
			} `json:"signed"`
			Error *string `json:"error"`
		} `json:"cases"`
	} `json:"standing"`
}

func loadB7Vectors(t *testing.T) b7Vectors {
	t.Helper()
	raw, err := os.ReadFile("../../../packages/tokens/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v b7Vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestPurgeVector(t *testing.T) {
	_, priv, pub := loadVectors(t)
	v := loadB7Vectors(t)
	b, err := MarshalPurgeBatch(v.Purge.Batch)
	if err != nil || string(b) != v.Purge.Canonical {
		t.Fatalf("canonical bytes = %s (%v), want %s", b, err, v.Purge.Canonical)
	}
	signed, err := SignPurgeBatch(priv, v.Purge.Batch)
	if err != nil || signed != v.Purge.Signed {
		t.Fatalf("signed = %+v (%v), want %+v", signed, err, v.Purge.Signed)
	}
	got, err := VerifyPurgeBatch(pub, v.Purge.Signed)
	if err != nil || got.Seq != 42 || len(got.Items) != 3 || got.Items[0].Prefix != v.Purge.Batch.Items[0].Prefix {
		t.Fatalf("verify = %+v, %v", got, err)
	}
}

func TestPurgeCases(t *testing.T) {
	_, _, pub := loadVectors(t)
	v := loadB7Vectors(t)
	want := map[string]error{"malformed": ErrMalformed, "bad_signature": ErrBadSignature, "non_canonical": ErrNonCanonical}
	if len(v.Purge.Cases) < 10 {
		t.Fatalf("only %d purge cases", len(v.Purge.Cases))
	}
	for _, c := range v.Purge.Cases {
		t.Run(c.Name, func(t *testing.T) {
			_, err := VerifyPurgeBatch(pub, c.Signed)
			if c.Error == nil {
				if err != nil {
					t.Fatalf("valid case refused: %v", err)
				}
				return
			}
			w, ok := want[*c.Error]
			if !ok {
				t.Fatalf("unknown error code %q", *c.Error)
			}
			if !errors.Is(err, w) {
				t.Fatalf("got %v, want %v", err, w)
			}
		})
	}
}

func TestPurgeEdges(t *testing.T) {
	_, priv, pub := loadVectors(t)
	sign := func(s string) SignedPurgeBatch {
		return SignedPurgeBatch{Payload: EncodeB64URL([]byte(s)), Signature: EncodeB64URL(ed25519.Sign(priv, []byte(s)))}
	}
	bad := map[string]string{
		"missing seq":     `{"items":[]}`,
		"missing items":   `{"seq":1}`,
		"null items":      `{"seq":1,"items":null}`,
		"array":           `[]`,
		"trailing":        `{"seq":1,"items":[]} {}`,
		"item null":       `{"seq":1,"items":[null]}`,
		"item no prefix":  `{"seq":1,"items":[{"seq":1,"reason":"x"}]}`,
		"negative seq":    `{"seq":-1,"items":[]}`,
		"beyond safe int": `{"seq":9007199254740992,"items":[]}`,
		"seq string":      `{"seq":"1","items":[]}`,
	}
	for name, s := range bad {
		if _, err := VerifyPurgeBatch(pub, sign(s)); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: got %v, want ErrMalformed", name, err)
		}
	}
	if _, err := VerifyPurgeBatch(pub, sign(`{"seq":0,"items":[]}`)); err != nil {
		t.Fatalf("empty batch at 0: %v", err)
	}
	if _, err := VerifyPurgeBatch(ed25519.PublicKey(make([]byte, 31)), sign(`{"seq":0,"items":[]}`)); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("short key: %v", err)
	}
	if _, err := SignPurgeBatch(priv, PurgeBatch{Seq: 1, Items: []PurgeItem{{Seq: 2, Prefix: "live/a/", Reason: "x"}}}); !errors.Is(err, ErrMalformed) {
		t.Fatalf("sign invalid: %v", err)
	}
	many := PurgeBatch{Seq: PurgeBatchMaxItems + 1}
	for i := range PurgeBatchMaxItems + 1 {
		many.Items = append(many.Items, PurgeItem{Seq: int64(i + 1), Prefix: "live/a/", Reason: "x"})
	}
	if many.Validate() == nil {
		t.Fatal("over the item cap accepted")
	}
	many.Items, many.Seq = many.Items[:PurgeBatchMaxItems], PurgeBatchMaxItems
	if err := many.Validate(); err != nil {
		t.Fatalf("at the item cap: %v", err)
	}
}

// TestPurgeReset: the signed reset (ADR 0016 A1.2) round-trips, marshals the
// way TS does, and is the only batch carrying the reset key.
func TestPurgeReset(t *testing.T) {
	_, priv, pub := loadVectors(t)
	v := loadB7Vectors(t)
	var valid *SignedPurgeBatch
	for _, c := range v.Purge.Cases {
		if c.Name == "valid reset" {
			valid = &c.Signed
		}
	}
	if valid == nil {
		t.Fatal("no valid reset vector")
	}
	got, err := VerifyPurgeBatch(pub, *valid)
	if err != nil || !got.Reset || got.Seq != 120 || len(got.Items) != 0 {
		t.Fatalf("verify reset = %+v, %v", got, err)
	}
	signed, err := SignPurgeBatch(priv, PurgeBatch{Seq: 120, Reset: true})
	if err != nil || signed != *valid {
		t.Fatalf("sign reset = %+v (%v), want %+v", signed, err, *valid)
	}
	b, _ := MarshalPurgeBatch(PurgeBatch{Seq: 1})
	if string(b) != `{"seq":1,"items":[]}` {
		t.Fatalf("a batch without reset marshals %s", b)
	}
	if _, err := SignPurgeBatch(priv, PurgeBatch{Seq: 1, Reset: true, Items: []PurgeItem{{Seq: 1, Prefix: "live/a/", Reason: "x"}}}); !errors.Is(err, ErrMalformed) {
		t.Fatalf("reset with items: %v", err)
	}
}

func TestPurgePrefixes(t *testing.T) {
	for _, p := range []string{"dvr/01890000-0000-7000-8000-000000000009/", "live/alice/", "live/alice/captions/"} {
		if !purgePrefixRE.MatchString(p) {
			t.Errorf("%q refused", p)
		}
	}
	for _, p := range []string{"", "live/", "live/../", "live/.x/", "vod/x/", "/live/a/", "live/a", "LIVE/a/"} {
		if purgePrefixRE.MatchString(p) {
			t.Errorf("%q accepted", p)
		}
	}
}

// The standing statement is signed and verified in TypeScript only; this pins
// its bytes across languages: Ed25519 over the canonical payload and the kid.
func TestStandingVectorBytes(t *testing.T) {
	v := loadB7Vectors(t)
	pubRaw, err := DecodeB64URL(v.Standing.PublicKey)
	if err != nil || len(pubRaw) != ed25519.PublicKeySize {
		t.Fatalf("public key: %v", err)
	}
	sum := sha256.Sum256(pubRaw)
	if EncodeB64URL(sum[:16]) != v.Standing.Kid {
		t.Fatalf("kid = %s, want %s", EncodeB64URL(sum[:16]), v.Standing.Kid)
	}
	payload, err := DecodeB64URL(v.Standing.Signed.Payload)
	if err != nil || string(payload) != v.Standing.Canonical {
		t.Fatalf("payload = %s, want canonical", payload)
	}
	sig, _ := DecodeB64URL(v.Standing.Signed.Signature)
	if !ed25519.Verify(pubRaw, payload, sig) {
		t.Fatal("standing signature does not verify")
	}
	// Signature-level cases: a valid signature must verify, a bad_signature one must not.
	for _, c := range v.Standing.Cases {
		p, perr := DecodeB64URL(c.Signed.Payload)
		s, serr := DecodeB64URL(c.Signed.Signature)
		ok := perr == nil && serr == nil && len(s) == ed25519.SignatureSize && ed25519.Verify(pubRaw, p, s)
		if c.Error == nil && !ok {
			t.Errorf("%s: valid case does not verify", c.Name)
		}
		if c.Error != nil && *c.Error == "bad_signature" && ok {
			t.Errorf("%s: tampered case verifies", c.Name)
		}
	}
}

func TestDvrRelayVector(t *testing.T) {
	_, priv, pub := loadVectors(t)
	v := loadB7Vectors(t)
	c, err := VerifyPlayback(pub, v.PlaybackDvrRelay.Token, vectorNow, DefaultSkew)
	if err != nil {
		t.Fatalf("dvr relay vector rejected: %v", err)
	}
	want := PlaybackClaims{
		V: 1, SID: "01890000-0000-7000-8000-000000000001", CID: "01890000-0000-7000-8000-000000000002",
		Path: "dvr/01890000-0000-7000-8000-000000000009", Src: "relay", RID: "01890000-0000-7000-8000-000000000003",
		IAT: 1700000000, EXP: 1700000120,
	}
	if c != want {
		t.Fatalf("claims = %+v, want %+v", c, want)
	}
	b := Binding{RelayID: want.RID}
	for _, p := range []string{"dvr/01890000-0000-7000-8000-000000000009/index.m3u8", "dvr/01890000-0000-7000-8000-000000000009/r0_000001.m4s"} {
		if err := b.Check(c, p); err != nil {
			t.Fatalf("%s: %v", p, err)
		}
	}
	for _, p := range []string{"dvr/01890000-0000-7000-8000-00000000000a/index.m3u8", "live/alice/index.m3u8", "dvr/01890000-0000-7000-8000-000000000009"} {
		if err := b.Check(c, p); !errors.Is(err, ErrBinding) {
			t.Fatalf("%s accepted", p)
		}
	}
	if err := (Binding{RelayID: "01890000-0000-7000-8000-00000000000f"}).Check(c, "dvr/01890000-0000-7000-8000-000000000009/index.m3u8"); !errors.Is(err, ErrBinding) {
		t.Fatal("another relay accepted")
	}
	// A relay token for a VOD path is refused by the binding even when genuine.
	vod := c
	vod.Path = "vod/01890000-0000-7000-8000-000000000009"
	if err := b.Check(vod, "vod/01890000-0000-7000-8000-000000000009/index.m3u8"); !errors.Is(err, ErrBinding) {
		t.Fatal("vod path accepted on a relay")
	}

	mutate := func(f func(m map[string]any)) string {
		m := cloneClaims(v.PlaybackDvrRelay.Claims)
		f(m)
		return sign(priv, m)
	}
	bad := map[string]string{
		"dm on relay dvr":   mutate(func(m map[string]any) { m["dm"] = 111111 }),
		"dvr not a uuid":    mutate(func(m map[string]any) { m["path"] = "dvr/x" }),
		"dvr uppercase":     mutate(func(m map[string]any) { m["path"] = "dvr/01890000-0000-7000-8000-00000000000A" }),
		"dvr trailing path": mutate(func(m map[string]any) { m["path"] = "dvr/01890000-0000-7000-8000-000000000009/" }),
		"dvr relay no rid":  mutate(func(m map[string]any) { delete(m, "rid") }),
	}
	for name, tok := range bad {
		if _, err := VerifyPlayback(pub, tok, vectorNow, DefaultSkew); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: got %v, want ErrMalformed", name, err)
		}
	}
	// The same path on an origin token stays valid.
	origin := mutate(func(m map[string]any) {
		m["src"] = "origin"
		delete(m, "rid")
	})
	if _, err := VerifyPlayback(pub, origin, vectorNow, DefaultSkew); err != nil {
		t.Fatalf("origin dvr token: %v", err)
	}
}
