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
  init?: boolean;
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
// Tag for humans and image-licenses.json, digest because tags are mutable (ADR 0022).
const PINNED = /^([a-z0-9.-]+\.[a-z]+(?::\d+)?\/[a-z0-9._/-]+):([A-Za-z0-9._-]+)@sha256:[0-9a-f]{64}$/;

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
  expect(m, `${where}: ${ref} must be fully qualified, pinned as name:tag@sha256:<digest>`).not.toBeNull();
  const [, repo, tag] = m!;
  expect(tag, `${where}: ${ref} uses a floating tag`).not.toMatch(/^(latest|main|nightly|edge)$/);
  const entry = registry[repo!];
  expect(entry, `${where}: ${repo} missing from infra/image-licenses.json`).toBeDefined();
  expect(entry!.tag, `${where}: image-licenses.json records ${entry!.tag} for ${repo}`).toBe(tag);
}

describe("compose.yaml: rootless rules", () => {
  test("publishes worker health for host-run harness scenarios", () => {
    expect(compose.services.worker?.ports).toContain("${BIND_ADDRESS:-127.0.0.1}:${WORKER_PORT:-3005}:3005");
  });
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
      const src = v.startsWith("${") ? v.slice(v.indexOf(":-") + 2, v.indexOf("}")) : (v.split(":")[0] ?? "");
      const mode = v.slice(v.lastIndexOf(":") + 1);
      if (/(docker|podman)\.sock|\/run\/(user\/\d+\/)?(podman|docker)/.test(v)) return [`${v}: engine socket`];
      if (src.startsWith("./"))
        return /\bro\b/.test(mode) && (src.startsWith("./infra/") || src.startsWith("./.cache/models/"))
          ? []
          : [`${v}: bind must be a read-only infra fixture or cached model`];
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

  test("every service that decodes images through @commonair/moderation gets ffmpeg", () => {
    // api (upload scanning), worker (live frame scans, NCII hashing) and media all spawn ffmpeg.
    const runtime = read("infra/containers/service.Containerfile").split(/^FROM \S+ AS runtime$/m)[1] ?? "";
    const install = /case "\$\{SERVICE\}" in ([a-z|]+)\)([^]*?);;/.exec(runtime);
    expect(install?.[2], "runtime stage installs ffmpeg in a case on SERVICE").toMatch(/apt-get install[^\n]*ffmpeg/);
    expect(new Set(install?.[1]?.split("|"))).toEqual(new Set(["media", "api", "worker"]));
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
  test("postgres raises max_connections through its entrypoint (parallel suites exhaust 100)", () => {
    expect(compose.services.postgres?.environment?.POSTGRES_MAX_CONNECTIONS).toBe("${POSTGRES_MAX_CONNECTIONS:-400}");
    expect(read("infra/postgres/entrypoint.sh")).toContain('-c "max_connections=${POSTGRES_MAX_CONNECTIONS}"');
  });
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
  test("the bucket names Caddy routes presigned URLs for (ADR 0024) reach it, with .env.example's defaults", () => {
    const example = Object.fromEntries(
      read(".env.example")
        .split("\n")
        .filter((l) => /^[A-Z0-9_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    const env = compose.services.caddy?.environment ?? {};
    for (const key of ["S3_BUCKET_MEDIA", "S3_BUCKET_EXPORTS"]) {
      expect(env[key], key).toBe(`\${${key}:-${example[key]}}`);
      expect(caddy, key).toContain(`{$${key}:${example[key]}}`);
    }
    // The Quadlet unit reads the whole instance env file, which carries them.
    expect(read("infra/quadlet/commonair-caddy.container")).toContain(
      "EnvironmentFile=%h/.config/commonair/commonair.env",
    );
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
  // Production-only units with no compose service: the timer-driven IRC certificate sync.
  const QUADLET_ONLY = new Set(["irc-cert"]);
  // A host path bind-mounted by two or more units carries the shared SELinux label `z`: the
  // private `Z` relabels it per container, so the last one to start locks the others out.
  const bindSources = Object.values(units).flatMap((u) =>
    [...new Set(keys(u, "Volume").map((v) => v.slice(0, v.indexOf(":"))))].filter((s) => !s.endsWith(".volume")),
  );
  const SHARED_BINDS = new Set(bindSources.filter((s, i) => bindSources.indexOf(s) !== i));

  test("the shared bind mounts are the IRC certificate, the hash lists and the model", () => {
    expect([...SHARED_BINDS].sort()).toEqual([
      "%h/.config/commonair/irc-tls",
      "%h/.local/share/commonair/models/adamcodd-vit-base-nsfw-detector-8587de99-int8.onnx",
      "%h/.local/share/commonair/moderation/csam.pdq",
      "%h/.local/share/commonair/moderation/ncii.pdq",
    ]);
  });
  // The only ports a production host exposes; everything else binds 127.0.0.1.
  const PUBLIC_PORTS: Record<string, string[]> = {
    caddy: ["0.0.0.0:80:80", "0.0.0.0:443:443", "0.0.0.0:443:443/udp"],
    mediamtx: ["0.0.0.0:1935:1935", "0.0.0.0:8189:8189/udp"],
    irc: ["0.0.0.0:6667:6667", "0.0.0.0:6697:6697"],
  };

  test("every production compose service has a unit, and nothing else does", () => {
    const expected = [...services.map(([n]) => n).filter((n) => !DEV_ONLY.has(n)), ...QUADLET_ONLY];
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
    // The same check in the same form. Podman reads a plain HealthCmd string as CMD-SHELL, which
    // needs /bin/sh; Garage's image has none and Loki, Tempo and the collector only a static
    // busybox, so their checks never passed. A leading `CMD` word gives exec form on Podman 4.9
    // through 6 (5.4 splits a JSON array on whitespace instead of parsing it), so no argument
    // may contain a space.
    const test = s.healthcheck?.test ?? [];
    const form = test[0] === "CMD" ? test.join(" ") : test[1];
    expect(keys(unit, "HealthCmd"), name).toEqual(ONE_SHOT.has(name) ? [] : [form]);
    expect(
      test[0] === "CMD-SHELL" || test.every((a) => !/\s/.test(a)),
      `${name}: an exec-form argument with a space`,
    ).toBe(true);
    const badVolumes = keys(unit, "Volume").filter((v) => {
      const src = v.slice(0, v.indexOf(":"));
      if (src.endsWith(".volume")) return !existsSync(join(dir, src));
      return !v.endsWith(SHARED_BINDS.has(src) ? ":ro,z" : ":ro,Z");
    });
    expect(badVolumes).toEqual([]);
    // Every depends_on is an After= ordering. Requires= only for the one-shots (a failed migrate
    // keeps schema users down); Wants= for long-running services, so a failed start there does
    // not fail this unit with result 'dependency', which Restart=always never retries.
    const deps = Object.keys(s.depends_on ?? {});
    expect(deps.filter((d) => !keys(unit, "After").includes(`commonair-${d}.service`))).toEqual([]);
    const strength = (d: string) => (ONE_SHOT.has(d) ? "Requires" : "Wants");
    expect(deps.filter((d) => !keys(unit, strength(d)).includes(`commonair-${d}.service`))).toEqual([]);
    expect(keys(unit, "Requires").filter((r) => !ONE_SHOT.has(r.replace(/^commonair-|\.service$/g, "")))).toEqual([]);
    const isPublic = (p: string) => p.startsWith("0.0.0.0:");
    expect(keys(unit, "PublishPort").filter(isPublic).sort()).toEqual((PUBLIC_PORTS[name] ?? []).toSorted());
    expect(keys(unit, "PublishPort").filter((p) => !isPublic(p) && !p.startsWith("127.0.0.1:"))).toEqual([]);
    const dbSecret = /^Secret=commonair-(owner-)?database-url,type=env,target=DATABASE_URL$/m.test(unit);
    expect(dbSecret).toBe(Boolean(s.environment?.DATABASE_URL));
  });

  test("WHIP signaling is public only through Caddy; ICE keeps equal host and container ports", () => {
    expect(keys(units.mediamtx!, "PublishPort")).toContain("127.0.0.1:8889:8889");
    const caddy = read("infra/caddy/Caddyfile");
    const re = /@whip path_regexp (\S+)\n\s*handle @whip \{\s+reverse_proxy mediamtx:8889\s+\}/.exec(caddy);
    expect(re).not.toBeNull();
    const whip = new RegExp(re![1]!);
    // What the API hands out (INGEST_WHIP_PUBLIC_URL + /<slug>/whip) and MediaMTX's session URLs.
    expect(whip.test("/live/some_streamer1/whip")).toBe(true);
    expect(whip.test("/live/some_streamer1/whip/0e9c1f3a-4b5d-4e6f-8a7b-9c0d1e2f3a4b")).toBe(true);
    // Never MediaMTX's other endpoints, nor web pages.
    for (const p of [
      "/live/a/whep",
      "/live/a/index.m3u8",
      "/live/a",
      "/live/a/whip/x/y",
      "/live/../whip",
      "/v3/paths/list",
    ])
      expect(whip.test(p), p).toBe(false);
  });

  test("IRC TLS reads the certificate commonair-irc-cert.service syncs", () => {
    const irc = units.irc!;
    expect(irc).toContain("Environment=IRC_TLS_CERT_FILE=/run/commonair/irc-tls/tls.crt\n");
    expect(irc).toContain("Environment=IRC_TLS_KEY_FILE=/run/commonair/irc-tls/tls.key\n");
    expect(keys(irc, "Volume")).toContain("%h/.config/commonair/irc-tls:/run/commonair/irc-tls:ro,z");
    // The sync writes where IRC reads, from Caddy's data volume, as the host user.
    const sync = units["irc-cert"]!;
    expect(keys(sync, "Volume")).toEqual([
      "commonair-caddy-data.volume:/caddy-data:ro",
      "%h/.config/commonair/irc-tls:/state/irc-tls:z",
    ]);
    expect(keys(sync, "Exec")[0]).toContain("bun infra/irc/sync-cert.ts --caddy-data /caddy-data --out /state/irc-tls");
    expect(keys(sync, "User")).toEqual(["0"]);
    expect(keys(sync, "Network")).toEqual(["none"]);
    expect(keys(sync, "ExecStartPost")[0]).toContain("systemctl --user restart commonair-irc.service");
    expect(keys(irc, "PublishPort")).toContain("127.0.0.1:6680:6680");
  });

  test("the network subnet default matches the trusted proxy default", () => {
    const raw = readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8");
    expect(raw).toContain("subnet: ${COMPOSE_SUBNET:-10.89.42.0/24}");
    expect(compose.services.api!.environment!.TRUSTED_PROXY_CIDRS).toBe("${TRUSTED_PROXY_CIDRS:-10.89.42.0/24}");
  });

  test("browser-facing S3 URLs default to the published Garage port, not the in-network host", () => {
    const appEnv = compose.services.api!.environment!;
    expect(appEnv.S3_ENDPOINT).toBe("http://garage:3900");
    expect(appEnv.S3_PUBLIC_ENDPOINT).toBe("${S3_PUBLIC_ENDPOINT:-http://localhost:${GARAGE_S3_PORT:-3900}}");
    expect(compose.services.garage!.ports).toContain("${BIND_ADDRESS:-127.0.0.1}:${GARAGE_S3_PORT:-3900}:3900");
  });

  test("public media goes through the origin's /media route, never Garage directly (ADR 0009)", () => {
    for (const name of ["api", "origin", "worker", "web"])
      expect(compose.services[name]!.environment!.MEDIA_PUBLIC_URL, name).toBe(
        "${MEDIA_PUBLIC_URL:-http://localhost:${ORIGIN_PORT:-3003}/media}",
      );
    expect(compose.services.origin!.ports).toContain("${BIND_ADDRESS:-127.0.0.1}:${ORIGIN_PORT:-3003}:3003");
    // Garage's web endpoint would publish the private prefixes; it stays off.
    const garageToml = read("infra/garage/garage.toml");
    expect(garageToml).not.toContain("[s3_web]");
    expect(compose.services.garage!.ports!.some((p) => p.endsWith(":3902"))).toBe(false);
    expect(/^MEDIA_PUBLIC_URL=http:\/\/localhost:3003\/media$/m.test(read(".env.example"))).toBe(true);
    // Behind Caddy the same path reaches the origin.
    expect(read("infra/caddy/Caddyfile")).toMatch(/handle \/media\/\* \{\s+reverse_proxy origin:3003\s+\}/);
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
        if (k === "DATABASE_URL" || k.startsWith("SMTP_") || k.startsWith("MODERATION_") || k === "OTEL_SERVICE_NAME")
          continue;
        // Per-service evidence scoping is checked by its own test above.
        if (k.startsWith("S3_EVIDENCE_") || k === "EVIDENCE_PRIVATE_KEY") continue;
        // Browser-facing and deployment-specific: the units read it from the operator's env file.
        if (k === "S3_PUBLIC_ENDPOINT" || k === "MEDIA_PUBLIC_URL") continue;
        const expected = k === "TRUSTED_PROXY_CIDRS" ? "10.89.42.0/24" : v;
        expect(env[k], `${name}: ${k}`).toBe(expected);
      }
    }
  });
});

describe("systemd timers (infra/systemd)", () => {
  const dir = join(ROOT, "infra/systemd");
  const unit = (f: string) => readFileSync(join(dir, f), "utf8");
  const keys = (u: string, key: string) => [...u.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!);

  // A timer's service is a plain unit here or generated by Quadlet from quadlet/<name>.container.
  const serviceUnit = (service: string) =>
    existsSync(join(dir, service))
      ? unit(service)
      : read(`infra/quadlet/${service.replace(/\.service$/, ".container")}`);

  test("every timer starts its own oneshot service and survives downtime", () => {
    const timers = readdirSync(dir).filter((f) => f.endsWith(".timer"));
    expect(timers.sort()).toEqual(["commonair-backup.timer", "commonair-irc-cert.timer"]);
    for (const t of timers) {
      const service = t.replace(/\.timer$/, ".service");
      expect(keys(unit(t), "Unit"), t).toEqual([service]);
      expect(keys(unit(t), "Persistent"), t).toEqual(["true"]);
      expect(keys(unit(t), "WantedBy"), t).toEqual(["timers.target"]);
      expect(keys(serviceUnit(service), "Type"), service).toEqual(["oneshot"]);
    }
  });

  test("timer-driven services do not also start at boot on their own", () => {
    expect(read("infra/quadlet/commonair-irc-cert.container")).not.toMatch(/^\[Install\]$/m);
    expect(unit("commonair-backup.service")).not.toMatch(/^\[Install\]$/m);
  });

  test("the backup runs inside the Postgres container and never starts Postgres itself", () => {
    const backup = unit("commonair-backup.service");
    const postgres = read("infra/quadlet/commonair-postgres.container");
    const [container] = keys(postgres, "ContainerName");
    expect(keys(backup, "ExecStart")).toEqual([`/usr/bin/podman exec ${container} commonair-backup`]);
    expect(read("infra/postgres/Containerfile")).toContain("/usr/local/bin/commonair-backup");
    expect(keys(backup, "Requisite")).toEqual(["commonair-postgres.service"]);
    expect(keys(backup, "Requires")).toEqual([]);
  });

  test("the IRC certificate sync runs the repository's script in the tools image with the instance env", () => {
    // In the tools image, so the host needs no Bun (ADR 0023 §8).
    expect(existsSync(join(dir, "commonair-irc-cert.service"))).toBe(false);
    const sync = serviceUnit("commonair-irc-cert.service");
    expect(keys(sync, "Image")).toEqual(["localhost/commonair/tools:latest"]);
    expect(keys(sync, "Exec")[0]).toContain("bun infra/irc/sync-cert.ts");
    expect(existsSync(join(ROOT, "infra/irc/sync-cert.ts"))).toBe(true);
    expect(keys(sync, "EnvironmentFile")).toEqual(["%h/.config/commonair/commonair.env"]);
    // The script reads the volume by this name.
    expect(read("infra/quadlet/commonair-caddy-data.volume")).toContain("VolumeName=commonair-caddy-data\n");
  });
});

describe("postgres runs under an init", () => {
  // As PID 1 the postmaster reaps orphans (timed-out execs, abandoned archive commands) and
  // treats one that died by a signal as a crashed backend: every connection is reset.
  test("compose and Quadlet keep the postmaster off PID 1", () => {
    expect(compose.services.postgres?.init).toBe(true);
    expect(read("infra/quadlet/commonair-postgres.container")).toMatch(/^RunInit=true$/m);
  });
});
