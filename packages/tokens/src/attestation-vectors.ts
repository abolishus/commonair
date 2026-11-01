// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `attestation` section of vectors.json (`bun run vectors`): canonical bytes, a two-entry
 * chain, the hash commitments and tamper cases, all from fixed test keys. Ed25519 is
 * deterministic, so the output is stable. Test keys only; never use them anywhere else.
 */
import {
  type AttestationKey,
  type AttestationStatement,
  canonicalize,
  entryHash,
  importAttestationSigningKey,
  reasonsCommitment,
  type SignedAttestation,
  sign,
  thresholdsHash,
  toB64url,
} from "./attestation.ts";

/** PKCS#8 of the RFC 8032 §7.1 test vector 2 seed (4ccd08…a6fb). */
export const ATTESTATION_TEST_KEY = "MC4CAQAwBQYDK2VwBCIEIEzNCJso/5banbbDRuwRTg9bijGfNaumJNqM9u1PuKb7";
/** PKCS#8 of the RFC 8032 §7.1 test vector 1 seed: a second, unrelated key for the tamper cases. */
export const ATTESTATION_OTHER_KEY = "MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g";

const enc = new TextEncoder();

export async function attestationVectors() {
  const key = await importAttestationSigningKey(ATTESTATION_TEST_KEY);
  const other = await importAttestationSigningKey(ATTESTATION_OTHER_KEY);
  const rawSign = async (bytes: Uint8Array<ArrayBuffer>, k = key): Promise<SignedAttestation> => ({
    payload: toB64url(bytes),
    signature: toB64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, k.privateKey, bytes))),
  });

  const reasons = {
    // 32 fixed bytes (0x00..0x1f), base64url.
    salt: toB64url(Uint8Array.from({ length: 32 }, (_, i) => i)),
    // Exclusion categories (decision (k)), never signal codes; zero categories are left out.
    breakdown: { datacenter: 5_400, playback_pattern: 1_200, automation: 600 },
    commitment: "",
  };
  reasons.commitment = await reasonsCommitment(reasons.salt, reasons.breakdown);

  const thresholds = {
    rulesetVersion: 1,
    // The seeded `integrity.thresholds` value (packages/db/src/seed.ts), the real hash input.
    thresholds: {
      sessionExcludeScore: 0.7,
      followBurstPerMinute: 30,
      relayOverReportTolerance: 0.1,
      maxSessionsPerDevice: 3,
      gateUnlocksPerAddress: 5,
      gateFallbackAccountAgeDays: 7,
    },
    hash: "",
  };
  thresholds.hash = await thresholdsHash(thresholds.rulesetVersion, thresholds.thresholds);

  const statement: AttestationStatement = {
    v: 1,
    kind: "broadcast",
    origin: "https://instance.example",
    kid: key.kid,
    channelId: "01890000-0000-7000-8000-00000000c001",
    broadcastId: "01890000-0000-7000-8000-00000000b001",
    seq: 1,
    prevHash: null,
    supersedes: null,
    periodStart: "2023-11-14T22:13:20.000Z",
    periodEnd: "2023-11-15T00:13:20.000Z",
    signedAt: "2023-11-15T02:13:20.000Z",
    rulesetVersion: thresholds.rulesetVersion,
    thresholdsHash: thresholds.hash,
    peakVerifiedConcurrent: 42,
    verifiedViewerSeconds: 151_200,
    durationSeconds: 7_200,
    unverifiedViewerSeconds: 3_600,
    excludedViewerSeconds: 7_200,
    reasonsCommitment: reasons.commitment,
    deliveryBytes: { origin: 1_073_741_824, relay: 4_294_967_296, cdn: 0 },
  };
  const canonical = new TextDecoder().decode(canonicalize(statement));
  const signed = await sign(key, statement);
  const hash = await entryHash(signed);

  // A later supersede of the same broadcast: one more verified minute after a group appeal.
  const supersede: AttestationStatement = {
    ...statement,
    kind: "supersede",
    seq: 2,
    prevHash: hash,
    supersedes: hash,
    signedAt: "2023-11-16T02:13:20.000Z",
    verifiedViewerSeconds: 151_260,
    excludedViewerSeconds: 7_140,
  };
  const supersedeSigned = await sign(key, supersede);

  const keys: AttestationKey[] = [
    {
      kid: key.kid,
      algorithm: "Ed25519",
      publicKey: key.publicKey,
      firstUsedAt: statement.signedAt,
      retiredAt: null,
      compromisedAt: null,
    },
  ];
  const [active] = keys as [AttestationKey];

  const tampered = canonical.replace('"verifiedViewerSeconds":151200', '"verifiedViewerSeconds":151201');
  const flipped = Uint8Array.from(atob(signed.signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  flipped[0] = (flipped[0] ?? 0) ^ 0x01;
  // Same statement, `kind` before `v`.
  const { v: version, kind, ...rest } = statement;
  const reordered = JSON.stringify({ kind, v: version, ...rest });
  const foreignKid = canonical.replace(`"kid":"${key.kid}"`, `"kid":"${other.kid}"`);

  const cases: { name: string; signed: SignedAttestation; keys?: AttestationKey[]; error: string | null }[] = [
    { name: "valid broadcast entry", signed, error: null },
    { name: "valid supersede entry", signed: supersedeSigned, error: null },
    {
      name: "a retired key still verifies what it signed",
      signed,
      keys: [{ ...active, retiredAt: "2023-12-01T00:00:00.000Z" }],
      error: null,
    },
    {
      name: "figure changed after signing",
      signed: { payload: toB64url(enc.encode(tampered)), signature: signed.signature },
      error: "bad_signature",
    },
    { name: "signature bit flipped", signed: { ...signed, signature: toB64url(flipped) }, error: "bad_signature" },
    {
      name: "signature truncated",
      signed: { ...signed, signature: signed.signature.slice(0, 84) },
      error: "bad_signature",
    },
    {
      name: "signed by another key under this kid",
      signed: await rawSign(enc.encode(canonical), other),
      error: "bad_signature",
    },
    { name: "kid not in the key history", signed: await rawSign(enc.encode(foreignKid)), error: "unknown_kid" },
    {
      name: "compromised kid, whatever the date",
      signed,
      keys: [{ ...active, compromisedAt: "2030-01-01T00:00:00.000Z" }],
      error: "compromised_kid",
    },
    {
      name: "history row whose kid is not derived from its key",
      signed,
      keys: [{ ...active, publicKey: other.publicKey }],
      error: "kid_mismatch",
    },
    {
      name: "valid signature over whitespace-formatted JSON",
      signed: await rawSign(enc.encode(JSON.stringify(statement, null, 1))),
      error: "non_canonical",
    },
    {
      name: "valid signature over reordered keys",
      signed: await rawSign(enc.encode(reordered)),
      error: "non_canonical",
    },
    {
      name: "valid signature over a float figure",
      signed: await rawSign(enc.encode(canonical.replace('"durationSeconds":7200', '"durationSeconds":7200.5'))),
      error: "malformed",
    },
    {
      name: "valid signature over an unknown field",
      signed: await rawSign(enc.encode(canonical.replace('"v":1,', '"v":1,"note":"x",'))),
      error: "malformed",
    },
    {
      name: "padded base64url payload",
      signed: { ...signed, payload: `${signed.payload}=` },
      error: "malformed",
    },
  ];

  return {
    note: "ADR 0014. RFC 8032 test vector 2 key; hashes are hex SHA-256, kid is base64url of SHA-256(raw public key)[0:16].",
    privateKeyPkcs8: ATTESTATION_TEST_KEY,
    publicKey: key.publicKey,
    kid: key.kid,
    keys,
    statement,
    canonical,
    signed,
    entryHash: hash,
    supersede: { statement: supersede, signed: supersedeSigned, entryHash: await entryHash(supersedeSigned) },
    reasons,
    thresholds,
    cases,
  };
}
