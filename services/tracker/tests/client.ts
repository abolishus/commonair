// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Test clients for the tracker: a JSON WebSocket peer and a raw HTTP upgrade probe. */

export type Msg = Record<string, unknown>;

export class Peer {
  readonly messages: Msg[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: (() => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      this.messages.push(JSON.parse(String(e.data)) as Msg);
      this.wake();
    });
    ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
      this.wake();
    });
  }

  static open(url: string, headers: Record<string, string> = {}): Promise<Peer> {
    return new Promise((resolve, reject) => {
      // Bun's WebSocket accepts request headers (used for X-Forwarded-For).
      const ws = new WebSocket(url, { headers } as unknown as string[]);
      const peer = new Peer(ws);
      ws.addEventListener("open", () => resolve(peer), { once: true });
      ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
      ws.addEventListener("close", (e) => reject(new Error(`closed before open: ${e.code}`)), { once: true });
    });
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** Resolve with the first message matching `pred`. */
  async next(pred: (m: Msg) => boolean, ms = 3000): Promise<Msg> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.messages.find(pred);
      if (hit) {
        this.messages.splice(this.messages.indexOf(hit), 1);
        return hit;
      }
      if (this.closed) throw new Error(`closed (${this.closed.code}) while waiting`);
      const left = end - Date.now();
      if (left <= 0) throw new Error("no matching message in time");
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  async waitClosed(ms = 3000): Promise<{ code: number; reason: string }> {
    const end = Date.now() + ms;
    while (!this.closed) {
      if (Date.now() > end) throw new Error("socket not closed in time");
      await Bun.sleep(10);
    }
    return this.closed;
  }
}

/** Send a raw WebSocket upgrade request and return the HTTP status line's code. */
export function upgradeStatus(base: URL, path: string, headers: Record<string, string> = {}): Promise<number> {
  const extra = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  return new Promise((resolve, reject) => {
    let buf = "";
    let done = false;
    void Bun.connect({
      hostname: base.hostname,
      port: Number(base.port),
      socket: {
        open(s) {
          s.write(
            `GET ${path} HTTP/1.1\r\nHost: tracker\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
              `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
          );
        },
        data(s, d) {
          buf += d.toString();
          const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
          if (m && !done) {
            done = true;
            resolve(Number(m[1]));
            s.end();
          }
        },
        close() {
          if (!done) reject(new Error("closed without a status line"));
        },
        error(_s, e) {
          if (!done) reject(e);
        },
      },
    }).catch(reject);
  });
}
