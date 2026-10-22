// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The parts of the end-to-end test that need no podman: how it builds and what it runs on. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { RELEASE_IMAGES } from "../release/manifest.ts";
import {
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
  isTransientBuildError,
  migratedFirst,
  refusedRequests,
  storageScript,
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
      "--network",
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
      "--distro",
      "--format",
      "--hostname",
      "--keep",
      "--label",
      "--name",
      "--network",
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

describe("CI verify job", () => {
  test("pins podman compose to podman-compose, not the runner's docker-compose plugin", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const job = ci.slice(ci.indexOf("\n  verify:"), ci.indexOf("\n  release-dry-run:"));
    expect(job).toMatch(/\n {6}PODMAN_COMPOSE_PROVIDER: podman-compose\n/);
    expect(job).toContain("pipx install podman-compose==");
  });
});
