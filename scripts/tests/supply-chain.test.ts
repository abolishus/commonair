// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  type Policy,
  checkAudit,
  checkBunfig,
  checkGoVulns,
  checkImages,
  checkManifest,
  checkTrusted,
  checkWorkflow,
  imageBearing,
  imageRefs,
  parseJsonStream,
  specProblem,
} from "../supply-chain.ts";
import { parseRef } from "../pin-images.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const SHA = "11d5960a326750d5838078e36cf38b85af677262";
const policy = (p: Partial<Policy> = {}): Policy => ({ advisoryExceptions: [], trustedDependencies: {}, ...p });

describe("specProblem", () => {
  test.each([
    "1.2.3",
    "0.0.0",
    "4.6.7-beta.1",
    "1.0.0+build.5",
    "workspace:*",
    "workspace:^",
    "catalog:",
    "catalog:react",
    "npm:@voidzero-dev/vite-plus-core@1.3.0",
  ])("accepts %s", (spec) => expect(specProblem(spec)).toBeNull());

  test.each([
    "^1.2.3",
    "~1.2.3",
    ">=1.0.0",
    "1.x",
    "1.2",
    "*",
    "latest",
    "next",
    "",
    "1.2.3 || 2.0.0",
    "npm:foo",
    "npm:foo@^1.0.0",
  ])("refuses range or tag %s", (spec) => expect(specProblem(spec)).not.toBeNull());

  test.each([
    "git+https://github.com/a/b.git",
    "github:a/b",
    "https://example.org/x.tgz",
    "file:../x",
    "link:../x",
    "./x.tgz",
  ])("refuses non-registry source %s", (spec) => expect(specProblem(spec)).toMatch(/bypass the registry/));
});

describe("checkManifest", () => {
  test("checks dependency fields, catalog, named catalogs and overrides; skips peers", () => {
    const findings = checkManifest("package.json", {
      dependencies: { a: "1.0.0", b: "^1.0.0" },
      devDependencies: { c: "latest" },
      optionalDependencies: { d: "~2.0.0" },
      peerDependencies: { react: "^19.0.0" },
      catalog: { e: "1.0.0", f: ">=1" },
      catalogs: { ui: { g: "1.x" } },
      overrides: { h: "2.0.0", i: "^3.0.0" },
    });
    expect(findings.map((f) => f.what)).toEqual(["b@^1.0.0", "c@latest", "d@~2.0.0", "f@>=1", "i@^3.0.0", "g@1.x"]);
    expect(findings.find((f) => f.what === "g@1.x")?.where).toBe("package.json catalogs.ui");
  });

  test("an empty manifest is fine", () => expect(checkManifest("p.json", {})).toEqual([]));
  test("a non-string spec is refused", () =>
    expect(checkManifest("p.json", { dependencies: { a: 1 } })[0]?.reason).toMatch(/not a string/));
});

describe("checkTrusted", () => {
  test("trustedDependencies must be set, or bun trusts its built-in list", () =>
    expect(checkTrusted("package.json", {}, policy())).toHaveLength(1));
  test("an empty list passes", () =>
    expect(checkTrusted("package.json", { trustedDependencies: [] }, policy())).toEqual([]));
  test("each trusted package needs a reason in the policy", () => {
    const pkg = { trustedDependencies: ["sharp", "esbuild"] };
    const findings = checkTrusted("package.json", pkg, policy({ trustedDependencies: { sharp: "native build" } }));
    expect(findings.map((f) => f.what)).toEqual(["trustedDependencies: esbuild"]);
  });
});

describe("checkBunfig", () => {
  const good = "[install]\nexact = true\nminimumReleaseAge = 604800\n";
  test("passes with exact pins and a 7-day cooldown", () => expect(checkBunfig("bunfig.toml", good)).toEqual([]));
  test("a longer cooldown is fine", () =>
    expect(checkBunfig("bunfig.toml", good.replace("604800", "1209600"))).toEqual([]));
  test("missing file", () => expect(checkBunfig("bunfig.toml", null)[0]?.reason).toBe("missing"));
  test("a short cooldown fails", () =>
    expect(checkBunfig("bunfig.toml", good.replace("604800", "604799"))[0]?.what).toMatch(/minimumReleaseAge/));
  test("no cooldown and no exact fail separately", () =>
    expect(checkBunfig("bunfig.toml", "[install]\n").map((f) => f.what)).toEqual([
      "[install] exact",
      "[install] minimumReleaseAge",
    ]));
  test("a string age is not a number of seconds", () =>
    expect(checkBunfig("bunfig.toml", '[install]\nexact = true\nminimumReleaseAge = "7d"\n')).toHaveLength(1));
  test("unparseable TOML fails", () => expect(checkBunfig("bunfig.toml", "[install\n")[0]?.reason).toMatch(/parse/));
});

describe("checkWorkflow", () => {
  test("only full commit SHAs pass; local and docker actions are exempt", () => {
    const text = [
      "steps:",
      `  - uses: actions/checkout@${SHA} # v4.4.0`,
      "  - uses: actions/setup-go@v5",
      `  - uses: "oven-sh/setup-bun@${SHA.slice(0, 12)}"`,
      "  - uses: ./.github/actions/local",
      "  - uses: docker://alpine:3",
      "    uses: actions/deploy-pages@main",
    ].join("\n");
    expect(checkWorkflow("ci.yml", text).map((f) => f.what)).toEqual([
      "actions/setup-go@v5",
      `oven-sh/setup-bun@${SHA.slice(0, 12)}`,
      "actions/deploy-pages@main",
    ]);
  });
});

describe("images", () => {
  test("finds third-party refs, skipping comments and our own images", () => {
    const text = [
      "# docker.io/library/caddy:2 in a comment",
      "    image: ghcr.io/valkey-io/valkey:9.1.2-trixie",
      `FROM gcr.io/distroless/static-debian13:nonroot@${DIGEST} AS run`,
      "ARG PROBE_IMAGE=docker.io/library/alpine:3.24.2",
      '  source: image("ghcr.io/abolishus/commonair-relay:1.0.0"),',
      "    image: ${IMAGE_REGISTRY:-localhost/commonair}/api:${IMAGE_TAG:-dev}",
      '// export const X = "quay.io/a/b:1";',
      '  containerRegistry: "ghcr.io/abolishus",',
    ].join("\n");
    expect(imageRefs(text)).toEqual([
      { ref: "ghcr.io/valkey-io/valkey:9.1.2-trixie", line: 2 },
      { ref: `gcr.io/distroless/static-debian13:nonroot@${DIGEST}`, line: 3 },
      { ref: "docker.io/library/alpine:3.24.2", line: 4 },
    ]);
  });

  test("requires both a tag and a digest", () => {
    const text = [
      `image: docker.io/a/b:1.0@${DIGEST}`,
      "image: docker.io/a/c:1.0",
      `image: docker.io/a/d@${DIGEST}`,
      "image: docker.io/a/e",
    ].join("\n");
    expect(checkImages("compose.yaml", text).map((f) => f.what)).toEqual([
      "docker.io/a/c:1.0",
      `docker.io/a/d@${DIGEST}`,
      "docker.io/a/e",
    ]);
    expect(checkImages("compose.yaml", text)[0]?.where).toBe("compose.yaml:2");
  });

  test("imageBearing picks pullable config and skips docs, briefs and fixtures", () =>
    expect(
      imageBearing([
        "compose.yaml",
        "relay/Containerfile",
        "infra/containers/probe.Containerfile",
        "infra/quadlet/x.container",
        ".railway/railway.ts",
        ".github/workflows/ci.yml",
        "docs/x.yaml",
        ".claude/briefs/a.ts",
        "scripts/tests/supply-chain.test.ts",
        "README.md",
        "infra/image-licenses.json",
      ]),
    ).toEqual([
      "compose.yaml",
      "relay/Containerfile",
      "infra/containers/probe.Containerfile",
      "infra/quadlet/x.container",
      ".railway/railway.ts",
      ".github/workflows/ci.yml",
    ]));

  test("parseRef splits registry, repo and tag, ignoring the digest", () => {
    expect(parseRef(`docker.io/library/caddy:2.11.7-alpine@${DIGEST}`)).toEqual({
      registry: "docker.io",
      repo: "library/caddy",
      tag: "2.11.7-alpine",
    });
    expect(parseRef("ghcr.io/a/b/c:1")).toEqual({ registry: "ghcr.io", repo: "a/b/c", tag: "1" });
    expect(() => parseRef(`docker.io/a/b@${DIGEST}`)).toThrow(/no tag/);
  });
});

describe("checkAudit", () => {
  const advisory = {
    id: 1,
    url: "https://github.com/advisories/GHSA-67mh-4wv8-2f99",
    title: "dev server",
    severity: "moderate",
  };
  const exception = { id: "GHSA-67mh-4wv8-2f99", package: "esbuild", reason: "dev only", expires: "2027-01-22" };

  test("a clean report passes", () => expect(checkAudit({}, policy(), "2026-10-22")).toEqual([]));

  test("an advisory without an exception fails", () => {
    const [f] = checkAudit({ esbuild: [advisory] }, policy(), "2026-10-22");
    expect(f?.what).toBe("esbuild GHSA-67mh-4wv8-2f99 (moderate)");
  });

  test("a live exception covers it, through its expiry date", () => {
    const p = policy({ advisoryExceptions: [exception] });
    expect(checkAudit({ esbuild: [advisory] }, p, "2026-10-22")).toEqual([]);
    expect(checkAudit({ esbuild: [advisory] }, p, "2027-01-22")).toEqual([]);
  });

  test("an expired exception fails", () =>
    expect(
      checkAudit({ esbuild: [advisory] }, policy({ advisoryExceptions: [exception] }), "2027-01-23")[0]?.reason,
    ).toMatch(/expired on 2027-01-22/));

  test("an exception is per package", () =>
    expect(
      checkAudit({ other: [advisory] }, policy({ advisoryExceptions: [exception] }), "2026-10-22").map((f) => f.reason),
    ).toEqual([expect.stringMatching(/upgrade/), expect.stringMatching(/no longer matches/)]));

  test("a stale exception fails so the list stays honest", () =>
    expect(checkAudit({}, policy({ advisoryExceptions: [exception] }), "2026-10-22")[0]?.reason).toMatch(/remove it/));

  test("go exceptions are not considered by the npm audit", () =>
    expect(checkAudit({}, policy({ advisoryExceptions: [{ ...exception, ecosystem: "go" }] }), "2026-10-22")).toEqual(
      [],
    ));
});

describe("checkGoVulns", () => {
  const reached = {
    osv: "GO-2026-6809",
    fixed_version: "v1.27.3",
    trace: [{ module: "stdlib", version: "v1.27.2", package: "crypto/x509", function: "Verify" }, { module: "x" }],
  };
  const moduleOnly = { osv: "GO-2026-6809", trace: [{ module: "stdlib", version: "v1.27.2" }] };
  const packageOnly = { osv: "GO-2026-0001", trace: [{ module: "stdlib", version: "v1.27.2", package: "net/http" }] };
  const exception = {
    ecosystem: "go" as const,
    id: "GO-2026-6809",
    package: "stdlib",
    reason: "r",
    expires: "2026-10-27",
  };

  test("only reached functions count, once per advisory", () => {
    const findings = checkGoVulns([moduleOnly, packageOnly, reached, reached], policy(), "2026-10-22");
    expect(findings.map((f) => f.what)).toEqual(["stdlib@v1.27.2 GO-2026-6809"]);
    expect(findings[0]?.reason).toMatch(/crypto\/x509\.Verify, fixed in v1\.27\.3/);
  });

  test("imported but never called is not a finding", () =>
    expect(checkGoVulns([moduleOnly, packageOnly], policy(), "2026-10-22")).toEqual([]));

  test("a go exception covers it until it expires", () => {
    const p = policy({ advisoryExceptions: [exception] });
    expect(checkGoVulns([reached], p, "2026-10-27")).toEqual([]);
    expect(checkGoVulns([reached], p, "2026-10-28")[0]?.reason).toMatch(/expired/);
    expect(checkGoVulns([], p, "2026-10-22")[0]?.reason).toMatch(/remove it/);
  });

  test("npm exceptions do not cover go findings", () =>
    expect(
      checkGoVulns([reached], policy({ advisoryExceptions: [{ ...exception, ecosystem: "npm" }] }), "2026-10-22"),
    ).toHaveLength(1));
});

describe("parseJsonStream", () => {
  test("splits pretty-printed objects, ignoring braces inside strings", () => {
    const text = '{\n  "a": {"b": 1}\n}\n{\n  "s": "has } and { and \\" quote"\n}\n';
    expect(parseJsonStream(text)).toEqual([{ a: { b: 1 } }, { s: 'has } and { and " quote' }]);
  });
  test("empty input", () => expect(parseJsonStream("")).toEqual([]));
});
