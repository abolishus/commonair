<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1-e placement: streams spread across a pool of media hosts

You are implementing unit S1-e for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- [ADR 0041](../../../docs/decisions/0041-launch-scale.md), decision 4, and
  [ADR 0032](../../../docs/decisions/0032-scaling-and-availability.md) §5.
- [ADR 0012](../../../docs/decisions/0012-media-clock.md): one timeline per broadcast, which a
  move to another host must not break silently.
- `.claude/briefs/s1/launch-contract-step.md`, all of it. `cluster_nodes`,
  `broadcasts.media_node_id`, the `node` field on MediaMTX's calls, node addressing, the Valkey
  registry and per-node queues are yours to use and not to change.
- `.claude/briefs/s1/S1-c-replicas.md` and `harness/scenarios/multi-instance.ts`, the pattern
  for a second copy of a service in the harness.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**: work in your own git worktree, on branch
`s1/e-placement`, cut from the contract step's sha. S1-j, S1-f and S1-n run beside you. This is
the largest unit of the launch-scale work.

## Why

One host carries a handful of streams, and the launch target is 1,000 at once. A stream lives
on the host its encoder connected to, so the platform must know which host that is, and every
service that talks to "the" MediaMTX must talk to that one. Today one MediaMTX is assumed
everywhere: single `MEDIAMTX_*_URL` keys read by api, origin, media and worker, and a media
service that reconciles every open broadcast.

## You own (write only these)

- `services/media/src/**` **except** `moderation/**` (S1-j's), with the matching tests.
- `services/origin/src/**` and tests.
- `services/api/src/media/**` (`hooks.ts`, `auth.ts`, `live-grace.ts`),
  `services/api/src/moderation/live.ts` (`kickPublisher`), `services/api/src/stream/ingest.ts`,
  and a new `services/api/src/media/whip-proxy.ts`, with tests.
- `services/worker/src/rehearsal-driver.ts`, only where it reads `MEDIAMTX_API_URL`.
- `infra/mediamtx/**`.
- `infra/caddy/Caddyfile`, **only** the WHIP route (`/live/<slug>/whip`). S1-f owns the rest of
  the file: send your change as an exact diff in a contract request if S1-f has not merged, and
  apply it yourself only if the orchestrator says so.
- `harness/compose.multi-media.yaml` (new), `harness/src/multi/**` additions for media nodes,
  and `harness/scenarios/placement.ts` (new).

**Read-only:** `packages/**`, `services/media/src/moderation/**`, `apps/web/**`,
`scripts/**`, `infra/tofu/**`, `infra/quadlet/**`. Admission control (refusing a go-live when
the pool is full) is S1-m's in wave 2: leave `decidePublish`'s capacity decision to it, and
build only the node checks named below.

## Contracts you must honor

- A single-host install behaves exactly as today: one node named `local`, no extra config.
- The `node` field, node URLs, `KEYS.clusterNodes`, `LiveEvent.node` and `clips:<node>` come
  from the contract step.
- Viewers never address a media host. One public origin (`/hls/…`, `/relay-pull/…`, `/cdn/…`).
- Internal calls keep their credentials (`x-internal-secret`, MediaMTX basic auth with
  `MEDIA_INTERNAL_PASSWORD`).
- Every write with a side effect for other systems writes its outbox row in the same
  transaction (`stream.online` at `hooks.ts:299`, `stream.offline` at `live-grace.ts:158`).

## Build

1. **Node registration.** The media service registers its `cluster_nodes` row at startup
   (`NODE_NAME`, `NODE_INTERNAL_HOST`, `MEDIA_NODE_MAX_STREAMS`, its ladder slots from
   `SlotLimiter`), refreshes `KEYS.clusterNodes` every 10 s with its live stream and ladder
   counts, and marks itself `gone` on a clean shutdown. A node silent past the registry TTL is
   treated as lost.
2. **Placement on go-live.** `mediaReady` (`services/api/src/media/hooks.ts:170`) reads the
   hook's `node`, and sets `broadcasts.media_node_id` in the same transaction that inserts the
   broadcast and sets `channels.liveBroadcastId`. `mediaAuth` (`:116`) refuses a publish that
   arrives on a node that is not `active`, unless the channel's open broadcast is already on
   that node.
3. **Resume on another node.** A publish inside the reconnect grace
   (`live-grace.ts`, `openLiveGrace` `:87`) continues the same broadcast. When it arrives on a
   different node, move `media_node_id`, emit a `LiveEvent` so the old node's session stops and
   the new node's starts, and decide what ADR 0012's timeline does: either the recorder and W0
   clock carry across the move, or the move is recorded as a discontinuity that the VOD and DVR
   handle. Whichever it is, test it and write it into ADR 0041 as a contract request.
4. **`mediaNotReady` from the wrong node** (a stale hook after a move) is ignored: only the
   broadcast's current node can open its grace.
5. **Media acts on its own streams only.** `LiveCoordinator.handleMessage` (`lifecycle.ts:55`)
   and `reconcile()` (`:111`) filter by this node. A node that finds a session for a broadcast
   placed elsewhere stops it. Clip jobs that need the live buffer are consumed from
   `clips:<node>` (`clips.ts:120`), and the others stay on the shared queue.
6. **Origin routes by placement.** `ChannelDirectory` (`services/origin/src/channels.ts:41`)
   returns the broadcast's node with the channel, cached as today (5 s live, 2 s offline) and
   dropped on a `LiveEvent` for that channel. `MediaUpstream` (`upstream.ts:73`) keeps its
   session and semaphores **per node**, so one slow node cannot starve the others. After a move,
   cached playlists for the old node are not served past their TTL.
7. **Every other reader resolves the node.** `kickPublisher`
   (`services/api/src/moderation/live.ts:80`), the API's other `MEDIAMTX_API_URL` uses
   (`services/api/src/index.ts:63`) and `rehearsal-driver.ts:646` call the broadcast's node. A
   T0 kick must reach the right node on the first try and keep retrying as today.
8. **Ingest.**
   - RTMP: `mediamtx.yml` sends `node` on auth and hooks, from the environment. `ingestUrls()`
     (`services/api/src/stream/ingest.ts:24`) is unchanged: the public RTMP URL is the ingest
     load balancer's.
   - A node health endpoint for that load balancer: healthy only while the node is `active` and
     below `MEDIA_NODE_MAX_STREAMS`. Serve it from the media service on its own port, with no
     data in the body.
   - WHIP: `whip-proxy.ts` picks the least-loaded `active` node from the registry and proxies
     the signalling request to that node's MediaMTX over the internal network. ICE then flows to
     the node's own public address (`MEDIA_NODE_PUBLIC_HOST`). Check that MediaMTX can advertise
     a per-node address from its environment.
9. **Ladders.** A stream gets a ladder only from its own node's `SlotLimiter`
   (`transcode/slots.ts:22`). The existing "waiting" path and `WARNINGS.transcodeCapacity` stay.
   Publish `media.ladders.active` and the slot count.
10. **Metrics** from the contract step: `media.streams.live`, `media.ladders.active`,
    `media.node.max_streams`, `media.node.ladder_slots`.
11. **Harness.** `compose.multi-media.yaml` adds `mediamtx-2` and `media-2` under a profile, in
    the style of `harness/compose.multi-instance.yaml`. `placement` checks:
    - two streams published to different nodes both play through the one origin;
    - `broadcasts.media_node_id` matches where each was published;
    - a ladder starts on the stream's own node;
    - a clip of the live buffer works for a stream on each node;
    - a moderation T0 kick reaches the right node;
    - node 2 is killed (`podman kill`, as `multi/podman-ops.ts:30`), the streamer reconnects to
      node 1 inside the grace, the same broadcast continues, viewers recover, and the dead
      node's row is treated as lost;
    - a cordoned node refuses a new publish and keeps its running stream.

## Edge cases

- The same channel publishing to two nodes at once: one wins, as today's single-publisher rule.
- A hook arriving before its node has registered.
- A node that comes back after being treated as lost, with a stream still on it.
- A rehearsal broadcast (no `stream.online`) placed and moved like a live one.
- The grace expiring while the encoder is mid-reconnect on another node.
- A relay or the CDN path pulling during a move.
- Origin with a node entry in cache for a node that no longer resolves.

## Tests you must add

- Unit tests: node filtering in the coordinator, registry refresh and expiry, WHIP node choice,
  per-node upstream pools, the health endpoint's states.
- Integration tests (`*.int.test.ts`): placement written with the broadcast in one transaction;
  resume on another node; stale `not-ready`; publish refused on a cordoned node; origin's cache
  after a move.
- The `placement` scenario, and a contract request naming the harness shard it should join.
- The single-node suite passes unchanged.

## Reviewer focus

- Single-host behaviour is identical with no new configuration.
- No reader is left on the single `MEDIAMTX_*_URL` for a broadcast: list every use you changed.
- A moved stream cannot be served from, kicked on, or reconciled by the old node.
- Placement and outbox writes share a transaction.
- No internal port or credential is exposed to viewers.

## Done means

Follow `.claude/briefs/_done-means.md`: `bun run test` and `bun run test:int` for
`services/media`, `services/origin`, `services/api` and `services/worker` (one at a time),
`bunx tsc --noEmit` for each and for `harness`, lint, format and `reuse lint`. `git status`
shows only your paths. Commit with `git commit -s`.

Your final message lists: what you built, test counts, every `MEDIAMTX_*_URL` use and what it
resolves now, the ADR 0012 decision for a moved stream, contract requests (the Caddyfile diff,
the harness shard, any contract field you lacked), and the command for the user to run
`placement`.
