// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Regenerate vectors.json (`bun run vectors`). Ed25519 is deterministic, so output is stable. */
import { attestationVectors } from "./attestation-vectors.ts";
import { importSigningKey, signPlaybackToken, signReceipt } from "./index.ts";
import { purgeVectors, standingVectors } from "./standing-vectors.ts";

// Test-only key: the PKCS#8 encoding of the RFC 8032 test vector 1 seed. Never use in production.
const TEST_KEY = "MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g";

const key = await importSigningKey(TEST_KEY);
const claims = {
  v: 1 as const,
  sid: "01890000-0000-7000-8000-000000000001",
  cid: "01890000-0000-7000-8000-000000000002",
  path: "live/alice",
  src: "relay" as const,
  rid: "01890000-0000-7000-8000-000000000003",
  iat: 1_700_000_000,
  exp: 1_700_000_120,
};
/** ADR 0018: an origin token for a live path carrying the data-mode ceiling. */
const dataModeClaims = {
  v: 1 as const,
  sid: claims.sid,
  cid: claims.cid,
  path: "live/alice",
  src: "origin" as const,
  dm: 111_111,
  iat: 1_700_000_000,
  exp: 1_700_000_120,
};
/** Decision (x): a relay token for a DVR path (the API mints these from W3-dvr-relay on). */
const dvrRelayClaims = {
  v: 1 as const,
  sid: claims.sid,
  cid: claims.cid,
  path: "dvr/01890000-0000-7000-8000-000000000009",
  src: "relay" as const,
  rid: claims.rid,
  iat: 1_700_000_000,
  exp: 1_700_000_120,
};
const receipt = {
  v: 1 as const,
  relayId: "01890000-0000-7000-8000-000000000003",
  nonce: "0123456789abcdef0123",
  periodStart: "2023-11-14T22:13:20.000Z",
  periodEnd: "2023-11-14T22:14:20.000Z",
  entries: [{ sessionId: "01890000-0000-7000-8000-000000000001", segments: 30, bytes: 31_457_280 }],
};

process.stdout.write(
  `${JSON.stringify(
    {
      note: "Test vectors shared by packages/tokens (TS) and relay/internal/tokens (Go). Test key only.",
      privateKeyPkcs8: TEST_KEY,
      publicKey: key.publicKeyB64,
      playback: { claims, token: await signPlaybackToken(key, claims) },
      playbackDataMode: { claims: dataModeClaims, token: await signPlaybackToken(key, dataModeClaims) },
      playbackDvrRelay: { claims: dvrRelayClaims, token: await signPlaybackToken(key, dvrRelayClaims) },
      receipt: { payload: receipt, signed: await signReceipt(key, receipt) },
      attestation: await attestationVectors(),
      standing: await standingVectors(),
      purge: await purgeVectors(),
    },
    null,
    2,
  )}\n`,
);
