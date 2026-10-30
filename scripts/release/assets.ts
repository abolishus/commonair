// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Names of the release assets beyond the contract's own (manifest.ts): SBOMs, signature and
 * provenance bundles. Kept in one place so the workflow, the checksums and the docs agree.
 */
import type { ReleaseImage } from "./manifest.ts";

/** CycloneDX JSON SBOM of a release asset or image. */
export const sbomAsset = (base: string) => `${base}.cdx.json`;
/** `cosign sign-blob --bundle` output. */
export const signatureAsset = (base: string) => `${base}.sigstore.json`;
/** `cosign attest-blob --type slsaprovenance1 --bundle` output (signed SLSA provenance). */
export const provenanceAsset = (base: string) => `${base}.intoto.sigstore.json`;
/**
 * The DSSE envelope from the provenance bundle, one JSON line: the slsa-github-generator layout,
 * and the only name OpenSSF Scorecard's Signed-Releases check counts as provenance.
 */
export const envelopeAsset = (base: string) => `${base}.intoto.jsonl`;

/** Base name for an image's offline copies, e.g. `commonair-image-api_0.1.0_linux_arm64`. */
export function imageAssetBase(image: ReleaseImage, version: string, platform?: string): string {
  const base = `commonair-image-${image}_${version}`;
  return platform ? `${base}_${platform.replace("/", "_")}` : base;
}

/** An unsigned SLSA provenance predicate, uploaded for offline review. */
export const predicateAsset = (base: string) => `${base}.provenance.json`;

/** The image's predicate; its signed form is a cosign attestation on the image itself. */
export const imageProvenanceAsset = (image: ReleaseImage, version: string) =>
  predicateAsset(imageAssetBase(image, version));
