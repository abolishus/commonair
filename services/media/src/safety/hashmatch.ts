// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CSAM hash-match hook. Every thumbnail, clip thumbnail and sampled VOD frame is checked before
 * it is stored. Real perceptual-hash vendors (e.g. PhotoDNA, the NCMEC/IWF lists) require an
 * application and an agreement with the vendor, so no vendor adapter ships here (a non-goal for
 * this codebase); operators implement `HashMatcher` against their vendor's API. The default is a
 * no-op; `stub` matches exact SHA-256 digests from an operator-provided list file and exists so
 * the harness can exercise the enforcement path end to end.
 */
import { readFileSync } from "node:fs";

export type HashSubject = "broadcast" | "vod" | "clip";

export interface HashCheckContext {
  subjectType: HashSubject;
  subjectId: string;
  channelId: string;
}

export interface HashMatchResult {
  matched: boolean;
  /** Provider-specific metadata safe to store (never the image, never personal data). */
  details: Record<string, unknown>;
}

export interface HashMatcher {
  /** Stored in `hash_match_results.provider`. */
  readonly name: string;
  /** False for the no-op matcher: its "results" are not evidence of a check and are not recorded. */
  readonly records: boolean;
  check(image: Uint8Array, ctx: HashCheckContext): Promise<HashMatchResult>;
}

export class NoopHashMatcher implements HashMatcher {
  readonly name = "none";
  readonly records = false;
  async check(): Promise<HashMatchResult> {
    return { matched: false, details: {} };
  }
}

/** Parse a list file: one hex SHA-256 per line; blank lines and `#` comments ignored. */
export function parseHashList(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim().toLowerCase();
    if (!line) continue;
    if (!/^[0-9a-f]{64}$/.test(line)) throw new Error(`hash list: not a SHA-256 hex digest: ${line.slice(0, 16)}…`);
    out.add(line);
  }
  return out;
}

export class StubVendorMatcher implements HashMatcher {
  readonly name = "stub";
  readonly records = true;

  constructor(private readonly hashes: ReadonlySet<string>) {}

  static fromFile(path: string): StubVendorMatcher {
    return new StubVendorMatcher(parseHashList(readFileSync(path, "utf8")));
  }

  async check(image: Uint8Array): Promise<HashMatchResult> {
    const digest = new Bun.CryptoHasher("sha256").update(image).digest("hex");
    const matched = this.hashes.has(digest);
    // The digest of a non-matching image is not stored: it would be a fingerprint of user content.
    return { matched, details: { method: "sha256-list", listSize: this.hashes.size } };
  }
}

export function createHashMatcher(env: {
  HASH_MATCH_PROVIDER: "none" | "stub";
  HASH_MATCH_LIST_FILE?: string;
}): HashMatcher {
  if (env.HASH_MATCH_PROVIDER === "none") return new NoopHashMatcher();
  if (!env.HASH_MATCH_LIST_FILE) throw new Error("HASH_MATCH_PROVIDER=stub requires HASH_MATCH_LIST_FILE");
  return StubVendorMatcher.fromFile(env.HASH_MATCH_LIST_FILE);
}
