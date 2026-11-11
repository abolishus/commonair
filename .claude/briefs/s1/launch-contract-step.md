<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1 launch scale: the contract step (orchestrator)

The orchestrator does this itself, on `main`, before wave 1 of
[ADR 0041](../../../docs/decisions/0041-launch-scale.md)'s units starts. Units build against the
committed result and treat every name below as read-only. Code facts were checked at `14c3c83a`
(2026-11-11). The latest migration is `0060_w5_protections`, so this step's is `0061`.

**Waves** (paths are disjoint inside a wave):

| Wave | Units                                                                                                         | Starts from                        |
| ---- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 0    | [S1-i stream cost](S1-i-stream-cost.md)                                                                       | `main` now: it needs nothing below |
| 1    | [S1-j](S1-j-moderation.md), [S1-e](S1-e-placement.md), [S1-f](S1-f-balancer-pooler.md), [S1-n](S1-n-roles.md) | this step's sha                    |
| 2    | [S1-m](S1-m-admission.md), [S1-k](S1-k-scaler.md)                                                             | wave 1 merged                      |
| 3    | [S1-o](S1-o-rehearsal.md)                                                                                     | wave 2 merged                      |

## Why a contract step

Today nothing names a host. One MediaMTX and one media service are assumed everywhere:

- `MEDIAMTX_API_URL`, `MEDIAMTX_HLS_URL`, `MEDIAMTX_RTSP_URL` and `MEDIAMTX_SRT_URL`
  (`packages/config/src/env.ts:258-268`) are single URLs, read by api, origin, media and worker.
- `infra/mediamtx/mediamtx.yml:29` posts auth to `http://api:3001`, and its hooks post
  `ready`/`not-ready` to `$API_INTERNAL_URL` with no sender identity.
- Every media instance subscribes to all of `BUS.live` and reconciles every open broadcast
  (`services/media/src/lifecycle.ts:111`).
- `broadcasts` (`packages/db/src/schema/media.ts:35`) has no host column, and contracts have no
  node concept apart from relays (`KEYS.relays`, `relay_nodes`).

## 1. Database (`packages/db`, migration `0061_cluster_nodes`)

1. **`cluster_nodes`**: one row per host that carries a role.
   - `id` (UUIDv7), `role` (`app` | `media` | `moderation`), `name` (the operator's or scaler's
     label, unique), `internal_host` (the address other hosts use, a VPC address or name),
     `public_host` (nullable: a media node's own public address for WebRTC ICE).
   - `state`: `active` | `cordoned` | `draining` | `gone`.
   - `max_streams` and `ladder_slots` (nullable integers, media only: what the node says it can
     carry).
   - `registered_at`, `last_seen_at`, `state_changed_at`.
   - No personal data. A single-host install has one row per role it runs, all named `local`,
     written at startup.
2. **`broadcasts.media_node_id`**: nullable FK to `cluster_nodes`, set when the broadcast starts
   and changed when it resumes on another node. Add a partial index on `media_node_id where
   ended_at is null`.
3. **Protections** (`0061` or a sibling protections file, per the `schema-change` skill):
   - a `gone` node cannot return to another state;
   - a broadcast cannot be placed on a node that is not `active`, except to keep its current
     node;
   - the non-owner app role gets insert/update on `cluster_nodes`, no delete.
4. **Audit.** Every state change to `cordoned`, `draining` or `gone` writes an `audit_log` row
   with the actor (an admin's user id, or the system actor for the scaler). Add the audit action
   names to `packages/contracts/src/enums.ts`.

## 2. Env (`packages/config/src/env.ts` and `.env.example`, kept in sync)

| Key                                | Default     | Read by       | Meaning                                                                                                 |
| ---------------------------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `NODE_NAME`                        | `local`     | every service | this host's `cluster_nodes.name`                                                                        |
| `NODE_INTERNAL_HOST`               | `localhost` | every service | the address other hosts reach this one on                                                               |
| `MEDIA_NODE_PUBLIC_HOST`           | unset       | media         | a media node's public address, when it differs from the site's                                          |
| `MEDIA_NODE_MAX_STREAMS`           | unset       | media         | streams this node accepts; unset means no node limit                                                    |
| `LIVE_ADMISSION_MAX_STREAMS`       | unset       | api           | instance-wide cap on concurrent live broadcasts (the launch waves: 100, 300, 1,000); unset means no cap |
| `LIVE_ADMISSION_LADDER_STOP_RATIO` | `0.8`       | media         | share of pool capacity past which no new ladder starts                                                  |
| `WORKER_QUEUES`                    | `all`       | worker        | `all`, or a comma list of `QUEUES` names this worker consumes (`moderation` for the moderation role)    |
| `DATABASE_PREPARE`                 | `true`      | every service | `false` behind a transaction-mode pooler                                                                |
| `SCALER_PROVIDER`                  | `static`    | worker        | `static` \| `digitalocean`                                                                              |
| `SCALER_<POOL>_MIN` / `_MAX`       | unset       | worker        | pool sizes for `APP`, `MEDIA`, `MODERATION`; required when the provider is not `static`                 |
| `SCALER_DRY_RUN`                   | `false`     | worker        | plan and audit, apply nothing                                                                           |

- `packages/db/src/client.ts` `createDb` passes `prepare: env.DATABASE_PREPARE`. It sets no
  `prepare` today, so postgres.js prepares statements, which a transaction-mode pooler breaks.
  Migrations keep a direct connection (`packages/db/src/migrate.ts`).
- The four `MEDIAMTX_*_URL` keys stay, as **this node's** MediaMTX. Media reads them as today.
  api, origin and worker stop reading them for a broadcast and resolve the broadcast's node
  instead (§3).

## 3. Contracts (`packages/contracts`)

1. **Node identity on MediaMTX's calls.** `mediaAuth`, `mediaReady` and `mediaNotReady`
   (`INTERNAL_ROUTES`, `src/internal.ts:70-134`) gain a required `node` field: the sender's
   `NODE_NAME`. `mediamtx.yml` sends it from the environment.
2. **Node addressing.** A helper in contracts builds a node's internal URLs from
   `internal_host`: MediaMTX API `:9997`, HLS `:8888`, RTSP `:8554`, SRT `:8890`, WHIP `:8889`,
   media service `:3004`. The ports are constants, not per-node data.
3. **Node registry in Valkey.** `KEYS.clusterNodes` is a hash of node name to `{role, state,
   internalHost, liveStreams, maxStreams, laddersActive, ladderSlots, cpuP95, seenAt}`, refreshed by
   each node every 10 s and expiring at 30 s. Postgres holds the durable row, and Valkey holds
   load.
4. **`LiveEvent`** (`src/internal.ts:139`) gains `node` on `online`, `offline` and `renditions`.
   A media instance acts only on its own node's events.
5. **Per-node queues.** `QUEUES.clips` jobs that need the live buffer carry `node` and are
   consumed from `clips:<node>`. Jobs that work from the VOD in S3 stay on the shared queue.
6. **Admission.** `mediaAuth`'s refusal gains a machine-readable reason, `capacity_full`, beside
   the existing ones. The public `stream.ingest` output (`services/api/src/routes/stream.ts:93`)
   gains `admission: "open" | "full"`. `WARNINGS` gains `ladderCapacity` if
   `WARNINGS.transcodeCapacity` does not already cover a pool-wide stop (check; reuse it if it
   does).
7. **Node join** (for S1-k and S1-n). `INTERNAL_ROUTES.nodeJoin`: a new host presents a
   one-time token and receives its role's env. The token is minted by the scaler or by
   `selfhost.sh` on an app host, lives 10 minutes in Valkey, is single-use, and is accepted only
   from the VPC. No long-lived secret is ever placed in a droplet's user data or in a snapshot.
8. **Scaler provider enum**: `SCALER_PROVIDERS = ["static", "digitalocean"]`, beside
   `PAYMENT_PROVIDERS` (`src/enums.ts:58`).
9. **Metric names** (constants, so dashboards and the scaler agree):
   - `media.streams.live`, `media.ladders.active`, `media.node.max_streams`,
     `media.node.ladder_slots` (per node);
   - `live.admission.refused` (api, by reason);
   - `moderation.sample.lag` (seconds from capture to verdict) and `moderation.capture.duration`;
   - `scaler.pool.size`, `scaler.pool.desired`, `scaler.actions` (by pool and action).
10. **i18n keys** for the creator dashboard's "capacity full, retrying" state (S1-m fills the
    wording in `en`, `es` and `en-XA`).

## 4. Internal addressing between hosts: decide and record here

Units need one answer before wave 1, so the orchestrator picks it in this step and writes it into
ADR 0041:

- **Media host to api.** `mediamtx.yml` takes one auth URL and the hooks one `API_INTERNAL_URL`.
  With several app hosts that URL must survive an app host going away.
- **App host to a media node.** Resolved per broadcast from `cluster_nodes.internal_host` (§3.2).
  No balancing is needed.
- **Candidates for media-to-api:** the provider's internal load balancer, where one exists; or
  a local forwarder on each non-app host (the Caddy image the stack already pins) over the `app`
  rows of the node registry. Recommended: the local forwarder, because it works for every
  operator and adds no image. Check the pinned Caddy can reload its upstream list without
  dropping requests.
- **Security.** Internal ports listen on the VPC interface only, the cloud firewall admits them
  only from the instance's tags, and every call keeps its existing credential (`x-internal-secret`,
  MediaMTX basic auth). Whether VPC traffic also gets TLS is recorded as a decision either way.

## 5. What the orchestrator checks before releasing wave 1

- `bun run --filter @commonair/db generate --name cluster_nodes` produced `0061`, and the
  protections have integration tests (each rule fires; the app role cannot delete).
- The env sync test passes (`packages/config`), and `infra/selfhost/env/*.keys` lists each new
  key for the units that read it.
- A single-host stack behaves as before with every new key unset: one `local` node per role, no
  admission cap, `prepare: true`.
- The W5 schema work that was in flight on 2026-11-11 is merged first. This step never shares a
  migration number with it.
