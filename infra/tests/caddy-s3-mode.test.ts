// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Caddy's S3 route follows S3_MODE (R0-b): with Garage on the host the presigned shapes go to
 * Garage, with an external store there is no Garage and no route. Checked on the text here;
 * caddy-s3-mode.int.test.ts runs the pinned Caddy against it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

const caddy = readFileSync(new URL("../caddy/Caddyfile", import.meta.url), "utf8");
const siteAt = caddy.indexOf("{$PUBLIC_HOSTNAME:localhost} {");
const site = caddy.slice(siteAt);

/** The body of a top-level snippet `(name) { … }`. */
function snippet(name: string): string {
  const start = caddy.indexOf(`\n(${name}) {\n`);
  if (start === -1) return "";
  const body = caddy.slice(start + name.length + 6);
  return body.slice(0, body.search(/^\}$/m));
}

describe("the S3 route by S3_MODE", () => {
  test("garage, external and empty snippets exist and precede the site", () => {
    for (const name of ["s3-garage", "s3-external", "s3-"]) {
      const at = caddy.indexOf(`(${name}) {`);
      expect(at, name).toBeGreaterThan(0);
      expect(at, name).toBeLessThan(siteAt);
    }
    expect(caddy).toMatch(/\n\(s3-\) \{\n\timport s3-garage\n\}\n/);
  });

  test("the site imports the snippet named by S3_MODE, garage when unset, right after /internal", () => {
    expect(site).toMatch(/\thandle @internal \{\n\t\trespond 404\n\t\}\n\n\timport s3-\{\$S3_MODE:garage\}\n/);
    expect(site.match(/import s3-/g)).toHaveLength(1);
  });

  test("Garage is an upstream only inside the garage snippet, for exactly the two presigned shapes", () => {
    const garage = snippet("s3-garage");
    expect(garage.match(/reverse_proxy garage:3900/g)).toHaveLength(2);
    expect(garage).toMatch(
      /\thandle @s3-upload \{\n\t\trequest_body \{\n\t\t\tmax_size 10MB\n\t\t\}\n\t\treverse_proxy garage:3900\n\t\}/,
    );
    expect(garage).toMatch(/\thandle @s3-export \{\n\t\treverse_proxy garage:3900\n\t\}/);
    expect(garage).toMatch(
      /@s3-upload \{\n\t\tmethod PUT\n\t\tpath \/\{\$S3_BUCKET_MEDIA:commonair-media\}\/incoming\/\*\n(?:\t\t#[^\n]*\n)*\t\tnot path \/\{\$S3_BUCKET_MEDIA:commonair-media\}\/incoming\/\n\t\tquery X-Amz-Signature=\*\n\t\}/,
    );
    expect(garage).toMatch(
      /@s3-export \{\n\t\tmethod GET HEAD\n\t\tpath \/\{\$S3_BUCKET_EXPORTS:commonair-exports\}\/\*\n(?:\t\t#[^\n]*\n)*\t\tnot path \/\{\$S3_BUCKET_EXPORTS:commonair-exports\}\/\n\t\tquery X-Amz-Signature=\*\n\t\}/,
    );
    expect(caddy.replace(garage, "").match(/garage:/g)).toBeNull();
  });

  test("an external store: no route at all, so nothing proxies to a Garage that is not there", () => {
    expect(snippet("s3-external").trim()).toBe("");
  });

  test("signed object responses still pass through unencoded in the site", () => {
    expect(site).toMatch(/@compressible not query X-Amz-Signature=\*\n\tencode @compressible zstd gzip\n/);
  });
});
