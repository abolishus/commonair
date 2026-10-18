// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"bytes"
	"io"
	"log/slog"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestParseFlags(t *testing.T) {
	c, err := parseFlags([]string{
		"--api", "https://instance.test/", "--public-url", "https://relay.test", "--behind-proxy",
		"--capacity-mbps", "200", "--data-dir", "/tmp/x/../relay",
	}, env(map[string]string{"COMMONAIR_RELAY_TOKEN": "relay_abc"}), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if c.token != "relay_abc" || c.capacityMbps != 200 || c.cacheMB != 1024 || c.listen != ":8443" || c.dataDir != "/tmp/relay" {
		t.Fatalf("%+v", c)
	}
	if c, err := parseFlags([]string{"--api", "https://i.test/", "--public-url", "http://r.test", "--token", "flag"}, env(map[string]string{"COMMONAIR_RELAY_TOKEN": "env"}), io.Discard); err != nil || c.token != "flag" {
		t.Fatalf("flag must win over env: %v %q", err, c.token)
	}
}

func TestParseFlagsErrors(t *testing.T) {
	cases := map[string][]string{
		"missing everything": {},
		"https without tls":  {"--api", "https://i.test/", "--token", "t", "--public-url", "https://r.test"},
		"cert without key":   {"--api", "https://i.test/", "--token", "t", "--public-url", "https://r.test", "--tls-cert", "c.pem"},
		"tls and proxy":      {"--api", "https://i.test/", "--token", "t", "--public-url", "https://r.test", "--tls-cert", "c", "--tls-key", "k", "--behind-proxy"},
		"tiny cache":         {"--api", "https://i.test/", "--token", "t", "--public-url", "http://r.test", "--cache-mb", "1"},
	}
	for name, args := range cases {
		if _, err := parseFlags(args, env(nil), io.Discard); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
}

func TestExpandHome(t *testing.T) {
	t.Setenv("HOME", "/home/member")
	got, err := expandHome("~/.commonair-relay")
	if err != nil || got != "/home/member/.commonair-relay" {
		t.Fatalf("%q %v", got, err)
	}
}

func TestRedactingWriterHidesAddresses(t *testing.T) {
	var buf bytes.Buffer
	w := &redactingWriter{log: slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))}
	_, _ = w.Write([]byte("http: TLS handshake error from 203.0.113.7:51234: EOF\n"))
	_, _ = w.Write([]byte("http: TLS handshake error from [2001:db8::1]:443: EOF\n"))
	out := buf.String()
	if strings.Contains(out, "203.0.113.7") || strings.Contains(out, "2001:db8") || strings.Count(out, "[redacted]") != 2 {
		t.Fatalf("addresses leaked: %s", out)
	}
}
