// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Move `latest` to a stable release's image indexes, after the release is published, so
 * `latest` never points at a version whose release failed. Copies each index manifest
 * byte for byte (same digest) through the OCI distribution API; no extra tool.
 *
 *   REGISTRY_USER=… REGISTRY_TOKEN=… bun scripts/release/tag-latest.ts \
 *     --registry ghcr.io/<owner>/commonair --digests <dir with <image>.digest>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_IMAGES } from "./manifest.ts";
import { isInsecure } from "./publish-image.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INDEX_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];
const ACCEPT = INDEX_TYPES.join(", ");

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Credentials {
  user: string;
  token: string;
}

/** `ghcr.io/owner/commonair` + `api` → base URL and repository name. */
export function repoUrl(registry: string, image: string): { base: string; name: string } {
  const slash = registry.indexOf("/");
  if (slash < 0) throw new Error(`registry needs a namespace: ${registry}`);
  const host = registry.slice(0, slash);
  const scheme = isInsecure(registry) ? "http" : "https";
  return { base: `${scheme}://${host}/v2`, name: `${registry.slice(slash + 1)}/${image}` };
}

/** Parse `Bearer realm="…",service="…",scope="…"`. */
export function parseChallenge(header: string): Record<string, string> | null {
  if (!/^Bearer\s/i.test(header)) return null;
  const out: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) out[m[1] as string] = m[2] as string;
  return out.realm ? out : null;
}

/** A registry client that answers one Bearer challenge per repository with the given credentials. */
export function client(fetchFn: Fetch, creds: Credentials | null) {
  const tokens = new Map<string, string>();
  return async function call(name: string, url: string, init: RequestInit = {}): Promise<Response> {
    const send = (token?: string) =>
      fetchFn(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    let res = await send(tokens.get(name));
    if (res.status !== 401) return res;
    const ch = parseChallenge(res.headers.get("www-authenticate") ?? "");
    if (!ch?.realm) return res;
    const q = new URLSearchParams({ scope: `repository:${name}:pull,push` });
    if (ch.service) q.set("service", ch.service);
    const auth = creds ? { Authorization: `Basic ${btoa(`${creds.user}:${creds.token}`)}` } : undefined;
    const tr = await fetchFn(`${ch.realm}?${q}`, { headers: auth });
    if (!tr.ok) throw new Error(`token request for ${name} failed (${tr.status})`);
    const body = (await tr.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) throw new Error(`token response for ${name} has no token`);
    tokens.set(name, token);
    res = await send(token);
    return res;
  };
}

/** Point `<registry>/<image>:latest` at the index `digest`, keeping its bytes and digest. */
export async function tagLatest(
  call: ReturnType<typeof client>,
  registry: string,
  image: string,
  digest: string,
): Promise<void> {
  if (!DIGEST.test(digest)) throw new Error(`invalid digest for ${image}: ${digest}`);
  const { base, name } = repoUrl(registry, image);
  const get = await call(name, `${base}/${name}/manifests/${digest}`, { headers: { Accept: ACCEPT } });
  if (!get.ok) throw new Error(`${image}: GET ${digest} failed (${get.status})`);
  const type = get.headers.get("content-type") ?? "";
  if (!INDEX_TYPES.includes(type)) throw new Error(`${image}: ${digest} is not an index (${type})`);
  const body = new Uint8Array(await get.arrayBuffer());
  const actual = `sha256:${new Bun.CryptoHasher("sha256").update(body).digest("hex")}`;
  if (actual !== digest) throw new Error(`${image}: registry returned ${actual} for ${digest}`);
  const put = await call(name, `${base}/${name}/manifests/latest`, {
    method: "PUT",
    headers: { "Content-Type": type },
    body,
  });
  if (!put.ok) throw new Error(`${image}: PUT latest failed (${put.status})`);
  const echoed = put.headers.get("docker-content-digest");
  if (echoed && echoed !== digest) throw new Error(`${image}: latest resolved to ${echoed}, expected ${digest}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const registry = opt("registry");
  const digests = opt("digests");
  if (!registry || !digests) {
    console.error("usage: tag-latest.ts --registry <r> --digests <dir>");
    process.exit(2);
  }
  const user = process.env.REGISTRY_USER ?? "";
  const token = process.env.REGISTRY_TOKEN ?? "";
  const call = client(fetch, user && token ? { user, token } : null);
  for (const image of RELEASE_IMAGES) {
    const digest = readFileSync(join(digests, `${image}.digest`), "utf8").trim();
    await tagLatest(call, registry, image, digest);
    console.log(`${registry}/${image}:latest → ${digest}`);
  }
}
