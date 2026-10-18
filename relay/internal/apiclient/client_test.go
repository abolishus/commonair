// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package apiclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/abolishus/commonair/relay/internal/tokens"
)

func TestRegisterSendsContractShape(t *testing.T) {
	var gotPath, gotAuth string
	var got map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(RegisterResponse{
			RelayID: "01890000-0000-7000-8000-000000000003", OriginURL: "https://origin.test", OriginPublicKey: "k",
			ReceiptIntervalSeconds: 60, HeartbeatIntervalSeconds: 15, Status: "pending",
		})
	}))
	defer ts.Close()
	// A base path without trailing slash still resolves under it.
	c, err := New(ts.URL+"/instance", "relay_abc", "v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := c.Register(context.Background(), RegisterRequest{
		PublicURL: "https://relay.test", DeclaredCapacityMbps: 200, PublicKey: strings.Repeat("A", 43),
		Version: strings.Repeat("v", 60), Region: "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/instance/api/relay/register" || gotAuth != "Bearer relay_abc" {
		t.Fatalf("path %q auth %q", gotPath, gotAuth)
	}
	for _, k := range []string{"publicUrl", "declaredCapacityMbps", "publicKey", "version", "region"} {
		if _, ok := got[k]; !ok {
			t.Fatalf("missing %s in %v", k, got)
		}
	}
	if len(got["version"].(string)) != 40 {
		t.Fatal("version not truncated to the contract's 40 chars")
	}
	if resp.Status != "pending" {
		t.Fatalf("%+v", resp)
	}
}

func TestErrorsAreClassified(t *testing.T) {
	status := http.StatusUnauthorized
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"code":"UNAUTHORIZED","message":"unknown relay token"}`))
	}))
	defer ts.Close()
	c, _ := New(ts.URL, "t", "v", nil)
	_, err := c.Heartbeat(context.Background(), HeartbeatRequest{})
	e, ok := AsError(err)
	if !ok || !e.Unknown() || e.Permanent() || e.Code != "UNAUTHORIZED" {
		t.Fatalf("%v", err)
	}
	status = http.StatusConflict
	_, err = c.SubmitReceipt(context.Background(), tokens.SignedReceipt{Payload: "p", Signature: "s"})
	if e, ok := AsError(err); !ok || !e.Permanent() {
		t.Fatalf("%v", err)
	}
	status = http.StatusServiceUnavailable
	_, err = c.SubmitReceipt(context.Background(), tokens.SignedReceipt{Payload: "p", Signature: "s"})
	if e, ok := AsError(err); !ok || e.Permanent() || e.Unknown() {
		t.Fatalf("%v", err)
	}
}

func TestRegisterRejectsIncompleteResponse(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"relayId":"nope"}`))
	}))
	defer ts.Close()
	c, _ := New(ts.URL, "t", "v", nil)
	if _, err := c.Register(context.Background(), RegisterRequest{}); err == nil {
		t.Fatal("accepted")
	}
	if _, err := New("ftp://x", "t", "v", nil); err == nil {
		t.Fatal("non-http API accepted")
	}
}
