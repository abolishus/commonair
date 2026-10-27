// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** selfhost.sh under `sh` (fixtures: support/selfhost-host.ts). Downloading and verifying a release, signature stripping and the release repository. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { SITE } from "../../packages/config/src/site.ts";
import { bundleAssetName } from "../release/manifest.ts";
import {
  type Host,
  SCRIPT,
  TIMEOUT,
  releaseDir,
  host,
  INSTALL,
  expectOk,
  useReleases,
} from "./support/selfhost-host.ts";

useReleases();

describe("download and verification", () => {
  test(
    "downloads only over HTTPS from the repository's release URL",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const urls = h.calls().filter((c) => c.startsWith("curl"));
      const base = `${SITE.repository.url}/releases/download/v0.1.0`;
      expect(urls.map((c) => c.split(" ").at(-1))).toEqual([
        `${base}/SHA256SUMS`,
        `${base}/${bundleAssetName("0.1.0")}`,
      ]);
      for (const c of urls) expect(c).toContain("--proto =https");
    },
    TIMEOUT,
  );

  test("the script names the repository URL once, and it is SITE.repository.url", () => {
    const sh = readFileSync(SCRIPT, "utf8");
    expect(sh.match(/https:\/\/github\.com\/[^\s"'/}]+\/[^\s"'/}]+/g)).toEqual([SITE.repository.url]);
    expect(sh).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
  });

  test(
    "a checksum mismatch aborts before anything is extracted",
    () => {
      const h = host();
      const bad = join(h.dir, "bad");
      mkdirSync(bad);
      const name = bundleAssetName("0.1.0");
      writeFileSync(join(bad, name), readFileSync(join(releaseDir, name)));
      writeFileSync(join(bad, "SHA256SUMS"), `${"0".repeat(64)}  ${name}\n`);
      const r = h.run([...INSTALL.filter((_, i) => i < 1 || i > 2), "--bundle", join(bad, name)]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`checksum mismatch for ${name}`);
      expect(existsSync(join(h.home, ".local/share/commonair/releases"))).toBe(false);
      expect(h.calls().filter((c) => c.startsWith("podman pull"))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a local bundle with no SHA256SUMS is refused unless --insecure-no-checksum",
    () => {
      const h = host();
      const lone = join(h.dir, "lone");
      mkdirSync(lone);
      const name = bundleAssetName("0.1.0");
      writeFileSync(join(lone, name), readFileSync(join(releaseDir, name)));
      const args = [
        "install",
        "--bundle",
        join(lone, name),
        "--domain",
        "stream.example.org",
        "--email",
        "ops@example.org",
      ];
      const r = h.run(args);
      expect(r.code).toBe(1);
      expect(r.err).toContain("refusing an unverified bundle");
      expect(r.err).toContain("--insecure-no-checksum");
      expect(existsSync(join(h.home, ".local/share/commonair/releases"))).toBe(false);
      expect(h.calls().filter((c) => c.startsWith("podman pull"))).toEqual([]);

      const ok = h.run([...args, "--insecure-no-checksum"]);
      expect(ok.code, ok.err).toBe(0);
      expect(ok.err).toContain("is NOT verified");
      // Never for a download.
      expect(host().run([...INSTALL, "--insecure-no-checksum"]).err).toContain("only applies to a local --bundle");
    },
    TIMEOUT,
  );

  test("a bundle without an entry in SHA256SUMS is refused", () => {
    const h = host({});
    const r = h.run(INSTALL, {
      STUB_RELEASES: (() => {
        const d = join(h.dir, "rel");
        mkdirSync(d);
        writeFileSync(join(d, "SHA256SUMS"), `${"1".repeat(64)}  something-else\n`);
        writeFileSync(join(d, bundleAssetName("0.1.0")), readFileSync(join(releaseDir, bundleAssetName("0.1.0"))));
        return d;
      })(),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("SHA256SUMS has no entry");
  });

  test("--require-signature without cosign aborts before downloading", () => {
    const h = host();
    const r = h.run([...INSTALL, "--require-signature"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--require-signature: cosign is not installed");
    expect(h.calls().filter((c) => c.startsWith("curl"))).toEqual([]);
  });

  test("--require-signature with a local bundle and no cosign aborts too", () => {
    const h = host();
    const r = h.run([
      "install",
      "--bundle",
      join(releaseDir, bundleAssetName("0.1.0")),
      "--domain",
      "stream.example.org",
      "--email",
      "ops@example.org",
      "--require-signature",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cosign is not installed");
    expect(existsSync(join(h.home, ".local/share/commonair/releases"))).toBe(false);
  });

  test(
    "with cosign it verifies SHA256SUMS against the release workflow identity",
    () => {
      const h = host({ cosign: true });
      writeFileSync(join(releaseDir, "SHA256SUMS.sigstore.json"), "{}");
      try {
        expectOk(h.run([...INSTALL, "--require-signature"]));
        const verify = h.calls().find((c) => c.startsWith("cosign verify-blob"))!;
        const re = `^${SITE.repository.url.replaceAll(".", "\\.")}/\\.github/workflows/release\\.yml@refs/tags/v`;
        expect(verify).toContain(`--certificate-identity-regexp ${re}`);
        expect(verify).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
        expect(verify).toMatch(/SHA256SUMS$/);
        // A signature that does not verify stops the install.
        const h2 = host({ cosign: true });
        const r = h2.run(INSTALL, { STUB_COSIGN_EXIT: "1" });
        expect(r.code).toBe(1);
        expect(r.err).toContain("does not verify");
      } finally {
        Bun.spawnSync(["rm", join(releaseDir, "SHA256SUMS.sigstore.json")]);
      }
    },
    TIMEOUT,
  );
});

describe("signature stripping", () => {
  // Whoever can replace SHA256SUMS can also delete its signature: with cosign installed, a
  // signature that is missing or cannot be downloaded stops the install before extraction.
  const extracted = (h: Host) => existsSync(join(h.home, ".local/share/commonair/releases"));

  test("--version: a release without SHA256SUMS.sigstore.json is refused", () => {
    const h = host({ cosign: true });
    const r = h.run(INSTALL);
    expect(r.code).toBe(1);
    expect(r.err).toContain("SHA256SUMS.sigstore.json");
    expect(r.err).toContain("could not download");
    expect(extracted(h)).toBe(false);
    // Stopped before the bundle itself was fetched.
    expect(h.calls().some((c) => c.startsWith("curl") && c.endsWith(bundleAssetName("0.1.0")))).toBe(false);
    expect(h.calls().some((c) => c.startsWith("cosign"))).toBe(false);
  });

  test("--version: a signature download that fails is refused even when the asset exists", () => {
    const h = host({ cosign: true });
    writeFileSync(join(releaseDir, "SHA256SUMS.sigstore.json"), "{}");
    try {
      const r = h.run(INSTALL, { STUB_CURL_FAIL: "SHA256SUMS.sigstore.json" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("could not download SHA256SUMS.sigstore.json");
      expect(extracted(h)).toBe(false);
    } finally {
      Bun.spawnSync(["rm", join(releaseDir, "SHA256SUMS.sigstore.json")]);
    }
  });

  test("--bundle: SHA256SUMS without its signature next to it is refused", () => {
    const h = host({ cosign: true });
    const r = h.run([
      "install",
      "--bundle",
      join(releaseDir, bundleAssetName("0.1.0")),
      "--domain",
      "stream.example.org",
      "--email",
      "ops@example.org",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("SHA256SUMS.sigstore.json is missing");
    expect(extracted(h)).toBe(false);
    expect(h.calls().filter((c) => c.startsWith("podman pull"))).toEqual([]);
  });

  test(
    "without cosign the checksum-only path continues, with a loud warning",
    () => {
      const h = host();
      const r = h.run(INSTALL);
      expect(r.code, r.err).toBe(0);
      expect(r.err).toContain("its SIGNATURE IS NOT");
    },
    TIMEOUT,
  );
});

describe("release repository", () => {
  test(
    "a fork's repository recorded in the installed release is used by a later upgrade",
    () => {
      const h = host();
      expectOk(h.run(INSTALL));
      const fork = "https://codeberg.example/fork/commonair";
      const relEnv = join(h.home, "commonair/release.env");
      writeFileSync(
        relEnv,
        readFileSync(relEnv, "utf8").replace(/^COMMONAIR_REPOSITORY_URL=.*$/m, `COMMONAIR_REPOSITORY_URL=${fork}`),
      );
      Bun.spawnSync(["sh", "-c", `: > "${h.log}"`]);
      expectOk(h.run(["upgrade", "--version", "v0.2.0"]));
      const urls = h
        .calls()
        .filter((c) => c.startsWith("curl"))
        .map((c) => c.split(" ").at(-1));
      expect(urls).toEqual([
        `${fork}/releases/download/v0.2.0/SHA256SUMS`,
        `${fork}/releases/download/v0.2.0/${bundleAssetName("0.2.0")}`,
      ]);
    },
    TIMEOUT,
  );

  test(
    "COMMONAIR_REPOSITORY_URL in the environment wins, and must be https",
    () => {
      const h = host();
      const r = h.run(INSTALL, { COMMONAIR_REPOSITORY_URL: "https://git.example.net/me/commonair" });
      expect(r.code, r.err).toBe(0);
      expect(h.calls().find((c) => c.startsWith("curl"))).toContain(
        "https://git.example.net/me/commonair/releases/download/v0.1.0/SHA256SUMS",
      );
      const bad = host().run(INSTALL, { COMMONAIR_REPOSITORY_URL: "http://git.example.net/me/commonair" });
      expect(bad.code).toBe(1);
      expect(bad.err).toContain("must be an https:// URL");
    },
    TIMEOUT,
  );
});
