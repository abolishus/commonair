// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package receipts

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/abolishus/commonair/relay/internal/accounting"
	"github.com/abolishus/commonair/relay/internal/apiclient"
	"github.com/abolishus/commonair/relay/internal/tokens"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func receipt(i int) tokens.SignedReceipt {
	return tokens.SignedReceipt{Payload: fmt.Sprintf("p%d", i), Signature: fmt.Sprintf("s%d", i)}
}

func TestQueuePersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	q, problems := OpenQueue(dir, 10)
	if len(problems) != 0 {
		t.Fatal(problems)
	}
	t0 := time.Unix(1700000000, 0)
	for i := range 3 {
		if _, err := q.Add(receipt(i), t0.Add(time.Duration(i)*time.Minute), fmt.Sprintf("n%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := q.Remove(q.Items()[1].Name); err != nil {
		t.Fatal(err)
	}
	re, problems := OpenQueue(dir, 10)
	if len(problems) != 0 {
		t.Fatal(problems)
	}
	items := re.Items()
	if len(items) != 2 || items[0].Receipt != receipt(0) || items[1].Receipt != receipt(2) {
		t.Fatalf("reloaded %+v", items)
	}
	if st, err := os.Stat(filepath.Join(dir, items[0].Name+".json")); err != nil || (st.Mode().Perm()&0o077 != 0 && os.PathSeparator == '/') {
		t.Fatalf("receipt file: %v %v", st, err)
	}
}

func TestQueueBoundDropsOldest(t *testing.T) {
	dir := t.TempDir()
	q, _ := OpenQueue(dir, 2)
	t0 := time.Unix(1700000000, 0)
	q.Add(receipt(0), t0, "a")
	q.Add(receipt(1), t0.Add(time.Minute), "b")
	dropped, err := q.Add(receipt(2), t0.Add(2*time.Minute), "c")
	if err != nil || len(dropped) != 1 {
		t.Fatalf("dropped %v err %v", dropped, err)
	}
	re, _ := OpenQueue(dir, 2)
	if items := re.Items(); len(items) != 2 || items[0].Receipt != receipt(1) {
		t.Fatalf("after bound: %+v", items)
	}
}

func TestQueueQuarantinesCorruptFiles(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "00000000000000000001-x.json"), []byte("{not json"), 0o600)
	os.WriteFile(filepath.Join(dir, "00000000000000000002-y.json.tmp"), []byte("partial"), 0o600)
	good, _ := json.Marshal(receipt(7))
	os.WriteFile(filepath.Join(dir, "00000000000000000003-z.json"), good, 0o600)
	q, problems := OpenQueue(dir, 10)
	if len(problems) != 1 {
		t.Fatalf("problems %v", problems)
	}
	if items := q.Items(); len(items) != 1 || items[0].Receipt != receipt(7) {
		t.Fatalf("items %+v", items)
	}
	if _, err := os.Stat(filepath.Join(dir, "00000000000000000001-x.json.corrupt")); err != nil {
		t.Fatal("corrupt file not kept aside")
	}
	if _, err := os.Stat(filepath.Join(dir, "00000000000000000002-y.json.tmp")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("temp file not cleaned")
	}
}

type fakeAPI struct {
	mu    sync.Mutex
	fail  []error // consumed one per call; nil entries succeed
	got   []tokens.SignedReceipt
	calls int
}

func (f *fakeAPI) SubmitReceipt(_ context.Context, r tokens.SignedReceipt) (apiclient.ReceiptResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if len(f.fail) > 0 {
		err := f.fail[0]
		f.fail = f.fail[1:]
		if err != nil {
			return apiclient.ReceiptResponse{}, err
		}
	}
	f.got = append(f.got, r)
	return apiclient.ReceiptResponse{ReceiptID: "id", Status: "pending"}, nil
}

func TestSenderRetriesInOrderAndDiscardsPermanentFailures(t *testing.T) {
	q, _ := OpenQueue(t.TempDir(), 10)
	t0 := time.Unix(1700000000, 0)
	for i := range 3 {
		q.Add(receipt(i), t0.Add(time.Duration(i)*time.Second), fmt.Sprint(i))
	}
	api := &fakeAPI{fail: []error{
		&apiclient.Error{Status: 503}, // receipt 0: transient, stop
		nil,                           // receipt 0: ok
		&apiclient.Error{Status: 409, Code: "CONFLICT"}, // receipt 1: replayed nonce, discard
		errors.New("connection reset"),                  // receipt 2: transient
	}}
	s := &Sender{Queue: q, API: api, Log: quiet}
	if err := s.SendAll(context.Background()); err == nil {
		t.Fatal("transient failure not reported")
	}
	if q.Len() != 3 || len(api.got) != 0 {
		t.Fatal("stopped sender must not skip ahead")
	}
	if err := s.SendAll(context.Background()); err == nil {
		t.Fatal("second transient failure not reported")
	}
	if q.Len() != 1 || len(api.got) != 1 || api.got[0] != receipt(0) {
		t.Fatalf("after round 2: queue %d got %+v", q.Len(), api.got)
	}
	if err := s.SendAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if q.Len() != 0 || len(api.got) != 2 || api.got[1] != receipt(2) {
		t.Fatalf("after round 3: queue %d got %+v", q.Len(), api.got)
	}
}

func TestSenderRunBacksOffAndRecovers(t *testing.T) {
	q, _ := OpenQueue(t.TempDir(), 10)
	q.Add(receipt(0), time.Now(), "x")
	api := &fakeAPI{fail: []error{errors.New("down"), errors.New("down")}}
	s := &Sender{Queue: q, API: api, Log: quiet, MinBackoff: 5 * time.Millisecond, MaxBackoff: 20 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for q.Len() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("never delivered")
		}
		time.Sleep(2 * time.Millisecond)
	}
	q.Add(receipt(1), time.Now(), "y")
	s.Kick()
	for q.Len() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("kick did not deliver")
		}
		time.Sleep(2 * time.Millisecond)
	}
	cancel()
	<-done
	if api.calls != 4 {
		t.Fatalf("calls %d, want 4", api.calls)
	}
}

func TestBuildChunksAndSigns(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	p := accounting.Period{Start: time.Unix(1700000000, 0), End: time.Unix(1700000060, 0)}
	for i := range 5 {
		p.Entries = append(p.Entries, tokens.ReceiptEntry{SessionID: fmt.Sprintf("s%d", i), Segments: 1, Bytes: int64(100 * (i + 1))})
	}
	built, err := Build(priv, "01890000-0000-7000-8000-000000000003", p, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(built) != 3 {
		t.Fatalf("%d receipts, want 3", len(built))
	}
	var total int64
	nonces := map[string]bool{}
	for _, b := range built {
		payload, ok := tokens.VerifyReceipt(pub, b.Receipt)
		if !ok {
			t.Fatal("receipt does not verify")
		}
		var rp tokens.ReceiptPayload
		if err := json.Unmarshal(payload, &rp); err != nil {
			t.Fatal(err)
		}
		if rp.Nonce != b.Nonce || nonces[rp.Nonce] || rp.PeriodStart != "2023-11-14T22:13:20.000Z" {
			t.Fatalf("payload %+v", rp)
		}
		nonces[rp.Nonce] = true
		for _, e := range rp.Entries {
			total += e.Bytes
		}
	}
	if total != 1500 {
		t.Fatalf("bytes %d", total)
	}
	if empty, _ := Build(priv, "r", accounting.Period{}, 0); len(empty) != 0 {
		t.Fatal("empty period produced a receipt")
	}
}
