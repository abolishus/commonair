<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0009: Public media through the origin's `/media` route

- Status: accepted (2026-10-21)
- Date: 2026-10-21

## Context

Avatars, banners, panels, emotes, thumbnails, clips and VODs live in the media bucket. The API
used to build their public URLs as `S3_PUBLIC_ENDPOINT/<bucket>/<key>`: the S3 API of the
object store, read anonymously. Garage, the FOSS default store, refuses anonymous reads on its
S3 API ("Garage does not support anonymous access yet"). None of these objects loaded in a
browser on the local stack.

The media bucket also holds objects that must never be public:

- `incoming/`: presigned uploads that have not been scanned yet (ADR 0006 Q6);
- `moderation/<case>/<flag>.jpg`: review frames;
- `moderation/ncii-hidden/`: objects hidden by the NCII 48-hour deadline.

T0 media is moved to the separate evidence bucket and deleted from the media bucket, so no T0
object stays in it.

## Options

1. **Garage's web endpoint** (`[s3_web]`, bucket website access). It is host-routed
   (`<bucket>.<root_domain>`) and serves **every** key of a website-enabled bucket. Garage has no
   bucket or prefix policies, so the private prefixes above would be public. Moving them to a
   second bucket would change the moderation, upload and deletion code paths. It would also tie
   the URL shape to Garage.
2. **A filtering proxy.** A service reads the bucket with the service key and serves only an
   allowlist of public prefixes.

## Decision

Option 2, in the origin (the playback edge, always running, already reachable by browsers and
already behind Caddy's `/hls`, `/cdn` and `/relay-pull`):

- `GET|HEAD /media/<key>` serves the object at `<key>` from `S3_BUCKET_MEDIA`. It passes single
  `Range` requests through (MP4 seeking) and returns content type, length, range, ETag and
  last-modified. It adds CORS `*`, `nosniff`, a sandboxing CSP and `cache-control: public,
  max-age=300`. The short TTL lets a hidden object drop out of shared caches within minutes.
- Only keys whose first segment is `channels`, `clips`, `thumbnails` or `vods` are served. Each
  segment is percent-decoded alone, and empty, `.`, `..`, `/`, `\` and control-character
  segments are refused. Everything else is a 404 without touching storage, whether or not the
  object exists. The allowlist fails closed: a new private prefix needs no change here; a new
  public one does.
- `MEDIA_PUBLIC_URL` (new, default `http://localhost:3003/media`; compose
  `http://localhost:${ORIGIN_PORT}/media`; `https://<host>/media` behind Caddy) is the base of
  every public media URL: `mediaUrl()` returns `MEDIA_PUBLIC_URL/<key>`, and
  `instanceMediaBase()` (used to accept media references and to resolve NCII URLs) uses the same
  base.
- `S3_PUBLIC_ENDPOINT` keeps one job: the endpoint browsers reach for presigned uploads and
  downloads. Garage's web endpoint stays off (`infra/tests/compose.test.ts` checks this).

A CDN or a public bucket remains an optional adapter. An operator can point
`MEDIA_PUBLIC_URL` at a CDN that origin-pulls `/media/` from the origin. A store with real
prefix policies can also serve the public prefixes itself. Nothing requires either.

## Consequences

- Media bytes now pass through the origin (one extra hop on the local network). VOD playback is
  HLS, so the large transfers are segments; the CDN path above takes them off the origin when needed.
- Box art (`categories.box_art_key`) has no writer yet. When it gets one, its prefix must be
  added to the allowlist.
- The allowlist does not consult the database. A withheld VOD's objects are still readable at
  their UUIDv7 URLs, which nothing publishes. Hiding by moving to a private prefix (as NCII
  does) or deleting (as T0 does) is what removes public access.
- The trust-safety harness scenario reads clip 2 through its public URL. It checks that clip 1's
  URL and the would-be URL of its NCII-hidden copy both answer 404 while the hidden copy exists.
