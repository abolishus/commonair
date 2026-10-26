// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { checkAssets, expectedAssets } from "../release/assemble.ts";
import { imageAssetBase, imageProvenanceAsset, provenanceAsset, sbomAsset, signatureAsset } from "../release/assets.ts";
import { EXCLUDED, formatSums, sumsForDir } from "../release/checksums.ts";
import { needsSummary, stripAnsi, verifySummary } from "../release/ci-summary.ts";
import { RELAY_TARGETS, RELEASE_IMAGES, parseManifest, relayAssetName } from "../release/manifest.ts";
import { DRY_RUN_REGISTRY, type PlanInput, outputs, plan, registryFor } from "../release/prepare.ts";
import { BUILD_TYPE, contextFromEnv, slsaPredicate } from "../release/provenance.ts";
import { archiveName, indexArgv, isInsecure, signArgv, sbomArgv } from "../release/publish-image.ts";
import { attestBlobArgv, relayBuild, signBlobArgv } from "../release/relay.ts";
import { type Fetch, client, parseChallenge, repoUrl, tagLatest } from "../release/tag-latest.ts";
import { TOOLS, assertChecksum, currentHost, sha256Hex } from "../release/tools.ts";

const base: PlanInput = {
  eventName: "push",
  ref: "refs/tags/v0.1.0",
  inputTag: "",
  inputDryRun: "",
  inputSign: "",
  inputPlatforms: "",
  owner: "AbolishUs",
  runNumber: "42",
};

describe("plan", () => {
  test("a stable tag push is a real, signed release that moves latest", () => {
    expect(plan(base)).toEqual({
      tag: "v0.1.0",
      version: "0.1.0",
      dryRun: false,
      sign: true,
      prerelease: false,
      latest: true,
      registry: "ghcr.io/abolishus/commonair",
      platforms: ["linux/amd64", "linux/arm64"],
    });
  });

  test("a prerelease tag does not move latest", () => {
    expect(plan({ ...base, ref: "refs/tags/v0.1.0-rc.1" })).toMatchObject({
      prerelease: true,
      latest: false,
      dryRun: false,
    });
  });

  test("a non-semver tag is refused", () => {
    expect(() => plan({ ...base, ref: "refs/tags/v1.0" })).toThrow("not a release tag");
    expect(() => plan({ ...base, ref: "refs/tags/vnext" })).toThrow("not a release tag");
  });

  test("CI's call from main is a dry run to the local registry, unsigned by default", () => {
    const p = plan({ ...base, ref: "refs/heads/main", inputDryRun: "true" });
    expect(p).toMatchObject({
      tag: "v0.0.0-dryrun.42",
      dryRun: true,
      sign: false,
      latest: false,
      registry: DRY_RUN_REGISTRY,
    });
  });

  test("a dry run can opt into signing", () => {
    expect(
      plan({ ...base, eventName: "workflow_dispatch", ref: "refs/heads/main", inputDryRun: "true", inputSign: "true" })
        .sign,
    ).toBe(true);
  });

  test("a manual real release needs a tag and publishes to the owner's namespace", () => {
    const dispatch = { ...base, eventName: "workflow_dispatch", ref: "refs/tags/v2.0.0", inputDryRun: "false" };
    expect(() => plan(dispatch)).toThrow("needs a tag");
    expect(plan({ ...dispatch, inputTag: "v2.0.0", owner: "Fork-Owner" })).toMatchObject({
      dryRun: false,
      registry: "ghcr.io/fork-owner/commonair",
    });
  });

  test("a real release runs only from its own tag ref, so signatures carry @refs/tags/v…", () => {
    const dispatch = { ...base, eventName: "workflow_dispatch", inputDryRun: "false", inputTag: "v2.0.0" };
    expect(() => plan({ ...dispatch, ref: "refs/heads/main" })).toThrow("--ref v2.0.0");
    expect(() => plan({ ...dispatch, ref: "refs/tags/v1.9.0" })).toThrow("must run from refs/tags/v2.0.0");
    expect(() =>
      plan({ ...base, eventName: "workflow_call", ref: "refs/heads/main", inputDryRun: "false", inputTag: "v2.0.0" }),
    ).toThrow("must run from");
    // Dry runs may run from anywhere.
    expect(plan({ ...dispatch, ref: "refs/heads/main", inputDryRun: "true" }).dryRun).toBe(true);
  });

  test("anything that is not a tag push or dry_run=false is a dry run", () => {
    expect(plan({ ...base, eventName: "schedule", ref: "refs/heads/main" }).dryRun).toBe(true);
  });

  test("a tag push with an explicit dry_run input respects it", () => {
    expect(plan({ ...base, inputDryRun: "true", inputTag: "v0.1.0" }).dryRun).toBe(true);
  });

  test("platforms input narrows the build", () => {
    expect(plan({ ...base, inputPlatforms: "linux/amd64" }).platforms).toEqual(["linux/amd64"]);
    expect(() => plan({ ...base, inputPlatforms: "windows/amd64" })).toThrow("unsupported platform");
  });

  test("owner and run number are validated before they reach outputs", () => {
    expect(() => registryFor("evil/../x")).toThrow("invalid repository owner");
    expect(() => plan({ ...base, ref: "refs/heads/main", inputDryRun: "true", runNumber: "1\nx=y" })).toThrow(
      "invalid run number",
    );
  });

  test("outputs are single-line strings", () => {
    const p = plan(base);
    const out = outputs(p, "a".repeat(40), [
      { image: "api", platform: "linux/amd64", arch: "amd64", runner: "ubuntu-24.04" },
    ]);
    for (const v of Object.values(out)) expect(v).not.toContain("\n");
    expect(JSON.parse(out.build_matrix ?? "")).toEqual({
      include: [{ image: "api", platform: "linux/amd64", arch: "amd64", runner: "ubuntu-24.04" }],
    });
    expect(out).toMatchObject({ dry_run: "false", latest: "true", platforms: "linux/amd64,linux/arm64" });
  });
});

describe("publish-image commands", () => {
  const o = {
    image: "api" as const,
    version: "0.1.0",
    registry: "ghcr.io/x/commonair",
    platforms: ["linux/amd64", "linux/arm64"] as ("linux/amd64" | "linux/arm64")[],
    archives: "/a",
  };
  const d = `sha256:${"1".repeat(64)}`;

  test("the index is built from the per-arch archives and pushed under the tag", () => {
    expect(indexArgv(o, "0.1.0", "/out/api.digest")).toEqual([
      ["podman", "manifest", "create", "localhost/commonair-release/api:0.1.0"],
      ["podman", "manifest", "add", "localhost/commonair-release/api:0.1.0", "oci-archive:/a/api-amd64.tar"],
      ["podman", "manifest", "add", "localhost/commonair-release/api:0.1.0", "oci-archive:/a/api-arm64.tar"],
      [
        "podman",
        "manifest",
        "push",
        "--all",
        "--format",
        "oci",
        "--digestfile",
        "/out/api.digest",
        "localhost/commonair-release/api:0.1.0",
        "docker://ghcr.io/x/commonair/api:0.1.0",
      ],
    ]);
    expect(archiveName("relay", "linux/arm64")).toBe("relay-arm64.tar");
  });

  test("the dry-run registry is spoken to over HTTP everywhere", () => {
    const dry = { ...o, registry: DRY_RUN_REGISTRY };
    expect(isInsecure(DRY_RUN_REGISTRY)).toBe(true);
    expect(isInsecure("ghcr.io/x/commonair")).toBe(false);
    expect(isInsecure("localhost.example.org/x")).toBe(false);
    expect(indexArgv(dry, "0.1.0", "/d").at(-1)).toContain("--tls-verify=false");
    for (const argv of signArgv(dry, d, ["/s.json"], "/p.json")) expect(argv).toContain("--allow-http-registry");
    expect(indexArgv(o, "0.1.0", "/d").at(-1)).not.toContain("--tls-verify=false");
  });

  test("SBOMs scan the pushed index per platform", () => {
    expect(sbomArgv(o, d, "linux/arm64", "/o.json")).toEqual([
      "syft",
      "scan",
      `registry:ghcr.io/x/commonair/api@${d}`,
      "--platform",
      "linux/arm64",
      "--output",
      "cyclonedx-json=/o.json",
    ]);
  });

  test("signing signs recursively by digest and attaches every SBOM and the provenance", () => {
    const cmds = signArgv(o, d, ["/a.json", "/b.json"], "/p.json");
    expect(cmds[0]).toEqual(["cosign", "sign", "--yes", "--recursive", `ghcr.io/x/commonair/api@${d}`]);
    expect(cmds.filter((c) => c.includes("cyclonedx"))).toHaveLength(2);
    expect(cmds.at(-1)).toEqual([
      "cosign",
      "attest",
      "--yes",
      "--type",
      "slsaprovenance1",
      "--predicate",
      "/p.json",
      `ghcr.io/x/commonair/api@${d}`,
    ]);
    for (const c of cmds) expect(c.at(-1)).toMatch(/@sha256:/);
  });
});

describe("tag-latest", () => {
  const INDEX = "application/vnd.oci.image.index.v1+json";
  const body = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, mediaType: INDEX, manifests: [] }));
  const digest = `sha256:${new Bun.CryptoHasher("sha256").update(body).digest("hex")}`;

  /** A fake ghcr: one Bearer challenge, then GET by digest and PUT to latest. */
  function fakeRegistry(opts: { type?: string; putDigest?: string } = {}) {
    const calls: { url: string; method: string; auth?: string; ct?: string }[] = [];
    const f: Fetch = async (url, init = {}) => {
      const h = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init.method ?? "GET", auth: h.Authorization, ct: h["Content-Type"] });
      if (url.startsWith("https://ghcr.io/token")) return Response.json({ token: "T" });
      if (h.Authorization !== "Bearer T")
        return new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
        });
      if (init.method === "PUT")
        return new Response(null, { status: 201, headers: { "Docker-Content-Digest": opts.putDigest ?? digest } });
      return new Response(body, { headers: { "Content-Type": opts.type ?? INDEX } });
    };
    return { f, calls };
  }

  test("repository URLs: https for ghcr, http for the dry-run registry", () => {
    expect(repoUrl("ghcr.io/x/commonair", "api")).toEqual({ base: "https://ghcr.io/v2", name: "x/commonair/api" });
    expect(repoUrl(DRY_RUN_REGISTRY, "api").base).toBe("http://localhost:5000/v2");
    expect(() => repoUrl("ghcr.io", "api")).toThrow("namespace");
  });

  test("bearer challenges are parsed", () => {
    expect(parseChallenge('Bearer realm="https://r/token",service="r"')).toEqual({
      realm: "https://r/token",
      service: "r",
    });
    expect(parseChallenge('Basic realm="x"')).toBeNull();
  });

  test("copies the index bytes to latest under the same digest, authenticating once", async () => {
    const { f, calls } = fakeRegistry();
    const call = client(f, { user: "u", token: "p" });
    await tagLatest(call, "ghcr.io/x/commonair", "api", digest);
    const tokenReq = calls.find((c) => c.url.startsWith("https://ghcr.io/token"));
    expect(tokenReq?.url).toContain("scope=repository%3Ax%2Fcommonair%2Fapi%3Apull%2Cpush");
    expect(tokenReq?.auth).toBe(`Basic ${btoa("u:p")}`);
    const put = calls.find((c) => c.method === "PUT");
    expect(put).toMatchObject({
      url: "https://ghcr.io/v2/x/commonair/api/manifests/latest",
      ct: INDEX,
      auth: "Bearer T",
    });
    expect(calls.filter((c) => c.url.startsWith("https://ghcr.io/token"))).toHaveLength(1);
  });

  test("refuses a bad digest, a non-index, or a registry that resolves latest elsewhere", async () => {
    await expect(tagLatest(client(fakeRegistry().f, null), "ghcr.io/x/c", "api", "sha256:zz")).rejects.toThrow(
      "invalid digest",
    );
    const other = `sha256:${"0".repeat(64)}`;
    await expect(tagLatest(client(fakeRegistry().f, null), "ghcr.io/x/c", "api", other)).rejects.toThrow(
      "registry returned",
    );
    const single = fakeRegistry({ type: "application/vnd.oci.image.manifest.v1+json" });
    await expect(tagLatest(client(single.f, null), "ghcr.io/x/c", "api", digest)).rejects.toThrow("not an index");
    const moved = fakeRegistry({ putDigest: other });
    await expect(tagLatest(client(moved.f, null), "ghcr.io/x/c", "api", digest)).rejects.toThrow("latest resolved to");
  });

  test("publish-image never pushes latest; the workflow moves it after the GitHub Release", () => {
    const wf = readFileSync(join(import.meta.dirname, "../../.github/workflows/release.yml"), "utf8");
    expect(readFileSync(join(import.meta.dirname, "../release/publish-image.ts"), "utf8")).not.toMatch(/"latest"/);
    const job = wf.slice(wf.indexOf("\n  latest:"));
    expect(job).toContain("needs: [prepare, publish]");
    expect(job).toContain("if: needs.prepare.outputs.latest == 'true'");
    expect(job).toContain("scripts/release/tag-latest.ts");
  });
});

describe("relay", () => {
  test("every target builds statically with the reproducible flags, named by the contract", () => {
    for (const t of RELAY_TARGETS) {
      const b = relayBuild("0.1.0", t, "/out");
      const [os, arch] = t.split("/");
      expect(b.env).toEqual({ CGO_ENABLED: "0", GOOS: os, GOARCH: arch });
      expect(b.out).toBe(`/out/${relayAssetName("0.1.0", t)}`);
      expect(b.argv).toEqual([
        "go",
        "build",
        "-trimpath",
        "-buildvcs=false",
        "-ldflags",
        "-s -w -buildid= -X main.version=0.1.0",
        "-o",
        b.out,
        "./cmd/commonair-relay",
      ]);
    }
  });

  test("blob signing writes Sigstore bundles", () => {
    expect(signBlobArgv("/b", "/b.sigstore.json")).toEqual([
      "cosign",
      "sign-blob",
      "--yes",
      "--bundle",
      "/b.sigstore.json",
      "/b",
    ]);
    expect(attestBlobArgv("/b", "/p.json", "/b.intoto.sigstore.json")).toEqual([
      "cosign",
      "attest-blob",
      "--yes",
      "--type",
      "slsaprovenance1",
      "--predicate",
      "/p.json",
      "--bundle",
      "/b.intoto.sigstore.json",
      "/b",
    ]);
  });
});

describe("asset names", () => {
  test("derived names", () => {
    const relay = relayAssetName("0.1.0", "linux/amd64");
    expect(sbomAsset(relay)).toBe("commonair-relay_0.1.0_linux_amd64.cdx.json");
    expect(signatureAsset(relay)).toBe("commonair-relay_0.1.0_linux_amd64.sigstore.json");
    expect(provenanceAsset(relay)).toBe("commonair-relay_0.1.0_linux_amd64.intoto.sigstore.json");
    expect(sbomAsset(imageAssetBase("api", "0.1.0", "linux/arm64"))).toBe(
      "commonair-image-api_0.1.0_linux_arm64.cdx.json",
    );
    expect(imageProvenanceAsset("api", "0.1.0")).toBe("commonair-image-api_0.1.0.provenance.json");
  });

  test("image assets never collide with relay binary names", () => {
    expect(imageAssetBase("relay", "0.1.0", "linux/amd64")).not.toBe(relayAssetName("0.1.0", "linux/amd64"));
  });
});

describe("checksums", () => {
  const dir = mkdtempSync(join(tmpdir(), "sums-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("sha256sum format, sorted, excluding the sums file and its signature", () => {
    writeFileSync(join(dir, "b.txt"), "b");
    writeFileSync(join(dir, "a.txt"), "a");
    for (const e of EXCLUDED) writeFileSync(join(dir, e), "x");
    expect(sumsForDir(dir)).toBe(
      `${sha256Hex(new TextEncoder().encode("a"))}  a.txt\n${sha256Hex(new TextEncoder().encode("b"))}  b.txt\n`,
    );
  });

  test("refuses names a sums file cannot carry", () => {
    expect(() => formatSums([{ name: "a b", sha256: "0".repeat(64) }])).toThrow("flat and unspaced");
    expect(() => formatSums([{ name: "x", sha256: "nope" }])).toThrow("bad sha256");
  });

  test("an empty directory fails", () => {
    const empty = mkdtempSync(join(tmpdir(), "sums-empty-"));
    expect(() => sumsForDir(empty)).toThrow("no assets");
    rmSync(empty, { recursive: true });
  });
});

describe("provenance", () => {
  const env = {
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "o/commonair",
    GITHUB_WORKFLOW_REF: "o/commonair/.github/workflows/release.yml@refs/tags/v0.1.0",
    GITHUB_REF: "refs/tags/v0.1.0",
    GITHUB_EVENT_NAME: "push",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  };

  test("an SLSA v1 predicate pinned to the commit and the workflow", () => {
    const p = slsaPredicate(contextFromEnv(env), { artifact: "x", version: "0.1.0", commit: "e".repeat(40) });
    expect(p.buildDefinition.buildType).toBe(BUILD_TYPE);
    expect(p.buildDefinition.externalParameters.workflow).toEqual({
      ref: "refs/tags/v0.1.0",
      repository: "https://github.com/o/commonair",
      path: ".github/workflows/release.yml",
    });
    expect(p.buildDefinition.resolvedDependencies).toEqual([
      { uri: "git+https://github.com/o/commonair@refs/tags/v0.1.0", digest: { gitCommit: "e".repeat(40) } },
    ]);
    expect(p.runDetails.metadata.invocationId).toBe("https://github.com/o/commonair/actions/runs/123/attempts/1");
  });

  test("outside Actions, or with a bad commit, it fails", () => {
    expect(() => contextFromEnv({})).toThrow("GITHUB_SERVER_URL is not set");
    expect(() => slsaPredicate(contextFromEnv(env), { artifact: "x", version: "1", commit: "abc" })).toThrow(
      "invalid commit",
    );
  });
});

describe("pinned tools", () => {
  test("every tool has a pinned build with a SHA-256 for every host and a license", () => {
    for (const [name, tool] of Object.entries(TOOLS)) {
      expect(tool.version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(tool.license, name).not.toBe("");
      for (const asset of Object.values(tool.assets)) {
        expect(asset.sha256, name).toMatch(/^[0-9a-f]{64}$/);
        expect(asset.url, name).toMatch(
          new RegExp(
            `^https://github\\.com/[\\w.-]+/[\\w.-]+/releases/download/v${tool.version.replaceAll(".", "\\.")}/`,
          ),
        );
      }
    }
  });

  test("install.md's cosign download matches the pinned cosign", () => {
    const doc = readFileSync(new URL("../../docs/self-hosting/install.md", import.meta.url), "utf8");
    const { version, assets } = TOOLS.cosign;
    expect(doc).toContain(`signs with cosign ${version}.`);
    for (const platform of ["linux/amd64", "linux/arm64"] as const) {
      const asset = assets[platform];
      expect(asset, platform).toBeDefined();
      if (!asset) continue;
      // Each hash sits on its own architecture's line, so a swap fails.
      expect(doc, platform).toContain(`ARCH=${platform.split("/")[1]} SUM=${asset.sha256} ;;`);
    }
    // One command for both architectures: the asset name ends in the architecture.
    const url = assets["linux/amd64"]?.url ?? "missing";
    expect(url.endsWith("-linux-amd64")).toBe(true);
    expect(doc).toContain(`"${url.replace(/amd64$/, "$ARCH")}"`);
    expect(assets["linux/arm64"]?.url).toBe(url.replace(/amd64$/, "arm64"));
  });

  test("a checksum mismatch is refused", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(() => assertChecksum("x", bytes, sha256Hex(bytes))).not.toThrow();
    expect(() => assertChecksum("x", bytes, "0".repeat(64))).toThrow("checksum mismatch");
  });

  test("hosts", () => {
    expect(currentHost("linux", "x64")).toBe("linux/amd64");
    expect(currentHost("linux", "arm64")).toBe("linux/arm64");
    expect(() => currentHost("win32", "x64")).toThrow("no pinned tool builds");
  });
});

describe("ci summary", () => {
  const log = [
    "\x1b[1m▶ format\x1b[0m  vp fmt --check",
    "",
    "\x1b[1mverify summary\x1b[0m",
    "  \x1b[32m✓\x1b[0m format                       1.2s",
    "  \x1b[31m✗\x1b[0m integration tests            301.0s (timed out)",
    "  – relay: govulncheck           skipped",
    "",
    "\x1b[31mRED\x1b[0m in 400.0s",
  ].join("\n");

  test("verify's own summary becomes a table", () => {
    const md = verifySummary(log);
    expect(md).toContain("| format | passed | 1.2s |");
    expect(md).toContain("| integration tests | **failed** | 301.0s (timed out) |");
    expect(md).toContain("| relay: govulncheck | skipped | skipped |");
    expect(md).toContain("RED in 400.0s");
  });

  test("a crashed gate says so", () => {
    expect(verifySummary("boom")).toContain("did not reach its summary");
    expect(stripAnsi("\x1b[1mx\x1b[0m")).toBe("x");
  });

  test("the aggregate fails on failure or cancellation, not on skips", () => {
    expect(needsSummary({ a: { result: "success" }, b: { result: "skipped" } }).ok).toBe(true);
    const bad = needsSummary({
      verify: { result: "failure" },
      lint: { result: "cancelled" },
      x: { result: "success" },
    });
    expect(bad.ok).toBe(false);
    expect(bad.markdown).toContain("Failed: lint, verify.");
  });
});

describe("assemble", () => {
  const m = parseManifest(
    JSON.stringify({
      schema: 1,
      version: "0.1.0",
      tag: "v0.1.0",
      commit: "a".repeat(40),
      registry: "ghcr.io/x/commonair",
      images: Object.fromEntries(RELEASE_IMAGES.map((n) => [n, { digest: `sha256:${"0".repeat(64)}` }])),
      platforms: ["linux/amd64", "linux/arm64"],
    }),
  );

  test("every image gets an SBOM per platform and a predicate; every relay binary its SBOM and bundles", () => {
    const unsigned = expectedAssets(m, false);
    expect(unsigned.images).toHaveLength(RELEASE_IMAGES.length * 3);
    expect(unsigned.relay).toHaveLength(RELAY_TARGETS.length * 3);
    expect(unsigned.dist).toEqual(["release-manifest.json", "commonair-selfhost_0.1.0.tar.gz"]);
    const signed = expectedAssets(m, true);
    expect(signed.relay).toHaveLength(RELAY_TARGETS.length * 5);
    expect(signed.relay).toContain("commonair-relay_0.1.0_windows_arm64.exe.sigstore.json");
    expect(signed.relay).toContain("commonair-relay_0.1.0_linux_amd64.intoto.sigstore.json");
  });

  test("a complete directory passes; missing and stray files are named", () => {
    const e = expectedAssets(m, false);
    const all = [...e.images, ...e.relay, ...e.dist, "SHA256SUMS"];
    expect(checkAssets(e, all)).toEqual([]);
    expect(checkAssets(e, [...all.filter((n) => n !== "release-manifest.json"), "notes.md"])).toEqual([
      "missing: release-manifest.json",
      "unexpected: notes.md",
    ]);
  });
});
