<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/api

The platform API: the oRPC contract from `@commonair/contracts` served as REST (OpenAPI) and
oRPC RPC, better-auth, the MediaMTX hooks, playback sessions and the relay protocol.

| Path                         | What                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `/api/*`                     | REST routes from the contract (`OpenAPIHandler`)                  |
| `/api/openapi.json`          | Generated OpenAPI 3.1 document                                    |
| `/api/auth/*`                | better-auth (email + password, magic link, passkeys, TOTP, OAuth) |
| `/api/auth/altcha-challenge` | ALTCHA proof-of-work challenge for signups                        |
| `/rpc/*`                     | oRPC RPC (used by the web app)                                    |
| `/internal/media/*`          | MediaMTX auth and ready/not-ready hooks (never exposed by Caddy)  |
| `/healthz`, `/readyz`        | Liveness, and readiness (Postgres, Valkey)                        |

## Run locally

```sh
bun install
bun scripts/init-env.ts                 # once: writes .env with fresh secrets
bun scripts/infra.ts test               # Postgres, Valkey, Mailpit (and Garage) under Podman
bun run --filter @commonair/db migrate  # apply migrations
cd services/api && bun --env-file=../../.env run dev
```

The API listens on `API_PORT` (3001). Verification and magic-link emails land in Mailpit at
<http://localhost:8025>. Try it:

```sh
curl localhost:3001/api/instance
curl localhost:3001/api/openapi.json | head
```

## Tests

```sh
bun run test       # unit tests (pure logic: access control, rate limiting, ranking, …)
bun run test:int   # integration: real Postgres (createTestDatabase, app role), Valkey, Mailpit
```

Integration tests start the API in-process on a random port, against a throwaway database as
the least-privilege application role, with a unique Valkey key prefix. Set `API_TEST_LOG=1` to
see the service logs.

## Layout

- `src/routes/<namespace>.ts`: one file per contract namespace, assembled in `src/router.ts`.
  Namespaces owned by later units throw `NOT_IMPLEMENTED` (HTTP 501) until they replace the file.
- `src/lib/orpc.ts`: the shared implementer and the one middleware that enforces
  `ProcedureMeta` (access level, token scopes, rate limit). The decision itself is the pure
  `decideAccess` in `src/lib/access.ts`.
- `src/auth/`: better-auth configuration, signup gates (ALTCHA, 13+ age gate, usernames).
- `src/events/outbox.ts` (`emit`) and `src/events/audit.ts` (`audit`): write in the caller's
  transaction. Handlers publish directly only to `BUS.chatControl` and `BUS.live`.
- `src/discovery/`: fair-discovery ranking ([README](src/discovery/README.md)).
- `src/playback/`: delivery-source assignment and the interim session verification rule
  (`verify.ts`, replaced by the integrity unit).
- `src/media/`: MediaMTX auth decisions and lifecycle hooks.
- `src/lib/leaks.ts`: stream-key leak scanning and revocation (`findLeakedKeys`,
  `revokeLeakedKey`; also exported from the package for the chat service).

## Notes

- Two-factor authentication turns on automatically once `two_factors` has the columns
  better-auth 1.7's plugin needs (`verified`, `failed_verification_count`, `locked_until`).
- OAuth providers sign in and link existing accounts; new accounts are created through the
  gated email signup only (the age gate needs a birth date).
- MediaMTX's auth requests cannot carry headers, so `/internal/media/auth` authenticates
  internal readers by the `internal` user and `INTERNAL_API_SECRET` password in the body;
  the ready/not-ready hooks require the `x-internal-secret` header.
