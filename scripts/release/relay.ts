// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Relay release binaries (ADR 0023 §4–5): one static, reproducible build per RELAY_TARGETS
 * entry, each with a CycloneDX SBOM, SLSA provenance and (when signing) Sigstore bundles.
 *
 *   bun scripts/release/relay.ts build  --version <v> --out <dir>
 *   bun scripts/release/relay.ts attest --version <v> --commit <sha> --out <dir> [--sign true|false]
 *
 * `build` needs only Go. `attest` needs syft, and cosign with a GitHub OIDC token for --sign.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { predicateAsset, provenanceAsset, sbomAsset, signatureAsset } from "./assets.ts";
import { RELAY_TARGETS, relayAssetName } from "./manifest.ts";
import { contextFromEnv, slsaPredicate } from "./provenance.ts";

export type RelayTarget = (typeof RELAY_TARGETS)[number];
export const RELAY_PACKAGE = "./cmd/commonair-relay";

/** The same flags as relay/Makefile and relay/Containerfile: same source + toolchain = same bytes. */
export function relayBuild(version: string, target: RelayTarget, outDir: string) {
  const [os, arch] = target.split("/") as [string, string];
  const out = join(outDir, relayAssetName(version, target));
  return {
    out,
    env: { CGO_ENABLED: "0", GOOS: os, GOARCH: arch },
    argv: [
      "go",
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags",
      `-s -w -buildid= -X main.version=${version}`,
      "-o",
      out,
      RELAY_PACKAGE,
    ],
  };
}

export function sbomArgv(binary: string, out: string): string[] {
  return ["syft", "scan", `file:${binary}`, "--output", `cyclonedx-json=${out}`];
}

export function signBlobArgv(file: string, bundle: string): string[] {
  return ["cosign", "sign-blob", "--yes", "--bundle", bundle, file];
}

export function attestBlobArgv(file: string, predicate: string, bundle: string): string[] {
  return [
    "cosign",
    "attest-blob",
    "--yes",
    "--type",
    "slsaprovenance1",
    "--predicate",
    predicate,
    "--bundle",
    bundle,
    file,
  ];
}

function run(argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): void {
  console.log(
    `$ ${
      opts.env
        ? `${Object.entries(opts.env)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")} `
        : ""
    }${argv.join(" ")}`,
  );
  const r = Bun.spawnSync(argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0) throw new Error(`${argv.slice(0, 2).join(" ")} failed (exit ${r.exitCode})`);
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const version = opt("version");
  const outArg = opt("out");
  if (!version || !outArg || (cmd !== "build" && cmd !== "attest")) {
    console.error("usage: relay.ts build|attest --version <v> --out <dir> [--commit <sha>] [--sign true|false]");
    process.exit(2);
  }
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });
  if (cmd === "build") {
    for (const t of RELAY_TARGETS) {
      const b = relayBuild(version, t, out);
      run(b.argv, { cwd: "relay", env: b.env });
    }
  } else {
    const commit = opt("commit");
    if (!commit) {
      console.error("attest needs --commit");
      process.exit(2);
    }
    const ctx = contextFromEnv(process.env);
    for (const t of RELAY_TARGETS) {
      const name = relayAssetName(version, t);
      const bin = join(out, name);
      run(sbomArgv(bin, join(out, sbomAsset(name))));
      const predicate = join(out, predicateAsset(name));
      writeFileSync(predicate, `${JSON.stringify(slsaPredicate(ctx, { artifact: name, version, commit }), null, 2)}\n`);
      if (opt("sign") === "true") {
        run(signBlobArgv(bin, join(out, signatureAsset(name))));
        run(attestBlobArgv(bin, predicate, join(out, provenanceAsset(name))));
      }
    }
  }
}
