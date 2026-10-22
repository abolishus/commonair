// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Resolves every third-party image tag to its current registry digest (ADR 0022).
 *
 *   bun scripts/pin-images.ts           report refs whose digest is missing or no longer the tag's
 *   bun scripts/pin-images.ts --write   rewrite them as name:tag@sha256:<digest>
 *
 * The digest is the multi-arch index when the registry serves one, so the pin holds on amd64
 * and arm64. Bumping a tag is a normal edit (change the tag, then --write); review the license
 * entry in infra/image-licenses.json at the same time.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { imageBearing, imageRefs, isCommentLine } from "./supply-chain.ts";

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export function parseRef(ref: string): { registry: string; repo: string; tag: string } {
  const bare = ref.replace(/@sha256:[0-9a-f]{64}$/, "");
  const slash = bare.indexOf("/");
  const colon = bare.lastIndexOf(":");
  if (colon < slash) throw new Error(`${ref}: no tag (pin a tag as well as the digest)`);
  return { registry: bare.slice(0, slash), repo: bare.slice(slash + 1, colon), tag: bare.slice(colon + 1) };
}

async function resolveDigest(ref: string): Promise<string> {
  const { registry, repo, tag } = parseRef(ref);
  const host = registry === "docker.io" ? "registry-1.docker.io" : registry;
  const url = `https://${host}/v2/${repo}/manifests/${tag}`;
  let res = await fetch(url, { method: "HEAD", headers: { accept: MANIFEST_TYPES } });
  if (res.status === 401) {
    // Anonymous bearer token for a public pull, per the distribution spec's token flow.
    const challenge = res.headers.get("www-authenticate") ?? "";
    const realm = challenge.match(/realm="([^"]+)"/)?.[1];
    const service = challenge.match(/service="([^"]+)"/)?.[1];
    if (!realm) throw new Error(`${ref}: registry gave no token realm`);
    const tokenUrl = new URL(realm);
    if (service) tokenUrl.searchParams.set("service", service);
    tokenUrl.searchParams.set("scope", `repository:${repo}:pull`);
    const body = (await (await fetch(tokenUrl)).json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    res = await fetch(url, { method: "HEAD", headers: { accept: MANIFEST_TYPES, authorization: `Bearer ${token}` } });
  }
  const digest = res.headers.get("docker-content-digest");
  if (!res.ok || !digest?.startsWith("sha256:")) throw new Error(`${ref}: HTTP ${res.status}, no digest`);
  return digest;
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"]).stdout.toString().split("\0").filter(Boolean);
  const files = imageBearing(tracked).filter((p) => existsSync(p));
  const refs = new Map<string, string[]>();
  for (const p of files)
    for (const { ref } of imageRefs(readFileSync(p, "utf8"))) refs.set(ref, [...(refs.get(ref) ?? []), p]);

  const tags = new Map<string, string>(); // name:tag -> digest
  for (const ref of refs.keys()) {
    const tagged = ref.replace(/@sha256:[0-9a-f]{64}$/, "");
    if (!tags.has(tagged)) tags.set(tagged, await resolveDigest(tagged));
  }

  let drift = 0;
  const rewrites = new Map<string, string>();
  for (const [ref, paths] of refs) {
    const tagged = ref.replace(/@sha256:[0-9a-f]{64}$/, "");
    const pinned = `${tagged}@${tags.get(tagged)}`;
    if (ref === pinned) continue;
    drift++;
    rewrites.set(ref, pinned);
    console.log(
      `${ref.includes("@") ? "moved " : "unpinned"} ${ref}\n  -> ${pinned}\n  in ${[...new Set(paths)].join(", ")}`,
    );
  }
  if (write)
    for (const p of files) {
      const before = readFileSync(p, "utf8");
      // Longest first, so an already-pinned ref is not rewritten through its tag prefix.
      const ordered = [...rewrites].sort((a, b) => b[0].length - a[0].length);
      const after = before
        .split("\n")
        .map((line) =>
          isCommentLine(line)
            ? line
            : ordered.reduce(
                (l, [from, to]) => l.replace(new RegExp(`${RegExp.escape(from)}(?!@sha256:|[\\w.-])`, "g"), to),
                line,
              ),
        )
        .join("\n");
      if (after !== before) writeFileSync(p, after);
    }
  console.log(`pin-images: ${tags.size} tags, ${drift} ${write ? "rewritten" : "to pin (use --write)"}`);
  if (drift > 0 && !write) process.exit(1);
}
