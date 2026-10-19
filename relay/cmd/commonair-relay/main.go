// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Command commonair-relay is the CommonAir member relay: a segment cache a
// member runs to serve assigned viewers and earn verified bandwidth credit.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/abolishus/commonair/relay/internal/relay"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

// finalReceiptWindow is how long shutdown spends delivering queued receipts
// after the drain; anything undelivered stays on disk for the next start.
const finalReceiptWindow = 10 * time.Second

type config struct {
	api, token, publicURL, listen, dataDir, region string
	tlsCert, tlsKey                                string
	behindProxy, showVersion                       bool
	capacityMbps, cacheMB                          int
	perViewerMbps                                  float64
	logLevel                                       string
	shutdownTimeout                                time.Duration
}

func parseFlags(args []string, getenv func(string) string, stderr io.Writer) (config, error) {
	var c config
	fs := flag.NewFlagSet("commonair-relay", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&c.api, "api", getenv("COMMONAIR_RELAY_API"), "instance base URL, e.g. https://instance/ (env COMMONAIR_RELAY_API)")
	fs.StringVar(&c.token, "token", "", "relay registration token relay_... (prefer env COMMONAIR_RELAY_TOKEN so it does not show in ps)")
	fs.StringVar(&c.publicURL, "public-url", getenv("COMMONAIR_RELAY_PUBLIC_URL"), "public https URL viewers reach this relay at")
	fs.StringVar(&c.listen, "listen", ":8443", "listen address")
	fs.IntVar(&c.capacityMbps, "capacity-mbps", 100, "upload capacity you donate, in Mbps")
	fs.Float64Var(&c.perViewerMbps, "viewer-mbps", 5, "assumed average Mbps per viewer (sets the viewer limit)")
	fs.IntVar(&c.cacheMB, "cache-mb", 1024, "memory cache size in MiB")
	fs.StringVar(&c.dataDir, "data-dir", "~/.commonair-relay", "directory for the relay key and unsent receipts")
	fs.StringVar(&c.region, "region", "", "optional region label, e.g. eu-west")
	fs.StringVar(&c.tlsCert, "tls-cert", "", "TLS certificate chain (PEM); reloaded when the file changes")
	fs.StringVar(&c.tlsKey, "tls-key", "", "TLS private key (PEM)")
	fs.BoolVar(&c.behindProxy, "behind-proxy", false, "serve plain HTTP behind a TLS-terminating reverse proxy")
	fs.StringVar(&c.logLevel, "log-level", "info", "debug, info, warn or error")
	fs.DurationVar(&c.shutdownTimeout, "drain-timeout", 30*time.Second, fmt.Sprintf("on SIGTERM/SIGINT, time to keep serving current viewers (at least %s); the final receipt gets %s more", relay.MinDrainWindow, finalReceiptWindow))
	fs.BoolVar(&c.showVersion, "version", false, "print the version and exit")
	if err := fs.Parse(args); err != nil {
		return c, err
	}
	if c.showVersion {
		return c, nil
	}
	if c.token == "" {
		c.token = getenv("COMMONAIR_RELAY_TOKEN")
	}
	var problems []string
	if c.api == "" {
		problems = append(problems, "--api is required")
	}
	if c.token == "" {
		problems = append(problems, "--token (or COMMONAIR_RELAY_TOKEN) is required")
	}
	if c.publicURL == "" {
		problems = append(problems, "--public-url is required")
	}
	if (c.tlsCert == "") != (c.tlsKey == "") {
		problems = append(problems, "--tls-cert and --tls-key go together")
	}
	if c.tlsCert != "" && c.behindProxy {
		problems = append(problems, "choose either --tls-cert/--tls-key or --behind-proxy")
	}
	if u, err := url.Parse(c.publicURL); err == nil && u.Scheme == "https" && c.tlsCert == "" && !c.behindProxy {
		problems = append(problems, "an https --public-url needs --tls-cert/--tls-key or --behind-proxy")
	}
	if c.shutdownTimeout < relay.MinDrainWindow {
		problems = append(problems, fmt.Sprintf("--drain-timeout must be at least %s (longer than a blocking playlist request)", relay.MinDrainWindow))
	}
	if c.cacheMB < 16 {
		problems = append(problems, "--cache-mb must be at least 16")
	}
	if len(problems) > 0 {
		return c, errors.New(strings.Join(problems, "; "))
	}
	dir, err := expandHome(c.dataDir)
	if err != nil {
		return c, err
	}
	c.dataDir = dir
	return c, nil
}

func expandHome(p string) (string, error) {
	if p != "~" && !strings.HasPrefix(p, "~/") {
		return filepath.Clean(p), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot expand ~ in --data-dir: %w", err)
	}
	return filepath.Join(home, strings.TrimPrefix(p, "~")), nil
}

func newLogger(level string, w io.Writer) *slog.Logger {
	var l slog.Level
	if err := l.UnmarshalText([]byte(level)); err != nil {
		l = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: l})).With("service", "commonair-relay", "version", version)
}

func main() {
	cfg, err := parseFlags(os.Args[1:], os.Getenv, os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "commonair-relay:", err)
		os.Exit(2)
	}
	if cfg.showVersion {
		fmt.Println(version)
		return
	}
	logger := newLogger(cfg.logLevel, os.Stderr)
	if err := run(cfg, logger); err != nil {
		logger.Error("relay stopped with an error", "err", err.Error())
		os.Exit(1)
	}
}

func run(cfg config, logger *slog.Logger) error {
	rel, err := relay.New(relay.Options{
		APIURL:        cfg.api,
		Token:         cfg.token,
		PublicURL:     cfg.publicURL,
		Region:        cfg.region,
		CapacityMbps:  cfg.capacityMbps,
		PerViewerMbps: cfg.perViewerMbps,
		DataDir:       cfg.dataDir,
		CacheBytes:    int64(cfg.cacheMB) << 20,
		Version:       version,
		Log:           logger,
	})
	if err != nil {
		return err
	}
	srv := &http.Server{
		Handler:           rel.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// Blocking playlist reloads are held by the origin for a few seconds;
		// segments are a few MB. A minute covers both on slow links.
		WriteTimeout:   60 * time.Second,
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 16 << 10,
		ErrorLog:       log.New(&redactingWriter{log: logger}, "", 0),
	}
	if cfg.tlsCert != "" {
		reloader, err := newCertReloader(cfg.tlsCert, cfg.tlsKey)
		if err != nil {
			return err
		}
		srv.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: reloader.get}
	}
	ln, err := net.Listen("tcp", cfg.listen)
	if err != nil {
		return err
	}
	serveErr := make(chan error, 1)
	go func() {
		if srv.TLSConfig != nil {
			serveErr <- srv.ServeTLS(ln, "", "")
		} else {
			serveErr <- srv.Serve(ln)
		}
	}()
	// The one startup line operators look for (version comes from the logger).
	// Never log the token.
	logger.Info("listening", "addr", ln.Addr().String(), "publicUrl", cfg.publicURL, "region", cfg.region,
		"capacityMbps", cfg.capacityMbps, "tls", srv.TLSConfig != nil, "dataDir", cfg.dataDir, "publicKey", rel.PublicKey())
	if srv.TLSConfig == nil && !cfg.behindProxy {
		logger.Warn("serving plain HTTP; browsers on https pages will refuse it. Use --tls-cert/--tls-key or --behind-proxy in production")
	}
	rel.Start()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var runErr error
	select {
	case <-ctx.Done():
		// Restore default signal handling: a second SIGINT/SIGTERM exits at once.
		stop()
		logger.Info("draining: serving current viewers until --drain-timeout; signal again to exit now", "drainTimeout", cfg.shutdownTimeout.String())
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			runErr = err
		}
	}
	// Finish in-flight requests (including blocking playlist reloads held by
	// the origin) before the final receipt, then deliver it.
	if err := rel.GracefulStop(srv, cfg.shutdownTimeout, finalReceiptWindow); err != nil {
		logger.Warn("final receipt delivery incomplete; will retry on next start", "err", err.Error())
	}
	logger.Info("stopped")
	return runErr
}

// addrRE matches IPv4/IPv6 host:port pairs net/http includes in its error
// log (for example TLS handshake failures), which would leak viewer IPs.
var addrRE = regexp.MustCompile(`(\[[0-9a-fA-F:.%a-zA-Z]+\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?`)

type redactingWriter struct{ log *slog.Logger }

func (w *redactingWriter) Write(p []byte) (int, error) {
	msg := addrRE.ReplaceAllString(strings.TrimSpace(string(p)), "[redacted]")
	w.log.Debug("http server", "msg", msg)
	return len(p), nil
}
