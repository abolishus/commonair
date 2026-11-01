<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Integrity ruleset changelog

Every signed audience attestation (ADR 0014) carries a `rulesetVersion` and a `thresholdsHash`:
SHA-256 over `{ rulesetVersion, thresholds }`, where `thresholds` is the `integrity.thresholds`
governance setting as parsed when the statement was signed. The version is
`RULESET_VERSION` in `packages/integrity/src/constants.ts`. It is bumped with any change to what a
signal or a verdict means, and every bump gets an entry here, so a sponsor holding a statement
from two years ago can read what its figures meant then.

A change to the threshold _values_ through governance does not bump the version: it changes the
`thresholdsHash`, and the governance history (`governance_settings` and its decision record)
says which values were in force. A change to what a signal detects, how signals combine, which
sessions count as verified, or how a figure is computed does bump it.

To check a statement's `thresholdsHash`, take the `integrity.thresholds` value in force at its
`signedAt` _as parsed by `IntegrityThresholds`_ (`packages/integrity/src/thresholds.ts`: unknown
keys dropped, defaults filled in for keys the stored value leaves out), and hash the `stableJson`
of `{ "rulesetVersion": <v>, "thresholds": <parsed value> }` (`thresholdsHash` in
`@commonair/tokens/attestation`, re-exported by `@commonair/sdk`). Hashing the raw stored value
can give a different hash.

## Version 1 (2026-11-01)

The first ruleset attestations are signed under (batch 6, W2b-attestations).

**Verdicts.** A playback session is one of:

- **Verified**: verdict `verified`, scored at least once (`scored_at` set), and every segment
  fetch judged (no `fetch_unjudged`). This is the gate-eligible set (`GATE_ELIGIBLE`,
  W0-integrity, `be72278`).
- **Unverified**: pending sessions, sessions never scored, and `fetch_unjudged` sessions. They are
  not judged to be bots, so they are never counted as verified and never as excluded.
- **Excluded**: verdict `excluded`. Its category is that of its highest-scoring signal
  (`exclusionCategoryOf`); an excluded session with no known signal (an admin decision) is `other`.

**Signals and their categories.** `datacenter_ip` → `datacenter`; `privacy_relay` →
`privacy_relay`; `device_concurrency` and `account_concurrency` → `concurrency`; `headless` →
`automation`; `heartbeat_inconsistent` and `fetch_pattern` → `playback_pattern`. A session is
excluded when its combined score is above `integrity.thresholds.sessionExcludeScore` (seeded 0.7).

**Settling.** The scorer revisits an ended session for `DEFAULT_FINALIZE_SECONDS` (3600 s); the
rollup and the attestation run `AUDIENCE_SETTLE_SECONDS` (7200 s) after the broadcast ends. A
later change to an ended session's verdict (a group appeal overturn, an admin decision) re-scores
it and is attested as a `supersede` entry; the original entry stays and still verifies.

**Figures** (all integers, from the broadcast's rollup):

- `verifiedViewerSeconds`, `unverifiedViewerSeconds`, `excludedViewerSeconds`: the sum, over
  sessions of each class, of each session's whole seconds inside the broadcast (an open session
  ends with the broadcast; a session with less than one whole second inside it counts nowhere).
- `peakVerifiedConcurrent`: the most verified sessions open at one instant (back-to-back sessions,
  such as a reconnect, do not overlap).
- `durationSeconds`: whole seconds from the broadcast's start to its end. Average verified viewers
  is `verifiedViewerSeconds / durationSeconds`, derived by the reader.
- `deliveryBytes`: egress bytes by the instance's own sources (`origin`, `relay`, `cdn`).
  Peer-to-peer bytes are not the instance's delivery and are not in the statement.
- `reasonsCommitment`: SHA-256 over a per-entry random salt and the excluded seconds by category
  (categories above 0 only). The breakdown is shown only to the channel owner or through an
  expiring share link, and is checked against the commitment.

**Thresholds in force at version 1** (seeded `integrity.thresholds`): `sessionExcludeScore` 0.7,
`followBurstPerMinute` 30, `relayOverReportTolerance` 0.1, `maxSessionsPerDevice` 3,
`gateUnlocksPerAddress` 5, `gateFallbackAccountAgeDays` 7. An instance may have changed them
since through governance; the statement's `thresholdsHash` names the values it was signed with.

Excluded traffic is not proof of wrongdoing: it is watching this instance could not count as
verified.
