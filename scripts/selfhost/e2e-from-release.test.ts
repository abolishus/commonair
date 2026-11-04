// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { TOOLS } from "../release/tools.ts";
import {
  FROM_RELEASE_EVENTS,
  OIDC_ISSUER,
  OfflineError,
  RELEASE_REPOSITORY,
  RELEASE_SIGNERS,
  type ReleaseAsset,
  assertOnline,
  backoffMs,
  cosignInstallScript,
  downloadRelease,
  exactIdentity,
  exitStatus,
  fetchWithBackoff,
  fromReleaseRefusal,
  githubHeaders,
  identityRegexp,
  installPublished,
  isRateLimited,
  parseSeeded,
  psqlCommand,
  publishedInstallCommand,
  releaseApiUrl,
  releaseAssets,
  releaseTag,
  retryableStatus,
  seedCheckSql,
  seedNames,
  seedProblems,
  seedScript,
  selectAssets,
  shellQuote,
  signerFor,
  upgradeBlocker,
  upgradeOutcome,
  verificationProblems,
  verifyAndUnpackScript,
  verifyCommands,
} from "./e2e-from-release.ts";
import { e2eOptions } from "./e2e.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const asset = (name: string, size = 3): ReleaseAsset => ({
  name,
  url: `https://github.com/abolishus/commonair/releases/download/v0.1.0-rc.2/${name}`,
  size,
});
// What rc.2 published, abridged: the four the mode needs among the others.
const RC2 = [
  "commonair-image-api_0.1.0-rc.2.provenance.json",
  "commonair-relay_0.1.0-rc.2_linux_amd64",
  "commonair-relay_0.1.0-rc.2_linux_amd64.sigstore.json",
  "commonair-selfhost_0.1.0-rc.2.tar.gz",
  "release-manifest.json",
  "SHA256SUMS",
  "SHA256SUMS.sigstore.json",
].map((n) => asset(n));

describe("options", () => {
  test("--from-release takes a release tag", () => {
    expect(e2eOptions(["--from-release", "v0.1.0-rc.2"])).toMatchObject({
      fromRelease: "v0.1.0-rc.2",
      storage: "garage",
      state: "bundled",
    });
    expect(e2eOptions([]).fromRelease).toBeUndefined();
  });

  test.each([
    [["--from-release"], "--from-release takes a release tag such as v0.1.0-rc.2, not nothing"],
    [["--from-release", "0.1.0-rc.2"], "not 0.1.0-rc.2"],
    [["--from-release", "v0.1"], "not v0.1"],
    [["--from-release", "v0.1.0-rc.2", "--storage", "external"], "--from-release runs with the bundled default only"],
    [["--from-release", "v0.1.0-rc.2", "--state", "external"], "--from-release runs with the bundled default only"],
  ])("%j is refused", (argv, message) => {
    expect(() => e2eOptions(argv)).toThrow(message);
  });

  test("releaseTag", () => {
    expect(releaseTag("v0.1.0-rc.2")).toEqual({ tag: "v0.1.0-rc.2", version: "0.1.0-rc.2" });
    expect(releaseTag("v1.2.3")).toEqual({ tag: "v1.2.3", version: "1.2.3" });
  });
});

describe("release assets", () => {
  test("picks the bundle, its checksums, their signature and the manifest from what the release lists", () => {
    const s = selectAssets("0.1.0-rc.2", RC2);
    expect(s.bundle.name).toBe("commonair-selfhost_0.1.0-rc.2.tar.gz");
    expect(s.sums.name).toBe("SHA256SUMS");
    expect(s.signature.name).toBe("SHA256SUMS.sigstore.json");
    expect(s.manifest.name).toBe("release-manifest.json");
  });

  test("names every missing asset and what the release has", () => {
    const without = RC2.filter(
      (a) => a.name !== "SHA256SUMS.sigstore.json" && !a.name.startsWith("commonair-selfhost"),
    );
    expect(() => selectAssets("0.1.0-rc.2", without)).toThrow(
      /lacks commonair-selfhost_0\.1\.0-rc\.2\.tar\.gz, SHA256SUMS\.sigstore\.json; it has commonair-image-api/,
    );
    expect(() => selectAssets("0.1.0-rc.2", [])).toThrow("it has no assets");
  });

  test("another version's bundle is not this one's", () => {
    const other = RC2.map((a) =>
      a.name.startsWith("commonair-selfhost") ? asset("commonair-selfhost_0.1.0-rc.1.tar.gz") : a,
    );
    expect(() => selectAssets("0.1.0-rc.2", other)).toThrow("lacks commonair-selfhost_0.1.0-rc.2.tar.gz");
  });

  test("the names are the ones release.yml's tooling publishes", () => {
    // release.yml assembles with scripts/release/{assemble,checksums}.ts, which use these names.
    const tooling = read("scripts/release/manifest.ts") + read("scripts/release/assets.ts");
    expect(tooling).toContain('export const CHECKSUMS_ASSET = "SHA256SUMS";');
    expect(tooling).toContain('export const MANIFEST_ASSET = "release-manifest.json";');
    expect(tooling).toContain(
      "export const bundleAssetName = (version: string) => `commonair-selfhost_${version}.tar.gz`;",
    );
    expect(tooling).toContain("export const signatureAsset = (base: string) => `${base}.sigstore.json`;");
  });

  test("reads GitHub's release response", () => {
    expect(
      releaseAssets({ assets: [{ name: "SHA256SUMS", browser_download_url: "https://x/SHA256SUMS", size: 7 }] }),
    ).toEqual([{ name: "SHA256SUMS", url: "https://x/SHA256SUMS", size: 7 }]);
    expect(() => releaseAssets({ message: "Not Found" })).toThrow("no asset list");
    expect(() => releaseAssets({ assets: [{ name: 3 }] })).toThrow("without a name or download URL");
  });

  test("the API URL of a github.com repository", () => {
    expect(releaseApiUrl("https://github.com/abolishus/commonair", "v0.1.0-rc.2")).toBe(
      "https://api.github.com/repos/abolishus/commonair/releases/tags/v0.1.0-rc.2",
    );
    expect(() => releaseApiUrl("https://gitlab.com/a/b", "v1.0.0")).toThrow("not a github.com repository URL");
  });

  test("a token raises the rate limit but is never required", () => {
    expect(githubHeaders({}).authorization).toBeUndefined();
    expect(githubHeaders({ GH_TOKEN: "t" }).authorization).toBe("Bearer t");
    expect(githubHeaders({ GITHUB_TOKEN: "a", GH_TOKEN: "b" }).authorization).toBe("Bearer a");
  });
});

describe("the verify commands", () => {
  const md = read("docs/self-hosting/verifying.md");
  const regexpInDocs = /--certificate-identity-regexp '([^']+)'/.exec(md)?.[1];
  const issuerInDocs = /--certificate-oidc-issuer (\S+)/.exec(md)?.[1];

  test("the identity regexp and issuer are verifying.md's, character for character", () => {
    const [regexp] = verifyCommands("v0.1.0-rc.2");
    expect(regexpInDocs).toBeDefined();
    expect(regexp).toEqual([
      "cosign",
      "verify-blob",
      "--bundle",
      "SHA256SUMS.sigstore.json",
      "--certificate-identity-regexp",
      regexpInDocs,
      "--certificate-oidc-issuer",
      issuerInDocs,
      "SHA256SUMS",
    ]);
    expect(issuerInDocs).toBe(OIDC_ISSUER);
  });

  test("then the exact identity of the tag's own run, and the checksums as verifying.md checks them", () => {
    const [, exact, sums] = verifyCommands("v0.1.0-rc.2");
    expect(exact).toEqual([
      "cosign",
      "verify-blob",
      "--bundle",
      "SHA256SUMS.sigstore.json",
      "--certificate-identity",
      "https://github.com/abolishus/commonair/.github/workflows/release.yml@refs/tags/v0.1.0-rc.2",
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      "SHA256SUMS",
    ]);
    expect(sums).toEqual(["sha256sum", "--check", "--ignore-missing", "SHA256SUMS"]);
    expect(md).toContain("sha256sum --check --ignore-missing SHA256SUMS");
    expect(md).toContain('cosign verify-blob --bundle SHA256SUMS.sigstore.json "${ID[@]}" SHA256SUMS');
  });

  test("the exact identity matches the documented regexp, and only for this repository's version tags", () => {
    const re = new RegExp(identityRegexp(RELEASE_REPOSITORY, signerFor("v0.1.0-rc.2")));
    expect(re.test(exactIdentity(RELEASE_REPOSITORY, "v0.1.0-rc.2"))).toBe(true);
    for (const wrong of [
      "https://github.com/abolishus/commonair/.github/workflows/release.yml@refs/heads/main",
      "https://github.com/abolishus/commonair/.github/workflows/ci.yml@refs/tags/v0.1.0",
      "https://github.com/someone/commonair/.github/workflows/release.yml@refs/tags/v0.1.0",
      "https://github.com/abolishus/commonairX.github/workflows/release.yml@refs/tags/v0.1.0",
    ])
      expect(re.test(wrong), wrong).toBe(false);
  });

  test("the identity is release.yml's: that file, run for a v* tag push, signing keylessly", () => {
    const wf = read(".github/workflows/release.yml");
    expect(RELEASE_SIGNERS.at(-1)?.workflow).toBe(".github/workflows/release.yml");
    expect(wf).toMatch(/^on:\n {2}push:\n {4}tags: \["v\*"\]/m);
    expect(wf).toContain("id-token: write");
  });

  test("selfhost.sh derives the same regexp and issuer from its repository URL", () => {
    const sh = read("scripts/selfhost.sh");
    expect(sh).toContain(`DEFAULT_REPOSITORY_URL="${RELEASE_REPOSITORY}"`);
    expect(sh).toContain(`OIDC_ISSUER="${OIDC_ISSUER}"`);
    expect(sh).toContain("printf '^%s/\\\\.github/workflows/release\\\\.yml@refs/tags/v' \"$_escaped\"");
  });

  test("each tag verifies against the workflow that signed it", () => {
    const signers = [
      { since: "v0.1.0-rc.1", workflow: ".github/workflows/release.yml" },
      { since: "v0.3.0", workflow: ".github/workflows/publish.yml" },
    ];
    expect(signerFor("v0.1.0-rc.2", signers)).toBe(".github/workflows/release.yml");
    expect(signerFor("v0.2.9", signers)).toBe(".github/workflows/release.yml");
    expect(signerFor("v0.3.0-rc.1", signers)).toBe(".github/workflows/release.yml");
    expect(signerFor("v0.3.0", signers)).toBe(".github/workflows/publish.yml");
    expect(exactIdentity("https://github.com/a/b", "v0.4.0", signers)).toBe(
      "https://github.com/a/b/.github/workflows/publish.yml@refs/tags/v0.4.0",
    );
    expect(() => signerFor("v0.0.9", signers)).toThrow("no known signing workflow for v0.0.9");
  });

  test("the host script copies, verifies, then unpacks, stopping at the first failure", () => {
    const s = verifyAndUnpackScript("/e2e/releases/published-v0.1.0-rc.2", "v0.1.0-rc.2");
    const order = [
      "cp /e2e/releases/published-v0.1.0-rc.2/* /root/commonair-release/",
      "--certificate-identity-regexp '^https://github\\.com/abolishus/commonair/\\.github/workflows/release\\.yml@refs/tags/v'",
      "--certificate-identity https://github.com/abolishus/commonair/.github/workflows/release.yml@refs/tags/v0.1.0-rc.2",
      "sha256sum --check --ignore-missing SHA256SUMS",
      "tar -xzf commonair-selfhost_0.1.0-rc.2.tar.gz",
    ].map((part) => s.indexOf(part));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(s).toMatch(/^\(.* && .*\) 2>&1; echo "exit=\$\?"$/);
  });

  test("the run must show two good signatures and the bundle's OK", () => {
    const good =
      "Verified OK\nVerified OK\ncommonair-selfhost_0.1.0-rc.2.tar.gz: OK\nrelease-manifest.json: OK\nexit=0\n";
    expect(verificationProblems(good, "0.1.0-rc.2")).toEqual([]);
    expect(verificationProblems("Verified OK\nexit=1\n", "0.1.0-rc.2")).toEqual([
      "the verification stopped with exit 1",
      'cosign printed "Verified OK" 1 times, not 2',
      "sha256sum did not report commonair-selfhost_0.1.0-rc.2.tar.gz: OK",
    ]);
    expect(
      verificationProblems(good.replace("release-manifest.json: OK", "release-manifest.json: FAILED"), "0.1.0-rc.2"),
    ).toEqual(["sha256sum reported a FAILED checksum"]);
  });

  test("cosign is installed as install.md says: the pinned 3.x binary, checked before it is installed", () => {
    const s = cosignInstallScript("amd64");
    expect(TOOLS.cosign.version).toMatch(/^3\./);
    expect(s).toContain(TOOLS.cosign.assets["linux/amd64"].url);
    expect(s).toContain(`echo "${TOOLS.cosign.assets["linux/amd64"].sha256}  $d/cosign" | sha256sum --check`);
    expect(s.indexOf("sha256sum --check")).toBeLessThan(s.indexOf("install -m 0755"));
    const installMd = read("docs/self-hosting/install.md");
    expect(installMd).toContain(`x86_64) ARCH=amd64 SUM=${TOOLS.cosign.assets["linux/amd64"].sha256}`);
    expect(installMd).toContain(`aarch64) ARCH=arm64 SUM=${TOOLS.cosign.assets["linux/arm64"].sha256}`);
    expect(installMd).toContain(`cosign/releases/download/v${TOOLS.cosign.version}/cosign-linux-$ARCH`);
  });

  test("shellQuote", () => {
    expect(shellQuote("SHA256SUMS")).toBe("SHA256SUMS");
    expect(shellQuote("^a\\.b")).toBe("'^a\\.b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("the published install", () => {
  test("the release's own selfhost.sh, downloading the tag itself, with the signature required", () => {
    const cmd = publishedInstallCommand("v0.1.0-rc.2", "--tls internal --domain selfhost.test");
    expect(cmd).toBe(
      "cd /root/commonair-release && sh commonair-selfhost_0.1.0-rc.2/selfhost.sh install --yes --version v0.1.0-rc.2 " +
        '--require-signature --tls internal --domain selfhost.test 2>&1; echo "exit=$?"',
    );
    expect(publishedInstallCommand("v0.1.0-rc.2", "", true)).toContain("--reinstall 2>&1");
  });

  // Every flag the e2e passes must be one rc.2's own parse_flags accepts.
  test("passes only flags v0.1.0-rc.2's selfhost.sh knows", () => {
    const r = Bun.spawnSync(["git", "show", "v0.1.0-rc.2:scripts/selfhost.sh"], { cwd: ROOT });
    if (r.exitCode !== 0) return; // a shallow checkout without the tag: nothing to compare against
    const rc2 = r.stdout.toString();
    const parse = rc2.slice(rc2.indexOf("parse_flags() {"), rc2.indexOf("cmd_install() {"));
    const e2e = read("scripts/selfhost/e2e.ts");
    const at = e2e.indexOf("extra:\n"); // the install flags, not the listener message
    const extra = e2e.slice(at, e2e.indexOf("log,", at));
    const flags = [
      ...new Set(
        [...`${extra} ${publishedInstallCommand("v0.1.0-rc.2", "", true)}`.matchAll(/--[a-z-]+/g)].map((m) => m[0]),
      ),
    ];
    expect(flags.length).toBeGreaterThan(5);
    for (const f of flags) expect(parse, f).toContain(f);
  });

  test("a rate limit is told apart from other failures", () => {
    for (const s of [
      "Error: initializing source docker://ghcr.io/x: reading manifest: toomanyrequests: retry later",
      "received unexpected HTTP status: 429 Too Many Requests",
      "API rate limit exceeded",
    ])
      expect(isRateLimited(s), s).toBe(true);
    for (const s of ["manifest unknown", "unauthorized: authentication required", "exit=1"])
      expect(isRateLimited(s), s).toBe(false);
  });

  const quiet = { log: () => {}, sleep: async () => {} };
  const fakeHost = (installs: string[]) => {
    const calls: string[] = [];
    const inHost = (script: string) => {
      calls.push(script);
      if (script.includes("selfhost.sh install")) return installs.shift() ?? "exit=1\n";
      if (script.includes("sha256sum --check --ignore-missing"))
        return "Verified OK\nVerified OK\ncommonair-selfhost_0.1.0-rc.2.tar.gz: OK\nexit=0\n";
      return "";
    };
    const failures: string[] = [];
    const expectThat = (ok: boolean, what: string) => {
      if (!ok) failures.push(what);
    };
    return { calls, inHost, expectThat, failures };
  };

  test("retries a rate-limited install with --reinstall, with backoff", async () => {
    const h = fakeHost(["toomanyrequests\nexit=1\n", "exit=0\n"]);
    const waits: number[] = [];
    await installPublished(h.inHost, h.expectThat, {
      tag: "v0.1.0-rc.2",
      downloads: "/e2e/releases/published-v0.1.0-rc.2",
      extra: "--tls internal",
      ...quiet,
      sleep: async (ms) => {
        waits.push(ms);
      },
      baseMs: 10,
    });
    const installs = h.calls.filter((c) => c.includes("selfhost.sh install"));
    expect(installs).toHaveLength(2);
    expect(installs[0]).not.toContain("--reinstall");
    expect(installs[1]).toContain("--reinstall");
    expect(waits).toEqual([10]);
    expect(h.failures).toEqual([]);
    // cosign first, then the verification, then the install.
    expect(h.calls[0]).toContain("/usr/local/bin/cosign");
    expect(h.calls[1]).toContain("sha256sum --check --ignore-missing");
  });

  test("any other failure stops at once, with the install's output", async () => {
    const h = fakeHost(["selfhost: ERROR: could not pull x\nexit=1\n"]);
    await expect(
      installPublished(h.inHost, h.expectThat, { tag: "v0.1.0-rc.2", downloads: "/d", extra: "", ...quiet }),
    ).rejects.toThrow(/did not install \(try 1\):\nselfhost: ERROR: could not pull x/);
  });

  test("gives up after the last try", async () => {
    const h = fakeHost(["toomanyrequests\nexit=1\n", "toomanyrequests\nexit=1\n"]);
    await expect(
      installPublished(h.inHost, h.expectThat, {
        tag: "v0.1.0-rc.2",
        downloads: "/d",
        extra: "",
        attempts: 2,
        ...quiet,
      }),
    ).rejects.toThrow("did not install (try 2)");
  });

  test("exitStatus", () => {
    expect(exitStatus("x\nexit=0\n")).toBe(0);
    expect(exitStatus("exit=0\nexit=1")).toBe(1);
    expect(exitStatus("nothing")).toBeNull();
  });
});

describe("network", () => {
  const response = (status: number, headers: Record<string, string> = {}, body = "{}") =>
    new Response(body, { status, headers });
  const scripted = (answers: (Response | Error)[]) => {
    const urls: string[] = [];
    const waits: number[] = [];
    return {
      urls,
      waits,
      deps: {
        fetch: async (url: string) => {
          urls.push(url);
          const a = answers.shift();
          if (!a) throw new Error("no more answers");
          if (a instanceof Error) throw a;
          return a;
        },
        sleep: async (ms: number) => {
          waits.push(ms);
        },
      },
    };
  };

  test("backoff: base, then three times as long each try", () => {
    expect([0, 1, 2].map((i) => backoffMs(i, 5000))).toEqual([5000, 15000, 45000]);
  });

  test("retries a rate limit, a 5xx and a network error, then returns the answer", async () => {
    const s = scripted([
      response(429),
      response(403, { "x-ratelimit-remaining": "0" }),
      new Error("ECONNRESET"),
      response(200),
    ]);
    const r = await fetchWithBackoff("https://x", {}, { attempts: 4, baseMs: 1, deps: s.deps });
    expect(r.status).toBe(200);
    expect(s.waits).toEqual([1, 3, 9]);
  });

  test("a 404 or a plain 403 is not retried", async () => {
    const s = scripted([response(404)]);
    expect((await fetchWithBackoff("https://x", {}, { deps: s.deps })).status).toBe(404);
    expect(s.urls).toHaveLength(1);
    expect(retryableStatus(403, new Headers())).toBe(false);
    expect(retryableStatus(502, new Headers())).toBe(true);
  });

  test("a network error on every try throws", async () => {
    const s = scripted([new Error("ENOTFOUND"), new Error("ENOTFOUND")]);
    await expect(fetchWithBackoff("https://x", {}, { attempts: 2, baseMs: 1, deps: s.deps })).rejects.toThrow(
      "https://x: ENOTFOUND after 2 tries",
    );
  });

  test("offline: refuses with a clear message instead of hanging", async () => {
    const s = scripted([new Error("getaddrinfo ENOTFOUND api.github.com")]);
    const err = await assertOnline(s.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OfflineError);
    expect((err as Error).message).toContain("--from-release needs network access");
    expect((err as Error).message).toContain("It does not run offline");
  });

  test("online: any HTTP answer from GitHub and ghcr will do", async () => {
    const s = scripted([response(200), response(401)]);
    await assertOnline(s.deps);
    expect(s.urls).toEqual(["https://api.github.com/", "https://ghcr.io/v2/"]);
  });

  test("downloads the four assets the release lists, checking each size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-from-release-"));
    const listing = { assets: RC2.map((a) => ({ name: a.name, browser_download_url: a.url, size: 3 })) };
    const s = scripted([
      response(200, {}, JSON.stringify(listing)),
      response(200, {}, "abc"),
      response(200, {}, "abc"),
      response(200, {}, "abc"),
      response(200, {}, "abc"),
    ]);
    const got = await downloadRelease("v0.1.0-rc.2", dir, { env: {}, deps: s.deps });
    expect(s.urls[0]).toBe("https://api.github.com/repos/abolishus/commonair/releases/tags/v0.1.0-rc.2");
    expect(s.urls.slice(1).map((u) => u.split("/").at(-1))).toEqual([
      "commonair-selfhost_0.1.0-rc.2.tar.gz",
      "SHA256SUMS",
      "SHA256SUMS.sigstore.json",
      "release-manifest.json",
    ]);
    expect(readFileSync(join(dir, "SHA256SUMS"), "utf8")).toBe("abc");
    expect(got.bundle.name).toBe("commonair-selfhost_0.1.0-rc.2.tar.gz");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a truncated download fails", async () => {
    const listing = { assets: RC2.map((a) => ({ name: a.name, browser_download_url: a.url, size: 9 })) };
    const s = scripted([response(200, {}, JSON.stringify(listing)), response(200, {}, "abc")]);
    const dir = mkdtempSync(join(tmpdir(), "e2e-from-release-"));
    await expect(downloadRelease("v0.1.0-rc.2", dir, { env: {}, deps: s.deps })).rejects.toThrow(
      "commonair-selfhost_0.1.0-rc.2.tar.gz: got 3 bytes, the release lists 9",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unknown tag says so", async () => {
    const s = scripted([response(404)]);
    await expect(downloadRelease("v9.9.9", tmpdir(), { env: {}, deps: s.deps })).rejects.toThrow(
      "https://github.com/abolishus/commonair has no release v9.9.9",
    );
  });
});

describe("CI", () => {
  test("only the workflow_dispatch run may pull every image from ghcr", () => {
    expect(FROM_RELEASE_EVENTS).toEqual(["workflow_dispatch"]);
    expect(fromReleaseRefusal({})).toBeNull();
    expect(fromReleaseRefusal({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch" })).toBeNull();
    expect(fromReleaseRefusal({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" })).toContain(
      "runs on CI only for workflow_dispatch",
    );
  });
});

describe("the upgrade", () => {
  test("a healthy upgrade", () => {
    expect(upgradeOutcome("selfhost: upgraded to 0.0.0-e2e.2\nexit=0\n")).toEqual({
      ok: true,
      rolledBack: false,
      unhealthy: [],
    });
  });

  // rc.2's own words when the candidate's units do not come up (selfhost.sh at v0.1.0-rc.2).
  test("a rolled-back one names the units that did not come up", () => {
    const out = [
      "selfhost: WARNING: not healthy after 600s: otel-collector",
      "selfhost: WARNING: rolling back to 0.1.0-rc.2",
      "selfhost: ERROR: upgrade failed; rolled back to 0.1.0-rc.2, which is healthy",
      "exit=1",
    ].join("\n");
    const o = upgradeOutcome(out);
    expect(o).toEqual({ ok: false, rolledBack: true, unhealthy: ["otel-collector"] });
    expect(upgradeBlocker("v0.1.0-rc.2", "0.0.0-e2e.2", o, out)).toMatch(
      /^upgrading from the published v0\.1\.0-rc\.2 to 0\.0\.0-e2e\.2 with v0\.1\.0-rc\.2's own selfhost\.sh failed, and it rolled back to v0\.1\.0-rc\.2\nnot healthy: otel-collector\n/,
    );
  });

  test("the words it reads are rc.2's", () => {
    const r = Bun.spawnSync(["git", "show", "v0.1.0-rc.2:scripts/selfhost.sh"], { cwd: ROOT });
    if (r.exitCode !== 0) return;
    const rc2 = r.stdout.toString();
    expect(rc2).toContain('warn "not healthy after ${HEALTH_TIMEOUT}s:$_pending"');
    expect(rc2).toContain('die "upgrade failed; rolled back to $(installed_version), which is healthy"');
  });
});

describe("seed data", () => {
  const seeded = {
    streamer: "0190c3a2-0000-7000-8000-000000000001",
    viewer: "0190c3a2-0000-7000-8000-000000000002",
    channel: "0190c3a2-0000-7000-8000-000000000003",
    slug: "e2estreamerabcd1234",
    costId: "0190c3a2-0000-7000-8000-000000000004",
    transactionId: "0190c3a2-0000-7000-8000-000000000005",
  };

  test("names are valid usernames, stable per run", () => {
    const n = seedNames("803c7206");
    expect(n.streamer).toMatch(/^e2estreamer[0-9a-f]{8}$/);
    expect(n.viewer).toMatch(/^e2eviewer[0-9a-f]{8}$/);
    expect(n.streamer.length).toBeLessThanOrEqual(25);
    expect(seedNames("803c7206")).toEqual(n);
  });

  test("the seed writes through the release's own db and ledger code, as the app role, in one transaction", () => {
    const s = seedScript(seedNames("x"));
    expect(s).toContain('await import("/app/packages/db/src/index.ts")');
    expect(s).toContain('await import("/app/packages/ledger/src/index.ts")');
    expect(s).toContain("createDb({ url: process.env.DATABASE_URL");
    expect(s).toContain("db.transaction(");
    expect(s).toContain("post(tx, infrastructureCost(");
    expect(s).toContain('provider: "manual"');
    // What rc.2's cost.record handler writes beside its posting.
    expect(s).toContain("ledgerTransactionId: r.transactionId");
    expect(s).toContain("tx.insert(schema.follows)");
  });

  test("the seed script parses as JavaScript (a module, for its top-level await)", () => {
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(seedScript(seedNames("x")))).not.toThrow();
  });

  test("parseSeeded takes the last line and checks every id", () => {
    expect(parseSeeded(`noise\n${JSON.stringify(seeded)}\n`)).toEqual(seeded);
    expect(() => parseSeeded("Error: boom")).toThrow("the seed printed no JSON");
    expect(() => parseSeeded(JSON.stringify({ ...seeded, channel: "'; drop table users; --" }))).toThrow(
      "the seed printed no channel id",
    );
    expect(() => parseSeeded(JSON.stringify({ ...seeded, slug: "a b" }))).toThrow("no slug");
  });

  test("the check reads members, follower count, follow, a balanced posting and its cost row", () => {
    const sql = seedCheckSql(seeded);
    for (const id of Object.values(seeded).filter((v) => v.includes("-"))) expect(sql).toContain(`'${id}'`);
    expect(sql).toContain("sum(amount_cents)");
    expect(() => seedCheckSql({ ...seeded, viewer: "x' or '1'='1" })).toThrow("not a UUID");
    expect(psqlCommand("select 1")).toBe(
      "podman exec --user postgres commonair-postgres psql -X -q -v ON_ERROR_STOP=1 -U commonair -d commonair -At -F '|' -c 'select 1'",
    );
  });

  test("seedProblems", () => {
    expect(seedProblems("2|1|1|2|0|1\n")).toEqual([]);
    expect(seedProblems("1|0|0|2|5|0")).toEqual([
      "both members: 1, want 2",
      "the channel's follower count: 0, want 1",
      "the follow: 0, want 1",
      "the posting's balance: 5, want 0",
      "the infrastructure cost: 0, want 1",
    ]);
    expect(seedProblems("")).toHaveLength(6);
  });
});
