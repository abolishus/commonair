// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"crypto/tls"
	"os"
	"sync"
	"time"
)

// certReloader re-reads the certificate when its files change, so members
// renewing with an ACME client do not have to restart the relay.
type certReloader struct {
	certFile, keyFile string

	mu        sync.Mutex
	cert      *tls.Certificate
	modTime   time.Time
	checkedAt time.Time
}

func newCertReloader(certFile, keyFile string) (*certReloader, error) {
	r := &certReloader{certFile: certFile, keyFile: keyFile}
	if err := r.load(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *certReloader) load() error {
	st, err := os.Stat(r.certFile)
	if err != nil {
		return err
	}
	cert, err := tls.LoadX509KeyPair(r.certFile, r.keyFile)
	if err != nil {
		return err
	}
	r.cert, r.modTime = &cert, st.ModTime()
	return nil
}

func (r *certReloader) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if now := time.Now(); now.Sub(r.checkedAt) > time.Minute {
		r.checkedAt = now
		if st, err := os.Stat(r.certFile); err == nil && !st.ModTime().Equal(r.modTime) {
			// Keep serving the old certificate if the new pair is incomplete.
			_ = r.load()
		}
	}
	return r.cert, nil
}
