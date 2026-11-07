// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Staging seed mode (ADR 0040) gives the stack what the local seed stack's compose overrides give
 * it (scripts/infra.ts HARNESS_OVERRIDES, CAPTIONS_OVERRIDE, W3_OVERRIDES, SEED_OVERRIDE): the
 * block selfhost.sh writes into commonair.env, the features it leaves on, and the drop-ins for what
 * the units pin themselves. Every peer is the harness container instead of host.containers.internal.
 * Static: reads the files, runs nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { CAPTIONS_OVERRIDE, HARNESS_OVERRIDES, SEED_OVERRIDE, W3_OVERRIDES } from "../infra.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const SH = read("scripts/selfhost.sh");
const values = (text: string, key: string) => [...text.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!);
const kv = (lines: string[]) =>
  Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const));

const HARNESS_HOST = /^SEED_HARNESS_HOST=(\S+)$/m.exec(SH)![1]!;

/** The block seed_block_body prints, with the harness host filled in and $1 as <secret>. */
const BLOCK = kv(
  /^seed_block_body\(\) \{\n {2}cat <<EOF\n([\s\S]*?)\nEOF\n\}$/m
    .exec(SH)![1]!
    .replaceAll("$SEED_HARNESS_HOST", HARNESS_HOST)
    .replaceAll("$1", "<secret>")
    .split("\n"),
);
const KEEP_ON = kv(/^SEED_KEEP_ON="([^"]+)"$/m.exec(SH)![1]!.split(" "));
const dropin = (unit: string) => kv(values(read(`infra/selfhost/seed-mode/commonair-${unit}.conf`), "Environment"));
const DROPINS: Record<string, Record<string, string>> = {
  api: dropin("api"),
  worker: dropin("worker"),
  media: dropin("media"),
};
const keyList = (unit: string) =>
  read(`infra/selfhost/env/commonair-${unit}.keys`)
    .split("\n")
    .filter((l) => l && !l.startsWith("#"));

/** The services seed mode changes; the overrides' replicas (api-2, …) are the same services. */
const SERVICES = ["api", "worker", "media", "chat", "migrate"] as const;
const overrides = [...HARNESS_OVERRIDES, CAPTIONS_OVERRIDE, ...W3_OVERRIDES, SEED_OVERRIDE];
const composeEnv: Record<string, Record<string, string>> = Object.fromEntries(SERVICES.map((s) => [s, {}]));
for (const file of overrides) {
  const doc = Bun.YAML.parse(read(file)) as { services?: Record<string, { environment?: Record<string, unknown> }> };
  for (const s of SERVICES) Object.assign(composeEnv[s]!, doc.services?.[s]?.environment ?? {});
}

/** What compose sets that seed mode does not, and why. */
const NOT_IN_SEED_MODE: Record<string, string> = {
  // The P2P scenario's tracker proxy on the harness host; the seed has no P2P viewers.
  P2P_TRACKER_URL: "harness tracker proxy (p2p scenario only)",
  // The captions scenario's capacity step; seed mode keeps the instance's own limit.
  CAPTIONS_MAX_STREAMS: "captions capacity step only",
  // The harness's 2 s grace (compose.live-grace.yaml) only keeps scenario offline waits short.
  // Seed mode keeps the production grace, so a seeded publisher's restart continues its broadcast.
  LIVE_RECONNECT_GRACE_SECONDS: "harness offline waits only; seed mode keeps the production grace",
};
/** Preconditions seed-mode open checks instead of setting. */
const REQUIRED = { DEMO_SEED_FULL: "true", WHISPER_URL: "http://whisper:8080" };

/** host.containers.internal (the host, from compose's containers) is the harness container in seed mode. */
const inSeedMode = (v: string) => v.replaceAll("host.containers.internal", HARNESS_HOST);
const same = (a: string, b: string) => {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return a === b;
  }
};

describe("seed mode matches the local seed stack's overrides", () => {
  test.each(SERVICES)("%s: every override value is in the block, left on, in a drop-in, or required", (service) => {
    const env = composeEnv[service]!;
    expect(Object.keys(env).length).toBeGreaterThan(0);
    const problems: string[] = [];
    let checked = 0;
    for (const [k, raw] of Object.entries(env)) {
      const v = inSeedMode(String(raw));
      if (k in NOT_IN_SEED_MODE) continue;
      // The key lists hold what each service reads (unit-env.ts); compose's shared anchors also
      // hand media a few keys it never reads (MODERATION_CLASSIFIER, MODERATION_TEST_HOOKS).
      const fromDropin = k in (DROPINS[service] ?? {});
      if (!fromDropin && !keyList(service).includes(k)) continue;
      checked++;
      const got = DROPINS[service]?.[k] ?? BLOCK[k] ?? KEEP_ON[k] ?? REQUIRED[k as keyof typeof REQUIRED];
      if (got === undefined) problems.push(`${k}: not set by seed mode`);
      else if (!same(got, v)) problems.push(`${k}: seed mode sets ${got}, compose ${v}`);
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });

  test("the block adds only email to Mailpit and the run's own webhook secret beyond the overrides", () => {
    const all = Object.assign({}, ...Object.values(composeEnv)) as Record<string, string>;
    const extra = Object.keys(BLOCK).filter((k) => !(k in all));
    expect(extra.sort()).toEqual(
      [
        "SMTP_HOST",
        "SMTP_PASSWORD",
        "SMTP_PORT",
        "SMTP_REQUIRE_TLS",
        "SMTP_SECURE",
        "SMTP_USER",
        "STRIPE_WEBHOOK_SECRET",
      ].sort(),
    );
    expect(BLOCK).toMatchObject({
      SMTP_HOST: "mailpit",
      SMTP_PORT: "1025",
      SMTP_USER: "",
      SMTP_PASSWORD: "",
      STRIPE_WEBHOOK_SECRET: "<secret>",
    });
    // compose's own app environment points SMTP at the same Mailpit.
    const compose = Bun.YAML.parse(read("compose.yaml")) as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    expect(compose.services.api!.environment.SMTP_HOST).toBe(BLOCK.SMTP_HOST);
    expect(compose.services.api!.environment.SMTP_PORT).toBe(BLOCK.SMTP_PORT);
  });

  test("the features that stay on are exactly decision 2's, at the overrides' values", () => {
    expect(KEEP_ON).toEqual({
      GIVEAWAYS_ENABLED: "true",
      CHAT_WATCH_GATE: "on",
      CHAT_SURGE_GUARD: "on",
      WEB_PUSH_ENABLED: "true",
    });
    for (const k of Object.keys(KEEP_ON)) expect(BLOCK[k], k).toBeUndefined();
    // And what decision 2 restores or removes is in the block, so close restores it.
    for (const k of [
      "FEDERATION_ENABLED",
      "TWITCH_IMPORT_ENABLED",
      "PAYMENTS_PROVIDER",
      "STRIPE_SECRET_KEY",
      "STRIPE_API_BASE",
      "STRIPE_WEBHOOK_SECRET",
      "INFRA_COST_MODEL",
      "GOVERNANCE_BOOTSTRAP_JSON",
      "OUTBOUND_ALLOW_PRIVATE_NETWORKS",
      "MODERATION_TEST_HOOKS",
      "COOP_TEST_HOOKS",
      "OPS_TEST_HOOKS",
      "INTERACT_TEST_HOOKS",
      "EVENTSUB_ALLOW_INSECURE_CALLBACKS",
      "WEB_PUSH_ALLOW_INSECURE_ENDPOINTS",
    ])
      expect(BLOCK[k], k).toBeDefined();
  });

  test("the Twitch import points at the harness's Twitch mock, by the container's name", () => {
    // harness/tests/seed/platform.test.ts checks these against twitchMockBases itself.
    const port = /^export const TWITCH_MOCK_PORT = (\d+);$/m.exec(read("harness/src/seed/platform/portability.ts"))![1];
    expect(BLOCK.TWITCH_API_BASE_URL).toBe(`http://${HARNESS_HOST}:${port}/helix`);
    expect(BLOCK.TWITCH_AUTH_BASE_URL).toBe(`http://${HARNESS_HOST}:${port}/oauth2`);
    expect(BLOCK.TWITCH_IMAGE_HOSTS).toBe(HARNESS_HOST);
    expect(Object.values(BLOCK).join("\n")).not.toContain("host.containers.internal");
  });

  test("the harness container is the host the stack calls back, and the one the API trusts", () => {
    const unit = read("infra/quadlet/commonair-seed-harness.container");
    expect(values(unit, "NetworkAlias")).toEqual([HARNESS_HOST]);
    const env = kv(values(unit, "Environment"));
    expect(env.HARNESS_WEBHOOK_HOST).toBe(HARNESS_HOST);
    expect(env.HARNESS_RELAY_HOST).toBe(HARNESS_HOST);
    expect(env.HARNESS_API_URL).toBe("http://api:3001");
    expect(env.HARNESS_MAILPIT_URL).toBe("http://mailpit:8025");
    expect(env.HARNESS_STRIPE_MOCK_URL).toBe(BLOCK.STRIPE_API_BASE);
    expect(DROPINS.api!.TRUSTED_PROXY_CIDRS!.split(",")).toContain(`${values(unit, "IP")[0]}/32`);
    // The seed's --confirm names the app role's database as create_secrets writes its URL.
    expect(SH).toContain('SEED_DB_TARGET="postgres:5432/commonair"');
    expect(SH).toContain("printf 'postgres://commonair_app:%s@postgres:5432/commonair'");
    expect(values(unit, "Secret")).toEqual(["commonair-database-url,type=env,target=DATABASE_URL"]);
  });

  test("the hash-list drop-ins mount the synthetic fixtures the trust-safety override uses", () => {
    const ts = Bun.YAML.parse(read("harness/compose.trust-safety.yaml")) as {
      services: Record<string, { environment: Record<string, string>; volumes: string[] }>;
    };
    for (const s of ["api", "worker", "media"]) {
      expect(DROPINS[s]!.MODERATION_HASHLIST_CSAM).toBe(ts.services[s]!.environment.MODERATION_HASHLIST_CSAM);
      expect(DROPINS[s]!.MODERATION_HASHLIST_NCII).toBe(ts.services[s]!.environment.MODERATION_HASHLIST_NCII);
      const vols = values(read(`infra/selfhost/seed-mode/commonair-${s}.conf`), "Volume");
      expect(vols).toEqual([
        "%h/commonair/packages/moderation/fixtures/csam.pdq:/fixtures/moderation/csam.pdq:ro,z",
        "%h/commonair/packages/moderation/fixtures/ncii.pdq:/fixtures/moderation/ncii.pdq:ro,z",
      ]);
    }
  });
});
