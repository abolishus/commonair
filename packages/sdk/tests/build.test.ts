// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  type BuildResult,
  buildSdk,
  contractTarget,
  distPackageJson,
  exactVersion,
  rewriteContractImports,
} from "../scripts/build.ts";
import { INLINED_CONTRACT_FILES } from "./inlined.ts";

const PKG_DIR = path.resolve(import.meta.dirname, "..");
// Inside the package (git-ignored `.cache/`), so the built bundle resolves zod and @orpc/* like a consumer would.
const OUT = path.join(PKG_DIR, ".cache", `build-test-${process.pid}`);
let result: BuildResult;

beforeAll(async () => {
  result = await buildSdk({ outDir: OUT, quiet: true });
}, 120_000);
afterAll(async () => {
  await rm(OUT, { recursive: true, force: true });
});

const read = (f: string) => readFile(path.join(OUT, f), "utf8");

describe("the published bundle", () => {
  test("index.js imports nothing from @commonair/* and only the declared externals", async () => {
    const js = await read("index.js");
    expect(js).not.toMatch(/["']@commonair\//);
    const imports = [...js.matchAll(/^import\s.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    for (const spec of imports) expect(spec).toMatch(/^(@orpc\/(client|contract)(\/|$)|zod$)/);
  });

  test("index.d.ts references no @commonair/* and carries the contract types", async () => {
    const dts = await read("index.d.ts");
    expect(dts).not.toMatch(/["']@commonair\//);
    expect(dts).toMatch(/declare function createClient/);
    expect(dts).toMatch(/connectToken/);
  });

  test("dist/package.json: Apache-2.0, exact versions, no private, no protocols", async () => {
    const text = await read("package.json");
    expect(text).not.toMatch(/catalog:|workspace:/);
    const pkg = JSON.parse(text) as Record<string, unknown>;
    expect(pkg.private).toBeUndefined();
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.name).toBe("@commonair/sdk");
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
    const deps = pkg.dependencies as Record<string, string>;
    expect(Object.keys(deps).sort()).toEqual(["@orpc/client", "@orpc/contract", "zod"]);
    for (const v of Object.values(deps)) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.files).toEqual(["index.js", "index.d.ts", "README.md", "LICENSE"]);
  });

  test("LICENSE is the Apache-2.0 text and the README ships", async () => {
    expect(existsSync(path.join(OUT, "LICENSE"))).toBe(true);
    expect(await read("LICENSE")).toMatch(/Apache License\s+Version 2\.0/);
    // The tag is built from parts so REUSE does not read it as this file's own.
    expect(await read("README.md")).toContain(`${["SPDX", "License", "Identifier"].join("-")}: Apache-2.0`);
  });

  test("the inlined contract files are exactly the known (dual-licensed) list", () => {
    expect(result.inlinedCode).toContain("packages/contracts/src/oauth.ts");
    expect(result.inlinedTypes).toContain("packages/contracts/src/api/router.ts");
    const all = [...new Set([...result.inlinedCode, ...result.inlinedTypes])].sort();
    expect(all).toEqual([...INLINED_CONTRACT_FILES]);
  });

  test("the built module runs", async () => {
    const mod = (await import(path.join(OUT, "index.js"))) as typeof import("../src/index.ts");
    const pair = await mod.createPkcePair();
    expect(pair.challenge).toBe(await mod.pkceChallenge(pair.verifier));
    expect(mod.EVENTSUB_WS_CLOSE.authorizationRevoked).toBe(4008);
  });

  test("a consumer type-checks against index.d.ts alone", async () => {
    const dir = path.join(OUT, "consumer");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "main.ts"),
      `import { createClient, connectEventSub, verifyEventSubRequest, type CommonAirClient } from "../index.js";
const client: CommonAirClient = createClient({ baseUrl: "https://example.test" });
export async function main() {
  const me = await client.chat.connectToken();
  const url: string = me.url;
  const session = await connectEventSub({ baseUrl: "https://example.test" });
  const sub = await client.developer.events.subscribe({ type: "channel.follow", version: "1", condition: {}, transport: { method: "websocket", sessionId: session.sessionId } });
  const v = await verifyEventSubRequest({ secret: "s".repeat(10), headers: {}, rawBody: "" });
  return [url, sub.id, v.ok];
}
`,
    );
    await writeFile(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2022",
          module: "nodenext",
          moduleResolution: "nodenext",
          lib: ["es2024", "dom"],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ["main.ts", "../index.d.ts"],
      }),
    );
    await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
    const proc = Bun.spawn([path.join(PKG_DIR, "node_modules/.bin/tsc"), "-p", dir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(out).toBe("");
    expect(code).toBe(0);
  }, 60_000);
});

describe("build helpers", () => {
  const catalog = { zod: "4.6.7", "@orpc/client": "1.15.7", range: "^1.0.0" };

  test("exactVersion resolves catalog: and refuses ranges and unknowns", () => {
    expect(exactVersion("zod", "catalog:", catalog)).toBe("4.6.7");
    expect(exactVersion("x", "2.0.0", catalog)).toBe("2.0.0");
    expect(() => exactVersion("range", "catalog:", catalog)).toThrow(/exact/);
    expect(() => exactVersion("missing", "catalog:", catalog)).toThrow(/catalog/);
    expect(() => exactVersion("x", "workspace:*", catalog)).toThrow(/exact/);
  });

  test("distPackageJson drops @commonair/* and private", () => {
    const out = distPackageJson(
      {
        name: "@commonair/sdk",
        version: "1.2.3",
        license: "Apache-2.0",
        type: "module",
        dependencies: { "@commonair/contracts": "workspace:*", zod: "catalog:" },
      },
      catalog,
    );
    expect(out.dependencies).toEqual({ zod: "4.6.7" });
    expect(out.version).toBe("1.2.3");
    expect(out).not.toHaveProperty("private");
    expect((out.repository as { url: string }).url).toMatch(/^git\+https:\/\/.+\.git$/);
  });

  test("contract imports are rewritten through the contracts exports map", () => {
    const exportsMap = { ".": "./src/index.ts", "./oauth": "./src/oauth.ts", "./api": "./src/api/router.ts" };
    expect(contractTarget("@commonair/contracts/api", exportsMap)).toBe("api/router.ts");
    expect(() => contractTarget("@commonair/contracts/nope", exportsMap)).toThrow(/not exported/);
    const code =
      'import { a } from "@commonair/contracts/oauth";\nimport type { C } from "@commonair/contracts/api";\n';
    expect(rewriteContractImports(code, "/s/src", "/s/contracts", exportsMap)).toBe(
      'import { a } from "../contracts/oauth.ts";\nimport type { C } from "../contracts/api/router.ts";\n',
    );
  });
});
