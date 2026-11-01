// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Mastodon-shaped fixtures, written from Mastodon's documented ActivityPub shapes
 * (docs.joinmastodon.org/spec/activitypub): the inbound activities a Mastodon server sends, and
 * the fields Mastodon reads from a `Note` and a `Video` it receives. Hand-written, not captured.
 */

const ALICE = "https://mastodon.example/users/alice";

export const MASTODON_INBOUND = {
  follow: (target: string) => ({
    "@context": "https://www.w3.org/ns/activitystreams",
    id: "https://mastodon.example/2f4e3c1a-6b9d-4d7e-8a1f-1c2b3d4e5f60",
    type: "Follow",
    actor: ALICE,
    object: target,
  }),
  undoFollow: (target: string) => ({
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${ALICE}#follows/12345/undo`,
    type: "Undo",
    actor: ALICE,
    object: {
      id: "https://mastodon.example/2f4e3c1a-6b9d-4d7e-8a1f-1c2b3d4e5f60",
      type: "Follow",
      actor: ALICE,
      object: target,
    },
  }),
  deleteActor: () => ({
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${ALICE}#delete`,
    type: "Delete",
    actor: ALICE,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    object: ALICE,
    signature: { type: "RsaSignature2017", creator: `${ALICE}#main-key`, signatureValue: "…" },
  }),
  createReply: (target: string) => ({
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${ALICE}/statuses/1/activity`,
    type: "Create",
    actor: ALICE,
    object: {
      id: `${ALICE}/statuses/1`,
      type: "Note",
      inReplyTo: `${target}/objects/x`,
      content: "<p>hi</p>",
      attributedTo: ALICE,
    },
  }),
} as const;

/**
 * The top-level fields of the `Note` we send. Mastodon reads `id`, `type`, `attributedTo`,
 * `published`, `url`, `to`/`cc` (visibility), `content`, `sensitive`, `summary` (content warning)
 * and `attachment` (media). `summary` is present only for mature content, so the plain fixture
 * leaves it out.
 */
export const MASTODON_NOTE_KEYS = [
  "id",
  "type",
  "attributedTo",
  "published",
  "url",
  "to",
  "cc",
  "content",
  "sensitive",
  "attachment",
] as const;

/** Mastodon converts a `Video` to a status from `name`, `url`, `content`, `icon` and `attachment`. */
export const MASTODON_VIDEO_KEYS = [
  "id",
  "type",
  "attributedTo",
  "published",
  "name",
  "duration",
  "url",
  "to",
  "cc",
  "content",
  "sensitive",
  "icon",
  "attachment",
] as const;
