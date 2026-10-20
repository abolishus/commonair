// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Static policy checks on compose.yaml (rootless rules, pinned licensed images,
 * healthchecks, least-privilege DB access) and its Quadlet mirror.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vite-plus/test";

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

interface Service {
  image?: string;
  build?: { context?: string; dockerfile?: string; args?: Record<string, string> };
  profiles?: string[];
  privileged?: boolean;
  cap_add?: string[];
  network_mode?: string;
  pid?: string;
  ipc?: string;
  userns_mode?: string;
  security_opt?: string[];
  devices?: string[];
  restart?: string;
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  env_file?: { path: string; required: boolean }[];
  healthcheck?: { test?: string[]; disable?: boolean };
  depends_on?: Record<string, { condition: string }>;
}
interface Compose {
  name: string;
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
}

const compose = parse(read("compose.yaml"), { merge: true }) as Compose;
const services = Object.entries(compose.services);
const registry = JSON.parse(read("infra/image-licenses.json")) as Record<string, { license: string; tag: string }>;

const ONE_SHOT = new Set(["migrate", "garage-init"]);
const OWN_IMAGE = /^\$\{IMAGE_REGISTRY:-localhost\/commonair\}\/([a-z-]+):\$\{IMAGE_TAG:-dev\}$/;
const PINNED = /^([a-z0-9.-]+\.[a-z]+(?::\d+)?\/[a-z0-9._/-]+):([A-Za-z0-9._-]+)$/;

/** `${VAR:-default}` → default (or the literal when not templated). */
const defaultOf = (s: string) => s.replace(/\$\{[A-Z0-9_]+:-([^}]*)\}/g, "$1");

/** Split a short-syntax port into [address, host, container] honouring `${...}` templates. */
function splitPort(spec: string): { address: string; host: string; container: string } {
  const parts = spec.match(/(\$\{[^}]+\}|[^:]+)/g) ?? [];
  if (parts.length !== 3) throw new Error(`port ${spec} must be address:host:container`);
  return { address: parts[0]!, host: parts[1]!, container: parts[2]!.replace(/\/(tcp|udp)$/, "") };
}

function assertPinned(ref: string, where: string) {
  const m = PINNED.exec(ref);
  expect(m, `${where}: ${ref} must be fully qualified with a pinned tag`).not.toBeNull();
  const [, repo, tag] = m!;
  expect(tag, `${where}: ${ref} uses a floating tag`).not.toMatch(/^(latest|main|nightly|edge)$/);
  const entry = registry[repo!];
  expect(entry, `${where}: ${repo} missing from infra/image-licenses.json`).toBeDefined();
  expect(entry!.tag, `${where}: image-licenses.json records ${entry!.tag} for ${repo}`).toBe(tag);
}

describe("compose.yaml: rootless rules", () => {
  test("keeps the existing service names and project name", () => {
    expect(compose.name).toBe("commonair");
    for (const s of ["postgres", "valkey", "mailpit"]) expect(compose.services[s]).toBeDefined();
  });

  test.each(services)("%s: no privileged mode, host namespaces, extra capabilities or devices", (_, s) => {
    expect(s.privileged ?? false).toBe(false);
    expect(s.cap_add ?? []).toEqual([]);
    expect(s.devices ?? []).toEqual([]);
    for (const ns of [s.network_mode, s.pid, s.ipc, s.userns_mode]) expect(ns ?? "").not.toBe("host");
    for (const opt of s.security_opt ?? []) expect(opt).not.toMatch(/unconfined|label=disable/);
  });

  test.each(services)("%s: host ports ≥ 1024, env-configurable, bound to BIND_ADDRESS", (name, s) => {
    for (const spec of s.ports ?? []) {
      const { address, host, container } = splitPort(spec);
      expect(host, `${name}: host port must be configurable via env`).toMatch(/^\$\{[A-Z0-9_]+_PORT:-\d+\}$/);
      expect(Number(defaultOf(host))).toBeGreaterThanOrEqual(1024);
      expect(Number(container)).toBeGreaterThan(0);
      // Caddy is the public entry point (tls profile) and has its own bind variable.
      expect(address).toBe(name === "caddy" ? "${CADDY_BIND_ADDRESS:-0.0.0.0}" : "${BIND_ADDRESS:-127.0.0.1}");
    }
  });

  test("host port variables are unique, so a second stack can shift them all", () => {
    const seen = new Map<string, string>();
    for (const [name, s] of services)
      for (const spec of s.ports ?? []) {
        const { host } = splitPort(spec);
        const proto = spec.endsWith("/udp") ? "udp" : "tcp";
        const key = `${host}/${proto}`;
        expect(seen.get(key), `${name} reuses ${key} from ${seen.get(key)}`).toBeUndefined();
        seen.set(key, name);
      }
  });

  test.each(services)("%s: no engine sockets; named volumes or read-only repo binds", (name, s) => {
    const problems = (s.volumes ?? []).flatMap((v) => {
      const [src = "", , mode = ""] = v.split(":");
      if (/(docker|podman)\.sock|\/run\/(user\/\d+\/)?(podman|docker)/.test(v)) return [`${v}: engine socket`];
      if (src.startsWith("./"))
        return /\bro\b/.test(mode) && src.startsWith("./infra/") ? [] : [`${v}: bind must be ./infra/… and :ro`];
      return Object.hasOwn(compose.volumes, src) ? [] : [`${v}: volume ${src} not declared`];
    });
    expect(problems, name).toEqual([]);
  });
});

describe("compose.yaml: images", () => {
  test.each(services)("%s: pinned, fully qualified and licensed, or built from this repo", (name, s) => {
    // Our own images carry a build section; everything else must be a pinned, licensed upstream ref.
    const own = OWN_IMAGE.test(s.image ?? "");
    expect(Boolean(s.build), `${name}: build section iff the image is ours`).toBe(own);
    expect(s.build?.context ?? ".").toBe(".");
    expect(existsSync(join(ROOT, s.build?.dockerfile ?? "compose.yaml"))).toBe(true);
    const upstream = own ? s.build?.args?.BASE_IMAGE : s.image;
    for (const ref of upstream ? [upstream] : []) assertPinned(ref, name);
  });

  test("Containerfile base images are pinned and licensed", () => {
    for (const file of [
      "infra/postgres/Containerfile",
      "infra/containers/service.Containerfile",
      "infra/containers/probe.Containerfile",
    ]) {
      for (const m of read(file).matchAll(/^ARG [A-Z_]+_IMAGE=(\S+)$/gm)) assertPinned(m[1]!, file);
      for (const m of read(file).matchAll(/^FROM (\S+)/gm))
        expect(m[1], `${file}: FROM must use a pinned ARG`).toMatch(/^\$\{[A-Z_]+_IMAGE\}$/);
    }
  });

  test("WAL-G download is checksum-verified for both architectures", () => {
    const cf = read("infra/postgres/Containerfile");
    expect(cf).toMatch(/WALG_VERSION=v3\.0\.9/);
    expect(cf).toMatch(/WALG_SHA256_AMD64=[0-9a-f]{64}/);
    expect(cf).toMatch(/WALG_SHA256_ARM64=[0-9a-f]{64}/);
    expect(cf).toContain("sha256sum -c -");
    expect(cf).toContain("archive_command=timeout 20 wal-g wal-push %p");
    expect(cf).toContain("archive_timeout=60");
  });
});

describe("compose.yaml: lifecycle", () => {
  const longRunning = services.filter(([n]) => !ONE_SHOT.has(n));
  const oneShots = services.filter(([n]) => ONE_SHOT.has(n));

  test.each(longRunning)("%s: healthcheck and restart policy", (name, s) => {
    expect(s.restart).toBe("unless-stopped");
    expect(s.healthcheck?.test?.length, `${name} needs a healthcheck`).toBeGreaterThan(0);
  });

  test.each(oneShots)("%s: one-shot job runs once, no healthcheck", (_, s) => {
    expect(s.restart).toBe("no");
    expect(s.healthcheck?.disable).toBe(true);
  });

  test.each(services)("%s: depends_on targets exist and use the right condition", (name, s) => {
    const problems = Object.entries(s.depends_on ?? {}).flatMap(([dep, { condition }]) => {
      const target = compose.services[dep];
      if (!target) return [`unknown ${dep}`];
      const want = ONE_SHOT.has(dep) ? "service_completed_successfully" : "service_healthy";
      // A default-profile service must not wait on an optional-profile one.
      return [
        ...(condition === want ? [] : [`${dep}: ${condition}, want ${want}`]),
        ...(!s.profiles && target.profiles ? [`${dep} is behind a profile`] : []),
      ];
    });
    expect(problems, name).toEqual([]);
  });

  test("optional profiles", () => {
    expect(compose.services["mock-rtmp"]?.profiles).toEqual(["harness"]);
    expect(compose.services["stripe-mock"]?.profiles).toEqual(["stripe"]);
    expect(compose.services.caddy?.profiles).toEqual(["tls"]);
    expect(compose.services.tracker?.profiles).toEqual(["p2p"]);
    const optional = services.filter(([, s]) => s.profiles).map(([n]) => n);
    expect(optional.sort()).toEqual(["caddy", "mock-rtmp", "stripe-mock", "tracker"]);
  });

  test("every platform service is present", () => {
    const expected = [
      "postgres",
      "migrate",
      "valkey",
      "garage",
      "garage-init",
      "mailpit",
      "mediamtx",
      "mock-rtmp",
      "api",
      "chat",
      "irc",
      "origin",
      "media",
      "worker",
      "tracker",
      "web",
      "otel-collector",
      "prometheus",
      "loki",
      "tempo",
      "grafana",
      "caddy",
      "stripe-mock",
    ];
    expect(Object.keys(compose.services).sort()).toEqual(expected.sort());
  });
});

describe("compose.yaml: configuration and secrets", () => {
  const withDb = services.filter(([, s]) => s.environment?.DATABASE_URL);
  test("services that need the database are the app services and migrate", () => {
    expect(withDb.map(([n]) => n).sort()).toEqual(
      ["api", "chat", "irc", "media", "migrate", "origin", "tracker", "web", "worker"].sort(),
    );
  });
  test.each(withDb)("%s: DATABASE_URL uses the least-privilege app role (owner only for migrate)", (name, s) => {
    const url = s.environment?.DATABASE_URL ?? "";
    const user = /^postgres:\/\/([^:]+):/.exec(url)?.[1];
    expect(user).toBe(name === "migrate" ? "commonair" : "commonair_app");
    expect(url).toMatch(/@postgres:5432\/commonair$/);
  });

  test("evidence secrets reach only the services ADR 0006 Q4 allows", () => {
    for (const name of ["api", "chat", "irc", "origin", "media", "worker", "tracker", "web"]) {
      const env = compose.services[name]!.environment!;
      const bucketKey = name === "worker" ? "${S3_EVIDENCE_ACCESS_KEY_ID:-}" : "";
      expect(env.S3_EVIDENCE_ACCESS_KEY_ID, name).toBe(bucketKey);
      expect(env.S3_EVIDENCE_SECRET_ACCESS_KEY, name).toBe(
        name === "worker" ? "${S3_EVIDENCE_SECRET_ACCESS_KEY:-}" : "",
      );
      expect(env.EVIDENCE_PRIVATE_KEY, name).toBe(name === "api" ? "${EVIDENCE_PRIVATE_KEY:-}" : "");
      expect(env.ONNXRUNTIME_NODE_INSTALL, name).toBe("skip");
      const quadlet = read(`infra/quadlet/commonair-${name}.container`);
      expect(quadlet.includes("Environment=S3_EVIDENCE_ACCESS_KEY_ID=\n"), name).toBe(name !== "worker");
      expect(quadlet.includes("Environment=EVIDENCE_PRIVATE_KEY=\n"), name).toBe(name !== "api");
    }
  });

  test("every app service gets the app-role URL and in-network endpoints", () => {
    for (const name of ["api", "chat", "irc", "origin", "media", "worker", "tracker", "web"]) {
      const env = compose.services[name]!.environment!;
      expect(env.DATABASE_URL, name).toContain("commonair_app:${POSTGRES_APP_PASSWORD:-}@postgres");
      expect(env.VALKEY_URL).toBe("redis://valkey:6379");
      expect(env.S3_ENDPOINT).toBe("http://garage:3900");
      expect(env.API_INTERNAL_URL).toBe("http://api:3001");
      expect(env.CHAT_INTERNAL_URL).toBe("ws://chat:3002/ws");
      expect(env.ORIGIN_INTERNAL_URL).toBe("http://origin:3003");
      expect(env.SMTP_HOST).toBe("mailpit");
      expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://otel-collector:4318");
      expect(env.OTEL_SERVICE_NAME).toBe(name);
      expect(compose.services[name]!.env_file).toEqual([{ path: "${COMMONAIR_ENV_FILE:-.env}", required: false }]);
    }
  });

  test("no secret has a literal default in compose (only the dev Postgres owner password)", () => {
    const text = read("compose.yaml");
    const defaults = [
      ...text.matchAll(/\$\{([A-Z0-9_]*(?:SECRET[A-Z0-9_]*|TOKEN|PASSWORD|_KEY|_KEY_ID)):-([^}]*)\}/g),
    ].map((m) => `${m[1]}=${m[2]}`);
    expect(defaults.length).toBeGreaterThan(5);
    expect(defaults.filter((d) => !d.endsWith("=") && d !== "POSTGRES_PASSWORD=commonair")).toEqual([]);
  });

  test("grafana: no anonymous access, no phoning home, refuses the default password", () => {
    const g = compose.services.grafana!;
    expect(g.environment?.GF_AUTH_ANONYMOUS_ENABLED).toBe("false");
    expect(g.environment?.GF_ANALYTICS_REPORTING_ENABLED).toBe("false");
    expect(g.environment?.GF_SECURITY_ADMIN_PASSWORD).toBe("${GRAFANA_ADMIN_PASSWORD:-}");
    expect(JSON.stringify(g)).toContain("GRAFANA_ADMIN_PASSWORD is required");
  });

  test("garage region matches the S3_REGION default", () => {
    const region = /^s3_region = "([^"]+)"/m.exec(read("infra/garage/garage.toml"))?.[1];
    const envDefault = /^S3_REGION=(.*)$/m.exec(read(".env.example"))?.[1];
    expect(region).toBe(envDefault);
    expect(read("infra/garage/garage.toml")).not.toMatch(/rpc_secret|admin_token/);
  });

  test("migrate applies the app role after migrations", () => {
    const cmd = compose.services.migrate!.environment!;
    expect(cmd.POSTGRES_APP_PASSWORD).toBe("${POSTGRES_APP_PASSWORD:-}");
    expect(JSON.stringify(compose.services.migrate)).toContain(
      "bun packages/db/src/migrate.ts && bun infra/postgres/apply-app-role.ts",
    );
    const sql = read("infra/postgres/app-role.sql");
    expect(sql).toContain("SELECT commonair_configure_app_role('commonair_app')");
    expect(sql).toMatch(/REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC/);
    expect(sql).toMatch(/NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
    // The password is passed as a setting, never interpolated into SQL text.
    expect(sql).toContain("current_setting('commonair.app_password', true)");
  });
});

describe("Caddyfile", () => {
  const caddy = read("infra/caddy/Caddyfile");
  test("blocks /internal before any proxy route", () => {
    const block = caddy.indexOf("handle @internal");
    expect(block).toBeGreaterThan(0);
    expect(caddy.slice(block, caddy.indexOf("}", block))).toContain("respond 404");
    expect(block).toBeLessThan(caddy.indexOf("reverse_proxy"));
  });
  test("routes and security headers", () => {
    for (const route of ["/api/*", "/rpc/*", "/chat", "/hls/*", "/relay-pull/*", "/cdn/*", "/tracker*"])
      expect(caddy).toContain(route);
    expect(caddy).toContain("{$PUBLIC_HOSTNAME:localhost}");
    expect(caddy).toContain("Strict-Transport-Security");
    expect(caddy).toContain("Content-Security-Policy");
    expect(caddy).toContain("frame-ancestors 'none'");
  });
});

describe("Quadlet mirror", () => {
  const dir = join(ROOT, "infra/quadlet");
  const units = Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".container"))
      .map((f) => [f.replace(/^commonair-|\.container$/g, ""), readFileSync(join(dir, f), "utf8")]),
  );
  const keys = (unit: string, key: string) => [...unit.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!);
  // Dev/test-only services have no production unit.
  const DEV_ONLY = new Set(["mailpit", "mock-rtmp", "stripe-mock"]);

  test("every production compose service has a unit, and nothing else does", () => {
    const expected = services.map(([n]) => n).filter((n) => !DEV_ONLY.has(n));
    expect(Object.keys(units).sort()).toEqual(expected.sort());
  });

  test.each(services.filter(([n]) => !DEV_ONLY.has(n)))("%s: same image, alias and health as compose", (name, s) => {
    const unit = units[name]!;
    const [image] = keys(unit, "Image");
    const own = OWN_IMAGE.exec(s.image ?? "");
    expect(image).toBe(own ? `localhost/commonair/${own[1]}:latest` : s.image);
    expect(keys(unit, "NetworkAlias")).toEqual([name]);
    expect(keys(unit, "Network")).toEqual(["commonair.network"]);
    expect(/^Type=oneshot$/m.test(unit)).toBe(ONE_SHOT.has(name));
    expect(keys(unit, "HealthCmd")).toHaveLength(ONE_SHOT.has(name) ? 0 : 1);
    const badVolumes = keys(unit, "Volume").filter((v) => {
      const src = v.slice(0, v.indexOf(":"));
      return src.endsWith(".volume") ? !existsSync(join(dir, src)) : !v.endsWith(":ro,Z");
    });
    expect(badVolumes).toEqual([]);
    const missingDeps = Object.keys(s.depends_on ?? {}).filter(
      (d) => !unit.includes(`Requires=commonair-${d}.service`),
    );
    expect(missingDeps).toEqual([]);
    const prefix = name === "caddy" ? "0.0.0.0:" : "127.0.0.1:";
    expect(keys(unit, "PublishPort").filter((p) => !p.startsWith(prefix))).toEqual([]);
    const dbSecret = /^Secret=commonair-(owner-)?database-url,type=env,target=DATABASE_URL$/m.test(unit);
    expect(dbSecret).toBe(Boolean(s.environment?.DATABASE_URL));
  });

  test("the network subnet default matches the trusted proxy default", () => {
    const raw = readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8");
    expect(raw).toContain("subnet: ${COMPOSE_SUBNET:-10.89.42.0/24}");
    expect(compose.services.api!.environment!.TRUSTED_PROXY_CIDRS).toBe("${TRUSTED_PROXY_CIDRS:-10.89.42.0/24}");
  });

  test("app units carry the same in-network environment as compose", () => {
    const appEnv = compose.services.api!.environment!;
    // Compose lets .env override it; the units pin the network's subnet.
    expect(appEnv.TRUSTED_PROXY_CIDRS).toBe("${TRUSTED_PROXY_CIDRS:-10.89.42.0/24}");
    for (const name of ["api", "chat", "irc", "origin", "media", "worker", "tracker", "web"]) {
      const env = Object.fromEntries(
        keys(units[name]!, "Environment").map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]),
      );
      for (const [k, v] of Object.entries(appEnv)) {
        if (k === "DATABASE_URL" || k.startsWith("SMTP_") || k === "OTEL_SERVICE_NAME") continue;
        // Per-service evidence scoping is checked by its own test above.
        if (k.startsWith("S3_EVIDENCE_") || k === "EVIDENCE_PRIVATE_KEY") continue;
        const expected = k === "TRUSTED_PROXY_CIDRS" ? "10.89.42.0/24" : v;
        expect(env[k], `${name}: ${k}`).toBe(expected);
      }
    }
  });
});
