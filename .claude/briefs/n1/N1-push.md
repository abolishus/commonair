<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N1-push: web push on Web Crypto (RFC 8291, RFC 8292), subscriptions and sends

You are implementing unit N1-push for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/N1-notifications-pwa.md`,
`docs/decisions/0028-notifications.md` (decisions 1, 2, 6), `.claude/briefs/n1/contract-step.md`
(§0, §1.3, §1.4 `PushStatus`, §1.5 `notifications.push`, §1.6 `PushJob`, §2.3 `push_subscriptions`,
§4, §6.1, §6.3 `WebPushSettings`, §6.5 `postPinned`, §8 step 4, §9, §12) and
`.claude/briefs/_done-means.md`. Do not look outside the repository. Work in your own git worktree
on a branch named `n1/push`, created from `main` after batch-4 wave 1 (the six W1 units) merged; the orchestrator gives you the sha, which contains the W1 and N1 contract steps; run `git merge main` first if main moved. Batch 4, wave 2, beside N1-fanout, N1-email,
N1-inbox, N1-pwa and W1-data-mode. You write no web strings (the browser side is N1-pwa's, in
the same wave: it codes against the contract, and its harness step 7 imports your
`harness/src/n1/ece.ts`, whose signatures the contract step fixed).

## Why

Push is what makes go-live useful on a phone. ADR 0028 allows it as an opt-in adapter (the push
service is the viewer's browser vendor's, the payload is end-to-end encrypted and carries only
the slug and title) and decides to implement RFC 8291 message encryption and the RFC 8292 VAPID
JWT in-repo on Web Crypto: **no new dependency**. You build the crypto, the API that stores a
browser's subscription encrypted, and the worker job that sends.

## You own (write only these)

- `services/worker/src/jobs/notify-push.ts` (stub) and `services/worker/src/notify/push/**` (new):
  `ece.ts` (RFC 8188 `aes128gcm` + RFC 8291 key derivation), `vapid.ts` (ES256 JWT, the
  `Authorization` header), `send.ts` (one subscription), `job.ts`
- `services/api/src/routes/notifications/push.ts` (stub: `status`, `subscribe`, `unsubscribe`)
  and `services/api/src/notifications/push/**` (new: endpoint validation, hash, encryption)
- Tests: `services/worker/tests/notify-push*.test.ts`, `services/worker/tests/ece*.test.ts`,
  `services/worker/tests/vapid*.test.ts`, `services/api/tests/push*.test.ts`
- Harness: `harness/src/n1/push.ts` (step 4) and `harness/src/n1/ece.ts` (stub with fixed signatures from the contract step §9.3; the harness's **own**
  decryptor and VAPID verifier, written independently of the worker's code so step 4 cross-checks
  it; N1-pwa's step 7 imports it), `harness/tests/n1/push.test.ts`, `harness/tests/n1/ece.test.ts`
- Docs: `docs/self-hosting/web-push.md` (new: what push is, that it reaches vendor push
  services, how to turn it on with `selfhost.sh --web-push` or `WEB_PUSH_ENABLED`, that the VAPID
  pair comes from `init-env` and rotating it drops every subscription, what the vendor sees)

Read-only, in particular: `packages/contracts/**` (`PushPayload`, `PushSubscriptionKeys`,
`NOTIFY_RULES`, `NOTIFY_SECRET_PURPOSES`, `PushJob`, `D.PushStatus`), `packages/tokens/**`
(`encryptSecret`, `decryptSecret`, `hmacHex`, `b64url`, `fromB64url`), `packages/config/**`,
`packages/db/**`, `services/worker/src/webhooks/**` (`postPinned`, `resolveCallback`),
`services/worker/src/notify/settings.ts`, `services/api/src/routes/notifications.ts`,
`services/api/src/lib/**`, `harness/src/n1/{run,push-receiver,selectors}.ts`. Anything else is
a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- Env: `WEB_PUSH_ENABLED`, `VAPID_PUBLIC_KEY` (base64url raw point), `VAPID_PRIVATE_KEY` (base64
  PKCS#8, worker only), `WEB_PUSH_ALLOW_INSECURE_ENDPOINTS` (harness only). Worker: `ctx.webPush`
  (`{ publicKey, privateKeyPkcs8, subject: "mailto:<general contact>", allowInsecure }`), absent
  when off; API: `deps.env`.
- `push_subscriptions`: `endpoint_hash = hmacHex(AUTH_SECRET, "push-endpoint:" + endpoint)`
  (unique), `subscription = encryptSecret(AUTH_SECRET, "push-subscription", JSON.stringify({ endpoint, p256dh, auth }))`,
  `last_success_at`, `failures`. Endpoints and keys are never logged; logs carry the row id.
- API: `status` → `{ enabled, vapidPublicKey (null when off), subscriptions }`; `subscribe`
  (`write` bucket) → `PRECONDITION_FAILED` requirement `web_push_disabled` when off; `unsubscribe`
  → `Ok` (also when nothing matched). Session callers only.
- Job: `PushJob { eventId, userId, channelId, broadcastId }` on `QUEUES.notifications`, id
  `push-${eventId}-${userId}`, `attempts: 4`, `backoffMs: 30_000` (enqueued by N1-fanout).
- Payload: `PushPayload` `{ v: 1, type: "go_live", slug, title }` (title `""` under the mature
  rule: read the member's `go_live` row for this event, `dedupe_key = 'go-live-' || eventId`, and
  use its payload, so push and in-app agree).

## What is there today (verified at `a43aa6b`; recheck against your base)

- `encryptSecret`/`decryptSecret`/`hkdfKey` (`packages/tokens/src/secrets.ts:14-60`), used for
  webhook secrets (`services/worker/src/webhooks/deliver.ts:66`).
- `resolveCallback` (`services/worker/src/webhooks/ssrf.ts:162-200`) and, after the contract
  step, `postPinned` in `services/worker/src/webhooks/http.ts` (binary body, given content type and
  user agent, response headers).
- Webhook delivery is the model for a retried outbound send (`services/worker/src/webhooks/deliver.ts`).

## Build

1. **`ece.ts`** (pure, Web Crypto only): `encryptPushPayload({ plaintext, uaPublic (65 bytes),
   authSecret (16 bytes), asKeyPair?, salt? }) → Uint8Array` per RFC 8291 §3.4 and RFC 8188 §2:
   ECDH(as_private, ua_public) → `ecdh_secret`; `PRK_key = HKDF-Extract(auth_secret, ecdh_secret)`;
   `IKM = HKDF-Expand(PRK_key, "WebPush: info\0" ‖ ua_public ‖ as_public, 32)`;
   `PRK = HKDF-Extract(salt, IKM)`; `CEK = HKDF-Expand(PRK, "Content-Encoding: aes128gcm\0", 16)`;
   `NONCE = HKDF-Expand(PRK, "Content-Encoding: nonce\0", 12)`; one record, plaintext ‖ `0x02`
   (last-record delimiter), AES-128-GCM; header `salt(16) ‖ rs(4, big-endian 4096) ‖ idlen(1)=65 ‖ as_public(65)`.
   Fresh `as` key pair and salt per message unless injected (tests). Refuse plaintext over
   `NOTIFY_RULES.maxPushPayloadBytes`. Also `decryptPushPayload` for tests.
2. **`vapid.ts`**: `vapidAuthorization({ endpoint, subject, publicKey, privateKeyPkcs8, now })` →
   `vapid t=<jwt>, k=<publicKey>`; JWT header `{ typ: "JWT", alg: "ES256" }`, claims
   `{ aud: new URL(endpoint).origin, exp: now + 12 h, sub }`; ECDSA P-256 SHA-256 signature (Web
   Crypto already returns the 64-byte `r ‖ s` JWS form). Cache the imported key per process.
3. **`send.ts`**: decrypt the row, `postPinned(endpoint, { headers: { TTL: String(NOTIFY_RULES.pushTtlSeconds), Urgency: "normal", Topic: <22-char base64url of sha256(channelId)>, "Content-Encoding": "aes128gcm", Authorization }, body, contentType: "application/octet-stream", userAgent: "CommonAir-Push/1" }, { allowInsecure: ctx.webPush.allowInsecure, timeoutMs: 10_000, maxResponseBytes: 4096 })`.
   `Topic` lets the vendor replace an undelivered go-live of the same channel. Outcomes:
   201/202 → `last_success_at = now`, `failures = 0`; 404/410 → delete the row; 413 → log an
   error (a bug), no retry; 429 or 5xx or a network error → retryable; 400/401/403 →
   `failures + 1`, delete at 5 consecutive (a subscription made for another VAPID key never
   works); a rejected address (SSRF guard) → delete the row (it can never be sent to).
4. **Job** (`jobs/notify-push.ts`): no `ctx.webPush` → return zeros (push turned off after
   enqueue). Load the member's subscriptions (at most 10) and their `go_live` row for the event
   (none → zeros: in-app off is fine, but the payload must exist; N1-fanout writes the row only
   when in-app is on, so when it is absent build the payload from the event and broadcast
   instead, applying the mature rule the same way, `broadcasts.mature OR channels.mature` and no
   `users.mature_confirmed_at` → empty title (contract step §0): share nothing with N1-fanout's
   code, read the same columns). Send to each; if any send was retryable, throw after the others are done so
   BullMQ retries (a retry re-sends to the ones that succeeded; the service worker's per-channel
   `tag` makes a duplicate replace the first). Return `{ sent, removed }`.
5. **API** (`routes/notifications/push.ts`, `notifications/push/**`): `subscribe` validates the
   endpoint (absolute `https:` URL, or `http:` when `WEB_PUSH_ALLOW_INSECURE_ENDPOINTS`; no
   credentials; ≤ 2048 chars; hostname present) and the keys (p256dh decodes to 65 bytes starting
   `0x04`, auth to 16 bytes; `PushSubscriptionKeys` admits padded base64url but `fromB64url` from
   `@commonair/tokens` is strict, so strip trailing `=` first and store the unpadded form), then upserts by `endpoint_hash` (`on conflict (endpoint_hash) do
   update set user_id, subscription, failures = 0`: a browser belongs to the last member who
   subscribed it), then deletes the member's oldest rows beyond
   `NOTIFY_RULES.maxPushSubscriptionsPerUser`. `unsubscribe` deletes by hash and caller.
   `status` counts the caller's rows. No audit rows (a member's own device).

## Tests you must add

- `ece`: the RFC 8291 Appendix A example byte for byte (inject its `as` key pair, salt and
  plaintext; compare the full message), decrypt round trip, the RFC 8188 §3.1 example (decrypt
  with its key, `rs`, salt), oversize refusal, tampered tag → decrypt fails.
- `vapid`: the header format; the JWT verifies with the public key (Web Crypto verify); claims;
  an endpoint with a path and query yields its origin as `aud`.
- Worker integration (local Bun HTTP receiver, `allowInsecure`): one subscription → one POST with
  the right headers whose body decrypts (with the test's UA private key) to the payload; 410 →
  row deleted; 429 → job throws after other subscriptions were tried; 403 ×5 → deleted; push off
  → zeros; mature broadcast + unconfirmed member → empty title.
- API (`createTestDatabase()`): disabled → `PRECONDITION_FAILED`; bad keys / `http:` endpoint
  refused (allowed with the flag); a second member subscribing the same endpoint takes it over;
  the eleventh subscription drops the oldest; stored value is ciphertext (no endpoint substring);
  `unsubscribe` is scoped to the caller.
- Harness step 4 (`harness/src/n1/push.ts`) per §8 of the contract step, with
  `harness/src/n1/ece.ts` unit-tested against the same RFC 8291 vector.

## Done means

`.claude/briefs/_done-means.md`, plus: `services/worker` and `services/api` tests (unit and
`test:int`, one package at a time), `harness` tests; `tsc` for each; lint and format on your
paths; **no new dependency** (`git diff main -- '**/package.json' bun.lock` is empty). Final
message: what you built, test counts, branch and sha, contract requests, the live commands
(`bun harness/src/cli.ts run notifications --set steps=1,4`; then in a real Chromium on an HTTPS
staging instance with `--web-push`, after N1-pwa merges, a real push to the browser).
