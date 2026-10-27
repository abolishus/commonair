<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W3: feature-wins wave 3

The spec is `docs/product/feature-wins.md` §4.13, §4.14 and §5 "Wave 3". Its gate "after E5, E6
and 3D" is now "after E8" (E5 and E6 are done). The ADRs it names are written and accepted:
[ADR 0017](../../../docs/decisions/0017-watch-rooms.md) (watch rooms),
[ADR 0016](../../../docs/decisions/0016-live-dvr.md) (DVR) and
[ADR 0026](../../../docs/decisions/0026-interactivity-policies.md) (predictions).

| Unit                | Gate now                                  | Notes                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W3-watch-rooms      | ADR 0017; W1-spine seam; user blocks      | DB-backed, TTL'd, deletion-worker coverage, strict age bands (trigger). Contract step: the `watch_room` report subject, and `user_blocks` with `me.blocks` routes unless W1 already shipped them (ADR 0012 decision 8 puts blocks in W1, ADR 0017 in W3; owner open: maintainer). Rooms do not ship without the block check |
| W3-portability      | none beyond W2                            | `me.exports` (E6, `router.ts:186-200`) is the bundle's base. Fixes the bundle schema N3 imports and N4 uses                                                                                                                                                                                                                 |
| W3-giveaways        | E8 interact; counsel on sweepstakes rules | no purchase necessary entry path                                                                                                                                                                                                                                                                                            |
| W3-jury             | met (E5 membership)                       | advisory only, never T0, seed committed to `audit_log`                                                                                                                                                                                                                                                                      |
| W3-surge-raids      | E8 raids                                  | target-side surge protection                                                                                                                                                                                                                                                                                                |
| W3-fair-predictions | E8 predictions                            | channel points only (ADR 0026)                                                                                                                                                                                                                                                                                              |
| W3-dvr-relay        | W2-dvr; signed relay purge first          | ADR 0016 v2                                                                                                                                                                                                                                                                                                                 |

Seven units: run at most six; W3-dvr-relay last.

## Done when

`watch-room` and `portability` scenarios pass; `interact` gains giveaway, surge-raid and
fair-prediction steps; `e2e-relay` serves DVR from a relay and purges on removal.
