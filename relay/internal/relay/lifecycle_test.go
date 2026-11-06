// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

package relay

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/abolishus/commonair/relay/internal/apiclient"
	"github.com/abolishus/commonair/relay/internal/identity"
	"github.com/abolishus/commonair/relay/internal/server"
	"github.com/abolishus/commonair/relay/internal/tokens"
)

// logBuf collects a relay's JSON log lines; handlers write from many goroutines.
type logBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *logBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuf) has(msg string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Contains(l.b.String(), msg)
}

// newRelay builds (without starting) a relay against the harness, with hour-long
// intervals so no timer cuts a period or heartbeats behind the test's back.
func (h *harness) newRelay(mod func(o *Options)) (*Relay, *logBuf) {
	h.t.Helper()
	logs := &logBuf{}
	opts := Options{
		APIURL: h.api.URL, Token: relayToken, PublicURL: h.relaySrv.URL, CapacityMbps: 200,
		DataDir: h.dataDir, CacheBytes: 16 << 20, Version: "test",
		Log:             slog.New(slog.NewJSONHandler(logs, nil)),
		ReceiptInterval: time.Hour, HeartbeatInterval: time.Hour,
		RetryMin: 10 * time.Millisecond, RetryMax: 20 * time.Millisecond,
	}
	if mod != nil {
		mod(&opts)
	}
	rel, err := New(opts)
	if err != nil {
		h.t.Fatal(err)
	}
	h.handler.Store(rel.Handler())
	return rel, logs
}

func (a *fakeAPI) registrationCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.registrations
}

// queuedRelayIDs decodes the relay id of every queued receipt, oldest first.
func queuedRelayIDs(t *testing.T, rel *Relay) []string {
	t.Helper()
	pub, _ := rel.key.Private.Public().(ed25519.PublicKey)
	var ids []string
	for _, it := range rel.queue.Items() {
		payload, ok := tokens.VerifyReceipt(pub, it.Receipt)
		if !ok {
			t.Fatalf("queued receipt %s does not verify", it.Name)
		}
		var p tokens.ReceiptPayload
		if err := json.Unmarshal(payload, &p); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, p.RelayID)
	}
	return ids
}

func TestNewValidatesOptions(t *testing.T) {
	base := func(t *testing.T) Options {
		return Options{
			APIURL: "http://api.test", Token: "t", PublicURL: "https://relay.example", CapacityMbps: 10, DataDir: t.TempDir(),
			Log: slog.New(slog.NewJSONHandler(io.Discard, nil)),
		}
	}
	notADir := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(notADir, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct {
		mod  func(o *Options)
		want string
	}{
		"capacity zero":         {func(o *Options) { o.CapacityMbps = 0 }, "capacity"},
		"capacity above 100000": {func(o *Options) { o.CapacityMbps = 100_001 }, "capacity"},
		"no public URL":         {func(o *Options) { o.PublicURL = "" }, "--public-url"},
		"public URL not http":   {func(o *Options) { o.PublicURL = "ftp://relay.example" }, "--public-url"},
		"public URL no host":    {func(o *Options) { o.PublicURL = "https://" }, "--public-url"},
		"public URL query":      {func(o *Options) { o.PublicURL = "https://relay.example/?a=1" }, "--public-url"},
		"public URL fragment":   {func(o *Options) { o.PublicURL = "https://relay.example/#f" }, "--public-url"},
		"public URL unparsable": {func(o *Options) { o.PublicURL = "http://[::1" }, "--public-url"},
		"no token":              {func(o *Options) { o.Token = "" }, "token is required"},
		"API URL not http":      {func(o *Options) { o.APIURL = "ftp://api.test" }, "--api"},
		"data dir is a file":    {func(o *Options) { o.DataDir = notADir }, "data dir"},
	} {
		t.Run(name, func(t *testing.T) {
			o := base(t)
			tc.mod(&o)
			if _, err := New(o); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err %v, want %q", err, tc.want)
			}
		})
	}
	for _, capacity := range []int{1, 100_000} {
		o := base(t)
		o.CapacityMbps = capacity
		if _, err := New(o); err != nil {
			t.Fatalf("capacity %d: %v", capacity, err)
		}
	}
}

func TestNewDefaultsAndIdentity(t *testing.T) {
	dir := t.TempDir()
	logs := &logBuf{}
	o := Options{
		APIURL: "http://api.test", Token: "t", PublicURL: "https://relay.example", CapacityMbps: 10, DataDir: dir,
		Log: slog.New(slog.NewJSONHandler(logs, nil)),
	}
	rel, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	if rel.opts.Version != "dev" || rel.opts.CacheBytes != 1024<<20 || rel.opts.RetryMin != time.Second || rel.opts.RetryMax != time.Minute {
		t.Fatalf("defaults: version %q cache %d retry %v..%v", rel.opts.Version, rel.opts.CacheBytes, rel.opts.RetryMin, rel.opts.RetryMax)
	}
	tr, ok := rel.opts.OriginClient.Transport.(*http.Transport)
	if !ok || tr.MaxConnsPerHost != MaxOriginConns {
		t.Fatalf("origin client transport %#v", rel.opts.OriginClient.Transport)
	}
	if len(rel.PublicKey()) != 43 || !logs.has("generated relay identity") {
		t.Fatalf("public key %q; generated logged %v", rel.PublicKey(), logs.has("generated relay identity"))
	}
	// The same directory is the same identity, and it is not "generated" again.
	again := &logBuf{}
	o.Log = slog.New(slog.NewJSONHandler(again, nil))
	rel2, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	if rel2.PublicKey() != rel.PublicKey() || again.has("generated relay identity") {
		t.Fatal("identity not reused across restarts")
	}
	o.DataDir = t.TempDir()
	if other, err := New(o); err != nil || other.PublicKey() == rel.PublicKey() {
		t.Fatalf("another data dir shares the key (err %v)", err)
	}
	// No Log: slog's default logger, so the relay never logs to nil.
	o.Log, o.DataDir = nil, dir
	if def, err := New(o); err != nil || def.log != slog.Default() {
		t.Fatalf("logger without Log: %v", err)
	}
}

func TestNewWarnsAboutAReadableKeyAndBadReceipts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes")
	}
	dir := t.TempDir()
	o := Options{
		APIURL: "http://api.test", Token: "t", PublicURL: "https://relay.example", CapacityMbps: 10, DataDir: dir,
		Log: slog.New(slog.NewJSONHandler(io.Discard, nil)),
	}
	if _, err := New(o); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(dir, identity.KeyFile), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "receipts", "00000000000000000001-x.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	logs := &logBuf{}
	o.Log = slog.New(slog.NewJSONHandler(logs, nil))
	rel, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	if !logs.has("readable by other users") || !logs.has("receipt queue problem") {
		t.Fatalf("missing warnings: %s", logs.b.String())
	}
	if rel.queue.Len() != 0 {
		t.Fatal("a corrupt receipt was queued")
	}
}

func TestPickInterval(t *testing.T) {
	const def, lo, hi = 60 * time.Second, 10 * time.Second, time.Hour
	for _, tc := range []struct {
		override time.Duration
		api      int
		want     time.Duration
	}{
		{5 * time.Second, 30, 5 * time.Second}, // an override wins, even below lo
		{0, 0, def},
		{0, -3, def},
		{0, 30, 30 * time.Second},
		{0, 9, lo},
		{0, 10, lo},
		{0, 3600, hi},
		{0, 3601, hi},
	} {
		if got := pickInterval(tc.override, tc.api, def, lo, hi); got != tc.want {
			t.Errorf("pickInterval(%v, %d) = %v, want %v", tc.override, tc.api, got, tc.want)
		}
	}
}

func TestPullBase(t *testing.T) {
	for in, want := range map[string]string{
		"http://origin.test":        "http://origin.test/relay-pull/",
		"http://origin.test/":       "http://origin.test/relay-pull/",
		"https://origin.test/edge/": "https://origin.test/edge/relay-pull/",
		"https://origin.test/?x=1":  "https://origin.test/relay-pull/",
	} {
		u, err := pullBase(in)
		if err != nil || u.String() != want {
			t.Errorf("pullBase(%q) = %v, %v; want %s", in, u, err, want)
		}
	}
	for _, bad := range []string{"", "ftp://origin.test", "http://", "origin.test", "http://[::1"} {
		if _, err := pullBase(bad); err == nil {
			t.Errorf("pullBase(%q) accepted", bad)
		}
	}
}

func TestRegisterRefusesAnUnusableAnswer(t *testing.T) {
	for name, tc := range map[string]struct {
		mod  func(a *fakeAPI)
		want string
	}{
		"origin URL": {func(a *fakeAPI) { a.originURL = "ftp://origin.test" }, "invalid originUrl"},
		"origin key": {func(a *fakeAPI) { a.originKey = ed25519.PublicKey{1, 2, 3} }, "origin public key"},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			h.api.set(tc.mod)
			rel, _ := h.newRelay(nil)
			if err := rel.lockedRegister(context.Background()); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err %v, want %q", err, tc.want)
			}
			if rel.srv.State() != nil {
				t.Fatal("state installed from an unusable answer")
			}
		})
	}
}

func TestRegisterUnderANewIDClosesTheOldPeriod(t *testing.T) {
	const newID = "01890000-0000-7000-8000-0000000000bb"
	h := newHarness(t)
	rel, _ := h.newRelay(nil)
	ctx := context.Background()
	if err := rel.lockedRegister(ctx); err != nil {
		t.Fatal(err)
	}
	rel.ledger.AddBytes(sid(1), 1234)
	rel.ledger.AddSegment(sid(1))
	// The same id again: nothing to close out.
	if err := rel.lockedRegister(ctx); err != nil {
		t.Fatal(err)
	}
	if rel.queue.Len() != 0 {
		t.Fatal("re-registering under the same id cut the period")
	}
	h.api.set(func(a *fakeAPI) { a.registerID = newID })
	if err := rel.lockedRegister(ctx); err != nil {
		t.Fatal(err)
	}
	if got := queuedRelayIDs(t, rel); len(got) != 1 || got[0] != relayID {
		t.Fatalf("queued receipts under %v, want the old id once", got)
	}
	if st := rel.srv.State(); st == nil || st.RelayID != newID {
		t.Fatalf("state %+v", st)
	}
	// Bytes after the change are the new id's.
	rel.ledger.AddBytes(sid(1), 10)
	rel.closePeriod(time.Now())
	if got := queuedRelayIDs(t, rel); len(got) != 2 || got[1] != newID {
		t.Fatalf("queued receipts under %v", got)
	}
}

func TestDrainBeforeStartNeverRegisters(t *testing.T) {
	h := newHarness(t)
	rel, logs := h.newRelay(nil)
	rel.BeginDrain(time.Second)
	if !logs.has("draining before registration") {
		t.Fatal("no log for a drain before registration")
	}
	if err := rel.lockedRegister(context.Background()); err != errDraining {
		t.Fatalf("register while draining: %v", err)
	}
	rel.Start()
	time.Sleep(100 * time.Millisecond)
	if n := h.api.registrationCount(); n != 0 {
		t.Fatalf("%d registrations after a drain", n)
	}
	if len(h.api.beats()) != 0 {
		t.Fatal("heartbeat before registration")
	}
	if err := rel.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	// A second Shutdown (SIGTERM after a GracefulStop, say) is a no-op.
	if err := rel.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestBeginDrainSendsOneDrainingHeartbeat(t *testing.T) {
	h := newHarness(t)
	rel, _ := h.newRelay(nil)
	if err := rel.lockedRegister(context.Background()); err != nil {
		t.Fatal(err)
	}
	rel.BeginDrain(time.Second)
	rel.BeginDrain(time.Second)
	beats := h.api.beats()
	if len(beats) != 1 || !beats[0].Draining {
		t.Fatalf("heartbeats %+v", beats)
	}
	if h.health().Status != "draining" {
		t.Fatalf("healthz %+v", h.health())
	}
	// Normal heartbeats stop for good.
	if rel.heartbeat(context.Background()) || len(h.api.beats()) != 1 {
		t.Fatal("a normal heartbeat after the drain")
	}
}

func TestApplyHeartbeatAnswer(t *testing.T) {
	h := newHarness(t)
	rel, logs := h.newRelay(nil)
	// Before registration there is nothing to update.
	rel.apply(apiclient.HeartbeatResponse{Status: "active"})
	if rel.srv.State() != nil {
		t.Fatal("apply installed state before registration")
	}
	if err := rel.lockedRegister(context.Background()); err != nil {
		t.Fatal(err)
	}
	rel.apply(apiclient.HeartbeatResponse{Status: server.StatusSuspended, OriginPublicKey: "not-a-key"})
	st := rel.srv.State()
	if st.Status != server.StatusSuspended || !st.OriginKey.Equal(h.originPub) {
		t.Fatalf("after suspension with a bad key: %+v", st)
	}
	if !logs.has("SUSPENDED") || !logs.has("unusable origin key") {
		t.Fatal("suspension or bad key not logged")
	}
	newPub, _, _ := ed25519.GenerateKey(nil)
	rel.apply(apiclient.HeartbeatResponse{Status: "active", OriginPublicKey: tokens.EncodeB64URL(newPub)})
	if st := rel.srv.State(); st.Status != "active" || !st.OriginKey.Equal(newPub) || st.RelayID != relayID {
		t.Fatalf("after reinstatement: %+v", st)
	}
	if !logs.has("relay status changed") {
		t.Fatal("reinstatement not logged")
	}
	// No key in the answer keeps the current one.
	rel.apply(apiclient.HeartbeatResponse{Status: "active"})
	if !rel.srv.State().OriginKey.Equal(newPub) {
		t.Fatal("an empty key replaced the origin key")
	}
}

func TestRegistrationErrorsAreLoggedForTheOperator(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		want   string
	}{
		"refused token": {http.StatusUnauthorized, "refused the relay token"},
		"unavailable":   {http.StatusServiceUnavailable, "registration failed; retrying"},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			h.api.set(func(a *fakeAPI) { a.allFail = tc.status })
			rel, logs := h.newRelay(nil)
			rel.Start()
			defer rel.Shutdown(context.Background())
			h.eventually("registration error logged", func() bool { return logs.has(tc.want) })
			// It keeps retrying (a refused token might be a transient API fault too) until the API answers.
			h.api.set(func(a *fakeAPI) { a.allFail = 0 })
			h.eventually("registered", func() bool { return rel.srv.State() != nil })
		})
	}
}

func TestFailedReregistrationRetriesAtTheNextHeartbeat(t *testing.T) {
	h := newHarness(t)
	rel, logs := h.newRelay(func(o *Options) { o.HeartbeatInterval = 20 * time.Millisecond })
	rel.Start()
	defer rel.Shutdown(context.Background())
	h.eventually("registered", func() bool { return rel.srv.State() != nil })
	before := h.api.registrationCount()
	// Offline: register again; the answer is unusable, so each heartbeat tries once more.
	h.api.set(func(a *fakeAPI) {
		a.status = "offline"
		a.originURL = "ftp://origin.test"
	})
	h.eventually("re-registration retried", func() bool { return h.api.registrationCount() >= before+3 })
	if !logs.has("re-registration failed") {
		t.Fatal("failed re-registration not logged")
	}
	// The state from the last good registration stays.
	if st := rel.srv.State(); st == nil || st.Status != "active" || st.PullBase.Scheme != "http" {
		t.Fatalf("state %+v", st)
	}
	h.api.set(func(a *fakeAPI) {
		a.status = "active"
		a.originURL = h.origin.URL + "/"
	})
	n := h.api.registrationCount()
	time.Sleep(100 * time.Millisecond)
	if h.api.registrationCount() > n+1 {
		t.Fatal("still re-registering once the API is happy")
	}
}

func TestClosePeriod(t *testing.T) {
	t.Run("nothing served: no receipt", func(t *testing.T) {
		h := newHarness(t)
		rel, _ := h.newRelay(nil)
		if err := rel.lockedRegister(context.Background()); err != nil {
			t.Fatal(err)
		}
		rel.closePeriod(time.Now())
		if rel.queue.Len() != 0 {
			t.Fatal("empty period queued a receipt")
		}
	})

	t.Run("bytes without registration cannot be attributed", func(t *testing.T) {
		h := newHarness(t)
		rel, logs := h.newRelay(nil)
		rel.ledger.AddBytes(sid(1), 100)
		rel.closePeriod(time.Now())
		if rel.queue.Len() != 0 || !logs.has("without registration") {
			t.Fatal("unattributed bytes queued or not logged")
		}
	})

	t.Run("a full backlog drops the oldest", func(t *testing.T) {
		h := newHarness(t)
		rel, logs := h.newRelay(func(o *Options) { o.MaxPending = 1 })
		if err := rel.lockedRegister(context.Background()); err != nil {
			t.Fatal(err)
		}
		now := time.Now()
		rel.ledger.AddBytes(sid(1), 100)
		rel.closePeriod(now)
		first := rel.queue.Items()[0].Name
		rel.ledger.AddBytes(sid(2), 200)
		rel.closePeriod(now.Add(time.Second))
		items := rel.queue.Items()
		if len(items) != 1 || items[0].Name == first || !logs.has("dropped oldest") {
			t.Fatalf("queue %v", items)
		}
		if _, err := os.Stat(filepath.Join(h.dataDir, "receipts", first+".json")); !os.IsNotExist(err) {
			t.Fatalf("dropped receipt still on disk: %v", err)
		}
	})

	t.Run("a failing disk keeps the receipt in memory", func(t *testing.T) {
		if runtime.GOOS == "windows" || os.Geteuid() == 0 {
			t.Skip("needs a non-root POSIX user")
		}
		h := newHarness(t)
		rel, logs := h.newRelay(nil)
		if err := rel.lockedRegister(context.Background()); err != nil {
			t.Fatal(err)
		}
		dir := filepath.Join(h.dataDir, "receipts")
		if err := os.Chmod(dir, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
		rel.ledger.AddBytes(sid(1), 100)
		rel.closePeriod(time.Now())
		if rel.queue.Len() != 1 || !logs.has("could not persist receipt") {
			t.Fatalf("queue %d", rel.queue.Len())
		}
	})
}
