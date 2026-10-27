// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The parts of the end-to-end test that need no podman: how it builds and what it runs on. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { RELEASE_IMAGES } from "../release/manifest.ts";
import {
  AUTH_LIMIT,
  AUTH_PROBE_PATH,
  CADDY_FORBIDDEN,
  EXPORT_FILENAME,
  HOST_IMAGES,
  type Presigned,
  ZOT_IMAGE,
  buildSpecs,
  envKeys,
  exportBody,
  forbiddenKeys,
  hostContainerfile,
  hostRunArgs,
  buildRetryArgs,
  isTransientBuildError,
  listeners,
  migratedFirst,
  missingListeners,
  cleanupPlan,
  judgedListeners,
  probeCommand,
  refusedRequests,
  SOURCES,
  SPOOFED,
  storageScript,
  unexpectedListeners,
  uploadBody,
} from "../selfhost/e2e.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const licenses = JSON.parse(readFileSync(join(ROOT, "infra/image-licenses.json"), "utf8")) as Record<
  string,
  { tag: string }
>;
const PINNED = /^([a-z0-9.-]+\/[a-z0-9._/-]+):([\w.-]+)@sha256:[0-9a-f]{64}$/;

describe("e2e build specs", () => {
  const specs = buildSpecs();

  test("every release image has a build from compose.yaml (relay from its own Containerfile)", () => {
    expect(Object.keys(specs).sort()).toEqual([...RELEASE_IMAGES].sort());
    for (const [name, spec] of Object.entries(specs)) expect(existsSync(join(ROOT, spec.file)), name).toBe(true);
    expect(specs.api.args).toEqual({ SERVICE: "api" });
    expect(specs.tools.args).toEqual({ SERVICE: "tools" });
    expect(specs.postgres.file).toBe("infra/postgres/Containerfile");
    expect(specs.loki.args.BASE_IMAGE).toMatch(PINNED);
    expect(specs.relay).toEqual({ file: "relay/Containerfile", context: "relay", args: {} });
  });
});

describe("e2e images", () => {
  test.each([ZOT_IMAGE, ...Object.values(HOST_IMAGES)])("%s is pinned and licensed", (ref) => {
    const m = PINNED.exec(ref);
    expect(m).not.toBeNull();
    expect(licenses[m![1]!]?.tag).toBe(m![2]);
  });

  test.each(Object.keys(HOST_IMAGES) as (keyof typeof HOST_IMAGES)[])(
    "%s host: systemd as PID 1, no Podman (selfhost.sh installs it), the e2e registry marked insecure",
    (distro) => {
      const file = hostContainerfile(distro);
      expect(file.startsWith(`FROM ${HOST_IMAGES[distro]}\n`)).toBe(true);
      for (const pkg of ["systemd", "curl"]) expect(file).toContain(` ${pkg}`);
      // Like a fresh server: selfhost.sh installs Podman and its helpers, as an operator's would.
      for (const pkg of ["podman", "catatonit", "passt", "aardvark-dns", "nftables"])
        expect(file).not.toContain(` ${pkg}`);
      expect(file).toContain('CMD ["/sbin/init"]');
      // network-online.target is reached at boot, as on a real server.
      expect(file).toContain("WantedBy=network-online.target");
      expect(file.includes("dnf reinstall -y shadow-utils")).toBe(distro === "fedora");
      expect(file).toContain("systemctl add-wants multi-user.target network-online.target");
      expect(file).toContain("insecure = true");
    },
  );
});

describe("e2e: the upgrade re-ran migrate before api and worker", () => {
  const before = { invocation: "aaa", started: 1_000 };
  test("passes when migrate ran again and finished before both started", () => {
    expect(
      migratedFirst(before, { invocation: "bbb", started: 5_000, exited: 6_000 }, { api: 7_000, worker: 7_100 }),
    ).toEqual([]);
  });

  test("fails when the upgrade skipped migrate (the install's run is still the last one)", () => {
    const stale = { ...before, exited: 1_500 };
    const problems = migratedFirst(before, stale, { api: 7_000, worker: 7_100 });
    expect(problems.some((p) => p.includes("did not run again"))).toBe(true);
    expect(problems.some((p) => p.includes("not after the pre-upgrade one"))).toBe(true);
  });

  test("fails when api or worker started before migrate finished", () => {
    const problems = migratedFirst(
      before,
      { invocation: "bbb", started: 5_000, exited: 6_000 },
      { api: 5_500, worker: 7_000 },
    );
    expect(problems).toEqual(["api started at 5500, before migrate finished at 6000"]);
  });
});

describe("e2e: the outer podman is CI's rootful Podman 4.9", () => {
  const args = hostRunArgs("localhost/commonair-e2e/host-debian:latest", null, "10.89.0.2");

  test("the host container has no pids limit, as a real server has none of 2048", () => {
    expect(args).toContain("--pids-limit=-1");
  });

  test("the host container resolves the registry by --add-host, not by network DNS", () => {
    // CNI without the dnsname plugin (Podman 4 on some distributions) has no container DNS.
    expect(args.join(" ")).toContain("--add-host commonair-e2e-zot:10.89.0.2");
  });

  test("the host container uses only flags Podman 4.9 has", () => {
    const PODMAN_4_9 = new Set([
      "-d",
      "--name",
      "--hostname",
      "--privileged",
      "--systemd",
      "--pids-limit",
      "--network",
      "--no-cache",
      "--add-host",
      "-v",
    ]);
    const flags = args.filter((a) => a.startsWith("-")).map((a) => a.replace(/=.*$/, ""));
    expect(flags.filter((f) => !PODMAN_4_9.has(f))).toEqual([]);
  });

  test("every outer podman flag in e2e.ts is one Podman 4.9 has", () => {
    const src = readFileSync(join(ROOT, "scripts/selfhost/e2e.ts"), "utf8");
    // String literals that are flags, outside the inner (in-host) shell scripts.
    const flags = new Set([...src.matchAll(/"(--?[a-z][a-z-]*)(?:=[^"]*)?"/g)].map((m) => m[1]!));
    const KNOWN = new Set([
      "-a",
      "-c",
      "-d",
      "-e",
      "-f",
      "-p",
      "-t",
      "-u",
      "-v",
      "-w",
      "--add-host",
      "--build-arg",
      "--digestfile",
      "--filter",
      "--format",
      "--hostname",
      "--label",
      "--name",
      "--network",
      "--no-cache",
      "--pids-limit",
      "--privileged",
      "--systemd",
      "--tls-verify",
    ]);
    expect([...flags].filter((f) => !KNOWN.has(f)).sort()).toEqual([]);
  });
});

describe("e2e: browser access to object storage (ADR 0024)", () => {
  /** Runs a storageScript with the repo's storage package against an in-memory S3 stand-in. */
  async function runScript(script: string, objects: Map<string, string>): Promise<string> {
    const server = Bun.serve({
      // The address the script dials: on a wildcard bind, another test's server bound to
      // 127.0.0.1 on the same port would win the connection (BSD sockets) and answer 404.
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = decodeURIComponent(new URL(req.url).pathname);
        if (req.method === "PUT") objects.set(path, await req.text());
        if (req.method === "DELETE") objects.delete(path);
        if (req.method === "GET")
          return objects.has(path) ? new Response(objects.get(path)) : new Response("", { status: 404 });
        return new Response(null, { status: req.method === "DELETE" ? 204 : 200 });
      },
    });
    try {
      const local = script.replace("/app/packages/storage/src/index.ts", join(ROOT, "packages/storage/src/index.ts"));
      const proc = Bun.spawn([process.execPath, "-e", local], {
        cwd: join(ROOT, "packages/storage"),
        env: {
          PATH: process.env.PATH ?? "",
          S3_ENDPOINT: `http://127.0.0.1:${server.port}`,
          S3_PUBLIC_ENDPOINT: "https://selfhost.test",
          S3_REGION: "garage",
          S3_ACCESS_KEY_ID: "GKtest",
          S3_SECRET_ACCESS_KEY: "secret",
          S3_FORCE_PATH_STYLE: "true",
          S3_BUCKET_MEDIA: "commonair-media",
          S3_BUCKET_EXPORTS: "commonair-exports",
          S3_BUCKET_EVIDENCE: "commonair-evidence",
          S3_BUCKET_BACKUPS: "commonair-backups",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code, err).toBe(0);
      return out.trim().split("\n").at(-1)!;
    } finally {
      await server.stop(true);
    }
  }

  test("presign stores the export and signs every URL for the public host", async () => {
    const objects = new Map<string, string>();
    const p = JSON.parse(await runScript(storageScript("t1", "presign"), objects)) as Presigned;
    expect(objects.get("/commonair-exports/e2e/t1.zip")).toBe(exportBody("t1"));
    expect(p.endpoint).toBe("https://selfhost.test");
    const { endpoint: _, ...urls } = p;
    for (const [name, url] of Object.entries(urls))
      expect(url, name).toMatch(/^https:\/\/selfhost\.test\/[^?]+\?.*X-Amz-Signature=/);
    expect(new URL(p.upload).pathname).toBe("/commonair-media/incoming/e2e/t1.png");
    expect(new URL(p.outside).pathname).toBe("/commonair-media/public/e2e/t1.png");
    expect(new URL(p.download).searchParams.get("response-content-disposition")).toBe(
      `attachment; filename="${EXPORT_FILENAME}"`,
    );
    expect(new URL(p.evidence).pathname.split("/")[1]).toBe("commonair-evidence");
    expect(new URL(p.backups).pathname.split("/")[1]).toBe("commonair-backups");
    // The length is signed, so curl's Content-Length (the body's) must be what was signed.
    expect(new URL(p.upload).searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
  });

  test("verify reads the upload back and deletes what the run created", async () => {
    const objects = new Map([
      ["/commonair-media/incoming/e2e/t2.png", uploadBody("t2")],
      ["/commonair-exports/e2e/t2.zip", exportBody("t2")],
    ]);
    expect(JSON.parse(await runScript(storageScript("t2", "verify"), objects))).toEqual({ uploaded: uploadBody("t2") });
    expect(objects.size).toBe(0);
    expect(JSON.parse(await runScript(storageScript("t3", "verify"), objects))).toEqual({ uploaded: null });
  });

  test("the refusals cover every out-of-scope shape the brief names", () => {
    const sig = "?X-Amz-Signature=x";
    const p: Presigned = {
      endpoint: "https://selfhost.test",
      upload: `https://selfhost.test/commonair-media/incoming/e2e/a.png${sig}`,
      outside: `https://selfhost.test/commonair-media/public/e2e/a.png${sig}`,
      download: `https://selfhost.test/commonair-exports/e2e/a.zip${sig}`,
      incomingRead: `https://selfhost.test/commonair-media/incoming/e2e/a.png${sig}`,
      evidence: `https://selfhost.test/commonair-evidence/incoming/e2e/a.png${sig}`,
      backups: `https://selfhost.test/commonair-backups/incoming/e2e/a.png${sig}`,
    };
    expect(refusedRequests(p).map(([, method, url]) => `${method} ${url}`)).toEqual([
      "PUT https://selfhost.test/commonair-media/incoming/e2e/a.png",
      `GET ${p.incomingRead}`,
      `PUT ${p.outside}`,
      `GET ${p.evidence}`,
      `GET ${p.backups}`,
      "GET https://selfhost.test/commonair-exports?list-type=2",
      `DELETE ${p.download}`,
      `DELETE ${p.upload}`,
    ]);
  });

  test("runs on install and again after the upgrade", () => {
    const src = readFileSync(join(ROOT, "scripts/selfhost/e2e.ts"), "utf8");
    expect(src.match(/^\s+checkBrowserStorage\("\w+"\);$/gm)?.map((l) => l.trim())).toEqual([
      'checkBrowserStorage("install");',
      'checkBrowserStorage("upgrade");',
    ]);
  });
});

describe("CI job", () => {
  test("unloads the runner's unix-chkpwd AppArmor profile before the end-to-end run", () => {
    // Without it the Fedora host's user manager fails PAM on ubuntu-24.04 runners.
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const job = ci.slice(ci.indexOf("\n  selfhost-e2e:"), ci.indexOf("\n  ci-ok:"));
    const unload = job.indexOf("apparmor_parser -R /etc/apparmor.d/unix-chkpwd");
    expect(unload).toBeGreaterThan(0);
    expect(unload).toBeLessThan(job.indexOf("scripts/selfhost/e2e.ts"));
  });

  test("shellchecks the Postgres image scripts with the self-host scripts", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/git ls-files 'scripts\/selfhost\.sh' 'scripts\/selfhost\/\*\.sh' 'infra\/postgres\/\*\.sh'/);
  });
});

describe("transient build errors", () => {
  test("only Podman 4.9's cache-lookup layer error is retried", () => {
    expect(
      isTransientBuildError(
        "podman build -f infra/containers/probe.Containerfile … exited 125\nError: checking if cached image exists from a previous build: getting top layer info: layer not known",
      ),
    ).toBe(true);
    expect(isTransientBuildError('Error: building at STEP "RUN bun install": exit status 1')).toBe(false);
    expect(isTransientBuildError("Error: layer not known")).toBe(false);
  });

  test("so is its lost cached intermediate image when a step creates its build container", () => {
    expect(
      isTransientBuildError(
        "Error: identifier is not a container: preparing container for next step: creating build container: cac741d4304c14b6f862881abf9712839b059ce5cd5ee1663c0fdd3a25b3a408: image not known",
      ),
    ).toBe(true);
    expect(isTransientBuildError("Error: localhost/base:latest: image not known")).toBe(false);
    // A base named by id that is really missing is not the lost-cache case.
    expect(isTransientBuildError("Error: abc123def4567890: image not known")).toBe(false);
  });

  // CI: the retry of a 'layer not known' build failed identically, because it looked the same
  // broken cache entry up again.
  test("the retry builds without the cache, with the same arguments", () => {
    expect(buildRetryArgs(["-f", "x.Containerfile", "-t", "img", "."])).toEqual([
      "build",
      "--no-cache",
      "-f",
      "x.Containerfile",
      "-t",
      "img",
      ".",
    ]);
  });

  // CI run 39988149327: a release image's build lost the cache and was retried, then the host
  // image's build, which did not go through the retry, failed on the same lost entry.
  test("every podman build in the e2e goes through that retry", () => {
    const source = readFileSync(join(ROOT, "scripts/selfhost/e2e.ts"), "utf8");
    // The literal appears only in build() and buildRetryArgs(); any other build adds one.
    expect(source.match(/"build"/g)).toHaveLength(2);
    expect(source).toMatch(
      /function build\(args: string\[\]\): void \{\n  try \{\n    podman\(\["build", \.\.\.args\]\);/,
    );
    expect(source).toMatch(/return \["build", "--no-cache", \.\.\.args\];/);
  });
});

describe("e2e unit env check", () => {
  const env = [
    "PATH=/usr/local/sbin:/usr/bin",
    "PUBLIC_HOSTNAME=selfhost.test",
    "TLS_MODE=internal",
    "S3_BUCKET_MEDIA=commonair-media",
    "HOSTNAME=abc",
    "",
  ].join("\n");

  test("envKeys lists names only, never values", () => {
    expect(envKeys("A=x=y\nB=\n not=an assignment\nC=secret value\n")).toEqual(["A", "B", "C"]);
    expect(envKeys("A=DATABASE_URL\n")).toEqual(["A"]);
  });

  test("Caddy's own env passes; any database, session or S3 secret is caught", () => {
    expect(forbiddenKeys(env, CADDY_FORBIDDEN)).toEqual([]);
    for (const key of [
      "DATABASE_URL",
      "POSTGRES_PASSWORD",
      "POSTGRES_APP_PASSWORD",
      "SESSION_SECRET",
      "AUTH_SECRET",
      "S3_SECRET_ACCESS_KEY",
      "S3_EVIDENCE_SECRET_ACCESS_KEY",
    ])
      expect(forbiddenKeys(`${env}${key}=x\n`, CADDY_FORBIDDEN), key).toEqual([key]);
  });

  test("Caddy's key list holds none of them", () => {
    const keys = readFileSync(join(ROOT, "infra/selfhost/env/commonair-caddy.keys"), "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"));
    expect(forbiddenKeys(keys.map((k) => `${k}=x`).join("\n"), CADDY_FORBIDDEN)).toEqual([]);
    expect(keys).toContain("PUBLIC_HOSTNAME");
  });
});

describe("e2e: network exposure", () => {
  // `ss -Hltn` as Debian 13's iproute2 prints it: dual-stack sockets as `*`, IPv6 in brackets.
  const ss = [
    "LISTEN 0      4096               *:80              *:*",
    "LISTEN 0      4096               *:443             *:*",
    "LISTEN 0      4096               *:1935            *:*",
    "LISTEN 0      4096               *:6667            *:*",
    "LISTEN 0      4096               *:6697            *:*",
    "LISTEN 0      4096       127.0.0.1:3900       0.0.0.0:*",
    "LISTEN 0      4096       127.0.0.1:3030       0.0.0.0:*",
  ].join("\n");

  test("every listener is judged except the operating system's own services", () => {
    const withCgroups = [
      "LISTEN 0 4096 *:443 *:* uid:1000 ino:41 sk:1 cgroup:/user.slice/user-1000.slice/user@1000.service/init.scope <->",
      "LISTEN 0 4096 0.0.0.0:5355 0.0.0.0:* uid:193 ino:42 sk:2 cgroup:/system.slice/systemd-resolved.service <->",
      "LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* uid:193 ino:43 sk:3 cgroup:/system.slice/systemd-resolved.service <->",
      "LISTEN 0 128 0.0.0.0:22 0.0.0.0:* ino:44 sk:4 cgroup:/system.slice/ssh.service <->",
      // Root-owned (ss prints no uid) and outside system.slice: judged, and reported.
      "LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:* ino:45 sk:5 cgroup:/ <->",
      // A subuid-owned socket in the user's slice: judged too.
      "LISTEN 0 4096 127.0.0.1:6379 0.0.0.0:* uid:100998 ino:46 sk:6 cgroup:/user.slice/user-1000.slice/user@1000.service/app.slice/x <->",
    ].join("\n");
    const judged = judgedListeners(withCgroups);
    expect(listeners(judged).map((l) => l.port)).toEqual([443, 5432, 6379]);
    expect(unexpectedListeners(judged)).toEqual(["0.0.0.0:5432", "127.0.0.1:6379"]);
  });

  test("listeners parses IPv4, IPv6 and dual-stack local addresses", () => {
    expect(listeners("LISTEN 0 4096 [::1]:5432 [::]:*\nLISTEN 0 4096 [fe80::1%eth0]:22 [::]:*")).toEqual([
      { address: "::1", port: 5432 },
      { address: "fe80::1", port: 22 },
    ]);
    expect(listeners(ss)).toHaveLength(7);
  });

  test("the expected host passes", () => {
    expect(unexpectedListeners(ss)).toEqual([]);
    expect(missingListeners(ss)).toEqual([]);
  });

  test("any other listener fails, a loopback-only port on a public address too", () => {
    const extra = [
      "LISTEN 0 4096 127.0.0.1:6379 0.0.0.0:*",
      "LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:*",
      "LISTEN 0 4096 0.0.0.0:3900 0.0.0.0:*",
      "LISTEN 0 4096 [::]:3030 [::]:*",
      "LISTEN 0 4096 *:22 *:*",
    ].join("\n");
    expect(unexpectedListeners(`${ss}\n${extra}`)).toEqual([
      "127.0.0.1:6379",
      "127.0.0.1:5432",
      "0.0.0.0:3900",
      ":::3030",
      "*:22",
    ]);
  });

  test("Caddy's 80 and 443 and RTMP must listen; IRC may still wait for its certificate", () => {
    const withoutCaddy = ss
      .split("\n")
      .filter((l) => !/:(80|443) /.test(l))
      .join("\n");
    expect(missingListeners(withoutCaddy)).toEqual([80, 443]);
    const withoutIrc = ss
      .split("\n")
      .filter((l) => !/:66\d\d /.test(l))
      .join("\n");
    expect(missingListeners(withoutIrc)).toEqual([]);
  });

  test("the probe hits the API's rate-limited auth prefix from a chosen source, printing only the status", () => {
    const cmd = probeCommand(SOURCES.a, SPOOFED);
    expect(AUTH_PROBE_PATH.startsWith("/api/auth/")).toBe(true);
    expect(cmd).toContain(`--interface ${SOURCES.a} -X POST`);
    expect(cmd).toContain(`-H 'X-Forwarded-For: ${SPOOFED}'`);
    expect(cmd).toContain(`https://selfhost.test${AUTH_PROBE_PATH}`);
    expect(cmd).toContain("-o /dev/null -w '%{http_code}\\n'");
    expect(probeCommand(SOURCES.b)).not.toContain("X-Forwarded-For");
    // Three distinct local sources, all on the host's loopback network.
    expect(new Set(Object.values(SOURCES)).size).toBe(3);
    for (const s of Object.values(SOURCES)) expect(s).toMatch(/^127\.0\.0\.\d+$/);
  });

  test("the limit is the API's auth bucket, on the auth prefix", () => {
    const limits = readFileSync(join(ROOT, "services/api/src/lib/ratelimit.ts"), "utf8");
    expect(limits).toContain(`auth: { max: ${AUTH_LIMIT}, windowMs: 60_000 }`);
    expect(readFileSync(join(ROOT, "packages/contracts/src/auth.ts"), "utf8")).toContain(
      'export const AUTH_BASE_PATH = "/api/auth";',
    );
  });

  test("runs on install; the Valkey and listener checks again after the upgrade", () => {
    const src = readFileSync(join(ROOT, "scripts/selfhost/e2e.ts"), "utf8");
    const calls = (fn: string) => src.match(new RegExp(`^\\s+${fn}\\(\\);$`, "gm"))?.length ?? 0;
    expect(calls("checkClientAddresses")).toBe(1);
    expect(calls("checkIpv6")).toBe(1);
    expect(calls("checkValkeyAuth")).toBe(2);
    expect(calls("checkListeners")).toBe(2);
  });
});

describe("e2e image housekeeping", () => {
  test("removes the release children first, then this namespace's images of other commits", () => {
    const plan = cleanupPlan(
      [
        "localhost/commonair-e2e/api:803c7206aaaa",
        "localhost/commonair-e2e/api:562f8c9e1234",
        "localhost/commonair-e2e/api:0.0.0-e2e.2",
        "localhost/commonair-e2e/web:0.0.0-e2e.3",
        "localhost/commonair-e2e/host-fedora:latest",
        "localhost/commonair/api:latest",
        "docker.io/library/caddy:2.11.7-alpine",
        "",
      ],
      "803c7206aaaabbbbccccdddd",
    );
    expect(plan).toEqual({
      releases: ["localhost/commonair-e2e/api:0.0.0-e2e.2", "localhost/commonair-e2e/web:0.0.0-e2e.3"],
      stale: ["localhost/commonair-e2e/api:562f8c9e1234"],
    });
  });

  test("the release images carry the label the dangling-image prune selects", () => {
    const src = readFileSync(join(ROOT, "scripts/selfhost/e2e.ts"), "utf8");
    expect(src).toContain("LABEL ${RELEASE_LABEL}=");
    expect(src).toContain('"image", "prune", "-f", "--filter", `label=${RELEASE_LABEL}`');
    // Children before parents.
    expect(src.indexOf('podman(["rmi", "-f", ...releases]')).toBeLessThan(
      src.indexOf('podman(["rmi", "-f", ...stale]'),
    );
  });
});
