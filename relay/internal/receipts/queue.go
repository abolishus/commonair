// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package receipts persists signed bandwidth receipts until the API accepts
// them, so neither an API outage nor a relay restart loses earnings.
package receipts

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/abolishus/commonair/relay/internal/tokens"
)

// DefaultMaxPending keeps two days of one-minute periods.
const DefaultMaxPending = 2880

// Item is one queued receipt.
type Item struct {
	// Name orders items chronologically and names the file on disk.
	Name    string
	Receipt tokens.SignedReceipt
}

// Queue is an ordered, bounded, disk-backed receipt queue. The in-memory
// copy is authoritative, so a failing disk degrades to memory-only rather
// than dropping receipts.
type Queue struct {
	dir string
	max int

	mu    sync.Mutex
	items []Item
}

// OpenQueue loads queued receipts from dir. Files that are unreadable or
// whose signature does not verify against pub (tampered, truncated, or
// signed by a key this relay no longer holds) are renamed to *.corrupt and
// skipped, keeping them for inspection; sending them would only earn a
// rejection and could look like forgery.
func OpenQueue(dir string, maxPending int, pub ed25519.PublicKey) (*Queue, []error) {
	if maxPending <= 0 {
		maxPending = DefaultMaxPending
	}
	q := &Queue{dir: dir, max: maxPending}
	var problems []error
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return q, []error{fmt.Errorf("receipt dir: %w", err)}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return q, []error{fmt.Errorf("receipt dir: %w", err)}
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") {
			if strings.HasSuffix(name, ".tmp") {
				_ = os.Remove(filepath.Join(dir, name)) // interrupted write, never acknowledged
			}
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		var r tokens.SignedReceipt
		if err == nil {
			err = json.Unmarshal(data, &r)
		}
		if err == nil && (r.Payload == "" || r.Signature == "") {
			err = errors.New("empty receipt")
		}
		if err == nil {
			if _, ok := tokens.VerifyReceipt(pub, r); !ok {
				err = errors.New("signature does not verify with the relay key")
			}
		}
		if err != nil {
			problems = append(problems, fmt.Errorf("%s: %w", name, err))
			_ = os.Rename(filepath.Join(dir, name), filepath.Join(dir, name+".corrupt"))
			continue
		}
		q.items = append(q.items, Item{Name: strings.TrimSuffix(name, ".json"), Receipt: r})
	}
	sort.Slice(q.items, func(i, j int) bool { return q.items[i].Name < q.items[j].Name })
	return q, problems
}

// Add queues a receipt created at t. It returns the names of receipts
// dropped to respect the bound (oldest first) and any persistence error; the
// receipt is queued in memory either way.
func (q *Queue) Add(r tokens.SignedReceipt, t time.Time, nonce string) (dropped []string, err error) {
	name := fmt.Sprintf("%020d-%s", t.UnixNano(), nonce)
	q.mu.Lock()
	defer q.mu.Unlock()
	q.items = append(q.items, Item{Name: name, Receipt: r})
	sort.SliceStable(q.items, func(i, j int) bool { return q.items[i].Name < q.items[j].Name })
	for len(q.items) > q.max {
		old := q.items[0]
		q.items = q.items[1:]
		dropped = append(dropped, old.Name)
		_ = os.Remove(q.path(old.Name))
	}
	return dropped, q.persist(name, r)
}

func (q *Queue) path(name string) string { return filepath.Join(q.dir, name+".json") }

// persist writes atomically: temp file, fsync, rename.
func (q *Queue) persist(name string, r tokens.SignedReceipt) error {
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	tmp := q.path(name) + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, q.path(name))
}

// Items returns a snapshot in chronological order.
func (q *Queue) Items() []Item {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]Item(nil), q.items...)
}

// Len is the number of queued receipts.
func (q *Queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

// Remove deletes an acknowledged (or permanently rejected) receipt.
func (q *Queue) Remove(name string) error {
	q.mu.Lock()
	for i, it := range q.items {
		if it.Name == name {
			q.items = append(q.items[:i], q.items[i+1:]...)
			break
		}
	}
	q.mu.Unlock()
	err := os.Remove(q.path(name))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
