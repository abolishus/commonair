// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity.*`. `flags` and `decide` (admins) live in `../admin/integrity.ts` (E7-admin);
 * `channelSummary` is still HTTP 501 until W2-rollup-analytics implements it (wave 1). The
 * owner-side attestation procedures and `keys.compromise` answer 501 until W2b-attestations
 * (wave 2, which takes this file over); the public verifier and the well-known key history are
 * that unit's `./attestation-verify.ts`.
 */
import { decideFlag, listFlags } from "../admin/integrity.ts";
import { notImplemented } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { attestationKeys, attestationVerify } from "./attestation-verify.ts";

export const integrity = {
  channelSummary: os.integrity.channelSummary.handler(notImplemented),
  flags: os.integrity.flags.handler(({ context, input }) => listFlags(context.deps, input)),
  decide: os.integrity.decide.handler(({ context, input }) =>
    decideFlag(context.deps, requireCaller(context).user.id, input),
  ),
  attestations: {
    list: os.integrity.attestations.list.handler(notImplemented),
    get: os.integrity.attestations.get.handler(notImplemented),
    share: os.integrity.attestations.share.handler(notImplemented),
    shareLinks: {
      list: os.integrity.attestations.shareLinks.list.handler(notImplemented),
      revoke: os.integrity.attestations.shareLinks.revoke.handler(notImplemented),
    },
    bundle: os.integrity.attestations.bundle.handler(notImplemented),
    shared: os.integrity.attestations.shared.handler(notImplemented),
    verify: attestationVerify,
  },
  keys: {
    list: attestationKeys,
    compromise: os.integrity.keys.compromise.handler(notImplemented),
  },
};
