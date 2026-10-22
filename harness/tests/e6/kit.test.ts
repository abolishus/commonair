// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The E6 kit's pure parts and the overlay-token client, plus the DB helpers' table filters. */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { isHistoryTable, isPiiScanTable, quoteIdent } from "../../src/e6/db.ts";
import { exportsBucketConfig, rebaseHttp, tokenClient, tokenOf } from "../../src/e6/kit.ts";
import { loadHarnessEnv } from "../../src/env.ts";
import type { ScenarioContext } from "../../src/scenario.ts";

describe("URL helpers", () => {
  test("rebaseHttp keeps path, query and hash on the base's origin", () => {
    expect(rebaseHttp("https://commonair.example/overlay/alerts?token=t#x", "http://localhost:3000/ignored")).toBe(
      "http://localhost:3000/overlay/alerts?token=t#x",
    );
    expect(rebaseHttp("http://api:3001/overlay/events?token=a%2Bb", "http://localhost:3001")).toBe(
      "http://localhost:3001/overlay/events?token=a%2Bb",
    );
  });

  test("tokenOf reads ?token= and refuses a URL without one", () => {
    expect(tokenOf("http://h/overlay/alerts?token=abc")).toBe("abc");
    expect(() => tokenOf("http://h/overlay/alerts")).toThrow(/no token/);
  });
});

describe("exportsBucketConfig", () => {
  const ctxWith = (env: Record<string, string>) => ({
    ctx: { env: loadHarnessEnv(env) } as unknown as ScenarioContext,
  });
  const s3 = { S3_ENDPOINT: "http://localhost:3900", S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret" };

  test("the media credentials with the exports bucket", () => {
    expect(exportsBucketConfig(ctxWith(s3), {})?.bucket).toBe("commonair-exports");
    expect(exportsBucketConfig(ctxWith(s3), { S3_BUCKET_EXPORTS: "x-exports" })?.bucket).toBe("x-exports");
  });

  test("null without credentials", () => {
    expect(exportsBucketConfig(ctxWith({}), {})).toBeNull();
  });
});

describe("tokenClient", () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: {
    path: string;
    token: string | null;
    auth: string | null;
    cookie: string | null;
    origin: string | null;
  }[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push({
          path: url.pathname,
          token: url.searchParams.get("token"),
          auth: req.headers.get("authorization"),
          cookie: req.headers.get("cookie"),
          origin: req.headers.get("origin"),
        });
        return Response.json(
          { defined: false, code: "UNAUTHORIZED", status: 401, message: "no", data: {} },
          {
            status: 401,
          },
        );
      },
    });
  });
  afterAll(() => server.stop(true));

  test("query mode sends ?token= and no credentials header", async () => {
    seen.length = 0;
    const c = tokenClient(`http://localhost:${server.port}`, "tok", "query", "http://localhost:3000");
    await expect(c.me.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(seen[0]).toMatchObject({ token: "tok", auth: null, cookie: null, origin: "http://localhost:3000" });
    expect(seen[0]?.path.startsWith("/rpc/")).toBe(true);
  });

  test("bearer mode sends Authorization and no query token", async () => {
    seen.length = 0;
    const c = tokenClient(`http://localhost:${server.port}/`, "tok", "bearer");
    await expect(c.interact.alerts.list({ channel: "abc" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(seen[0]).toMatchObject({ token: null, auth: "Bearer tok", cookie: null });
  });
});

describe("DB helper table filters", () => {
  test("the deletion PII scan covers the retained tables only", () => {
    for (const t of [
      "ledger_accounts",
      "ledger_transactions",
      "ledger_entries",
      "payments",
      "tips",
      "audit_log",
      "events",
      "webhook_deliveries",
      "vote_history",
      "membership_history",
      "governance_settings_history",
    ])
      expect(isPiiScanTable(t), t).toBe(true);
    for (const t of ["users", "sessions", "chat_messages", "ledger", "history", "payments_x", "_history"])
      expect(isPiiScanTable(t), t).toBe(false);
  });

  test("history tables", () => {
    expect(isHistoryTable("vote_history")).toBe(true);
    expect(isHistoryTable("history")).toBe(false);
    expect(isHistoryTable("Vote_history")).toBe(false);
  });

  test("quoteIdent accepts plain names only", () => {
    expect(quoteIdent("audit_log")).toBe('"audit_log"');
    expect(() => quoteIdent('a"; drop table x; --')).toThrow(/refusing identifier/);
    expect(() => quoteIdent("A")).toThrow(/refusing identifier/);
    expect(() => quoteIdent("1a")).toThrow(/refusing identifier/);
  });
});
