// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { checkTofu } from "../check-licenses.ts";

const lock = (address: string, version: string) => `# This file is maintained automatically by "tofu init".
provider "${address}" {
  version     = "${version}"
  constraints = "${version}"
  hashes = [
    "h1:AAAA",
  ]
}
`;

function fixture(registry: Record<string, { license: string; source: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "tofu-licenses-"));
  mkdirSync(join(dir, "envs/a/.terraform/providers"), { recursive: true });
  mkdirSync(join(dir, "modules/m"), { recursive: true });
  writeFileSync(join(dir, "envs/a/.terraform.lock.hcl"), lock("registry.opentofu.org/acme/cloud", "1.2.3"));
  writeFileSync(join(dir, "modules/m/.terraform.lock.hcl"), lock("registry.opentofu.org/acme/cloud", "1.2.3"));
  // Downloaded providers are not ours to check.
  writeFileSync(
    join(dir, "envs/a/.terraform/providers/.terraform.lock.hcl"),
    lock("registry.opentofu.org/x/y", "9.9.9"),
  );
  const registryPath = join(dir, "provider-licenses.json");
  writeFileSync(registryPath, JSON.stringify(registry));
  return { dir, registryPath };
}

describe("checkTofu", () => {
  test("a listed provider with an allowed license passes, counted once", () => {
    const { dir, registryPath } = fixture({ "registry.opentofu.org/acme/cloud": { license: "MPL-2.0", source: "x" } });
    expect(checkTofu(dir, registryPath)).toEqual({ checked: 1, findings: [] });
  });

  test("an unlisted provider fails in every lock file that pins it", () => {
    const { dir, registryPath } = fixture({});
    const { findings } = checkTofu(dir, registryPath);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      name: "registry.opentofu.org/acme/cloud",
      version: "1.2.3",
      license: "UNKNOWN",
    });
  });

  test("a listed provider with a disallowed license fails", () => {
    const { dir, registryPath } = fixture({ "registry.opentofu.org/acme/cloud": { license: "BUSL-1.1", source: "x" } });
    expect(checkTofu(dir, registryPath).findings.map((f) => f.license)).toEqual(["BUSL-1.1", "BUSL-1.1"]);
  });

  test("no infra/tofu directory checks nothing", () => {
    expect(checkTofu(join(tmpdir(), "does-not-exist-tofu"), "nope.json")).toEqual({ checked: 0, findings: [] });
  });
});
