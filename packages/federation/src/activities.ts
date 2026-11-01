// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ActivityStreams activities (ADR 0030): `Create`, `Delete` with a `Tombstone`, `Delete` of the
 * actor, `Accept{Follow}` and `Update{Service}`. Published activities are addressed to Public and
 * the followers collection. Pure; plain JSON with the AS2 context. Activity ids derive from the
 * stable object ids (`federation_objects`), so a redelivery carries the same id and remote servers
 * dedupe it.
 */
import type {
  ActorUrls,
  FederationObjectKind,
  NoteObject,
  ServiceActor,
  ServiceActorInput,
  TombstoneObject,
  VideoObject,
} from "./objects.ts";
import { serviceActor, tombstone } from "./objects.ts";

/** The ActivityStreams 2.0 context. */
export const AS2_CONTEXT = "https://www.w3.org/ns/activitystreams";
/** The security vocabulary context, for `publicKey`. */
export const SECURITY_CONTEXT = "https://w3id.org/security/v1";
/** The public collection. */
export const AS2_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
/** The media type of ActivityPub requests and answers. */
export const ACTIVITY_CONTENT_TYPE = "application/activity+json";
/** Both contexts, for documents that carry `publicKey`. */
export const ACTOR_CONTEXT: [string, string] = [AS2_CONTEXT, SECURITY_CONTEXT];

type Actor = Pick<ActorUrls, "id" | "followers">;

export interface CreateActivity {
  "@context": typeof AS2_CONTEXT;
  id: string;
  type: "Create";
  actor: string;
  published: string;
  to: [typeof AS2_PUBLIC];
  cc: [string];
  object: NoteObject | VideoObject;
}

/** `Create{Note|Video}`, id `<object id>/activity`, addressed as its object is. */
export function createActivity(object: NoteObject | VideoObject): CreateActivity {
  return {
    "@context": AS2_CONTEXT,
    id: `${object.id}/activity`,
    type: "Create",
    actor: object.attributedTo,
    published: object.published,
    to: [AS2_PUBLIC],
    cc: object.cc,
    object,
  };
}

export interface DeleteObjectActivity {
  "@context": typeof AS2_CONTEXT;
  id: string;
  type: "Delete";
  actor: string;
  to: [typeof AS2_PUBLIC];
  cc: [string];
  object: TombstoneObject;
}

/** `Delete{Tombstone}` of a published object, id `<object id>#delete`. */
export function deleteObjectActivity(
  actor: Actor,
  objectId: string,
  kind: FederationObjectKind,
  deleted: Date,
): DeleteObjectActivity {
  return {
    "@context": AS2_CONTEXT,
    id: `${objectId}#delete`,
    type: "Delete",
    actor: actor.id,
    to: [AS2_PUBLIC],
    cc: [actor.followers],
    object: tombstone(objectId, kind, deleted),
  };
}

export interface DeleteActorActivity {
  "@context": typeof AS2_CONTEXT;
  id: string;
  type: "Delete";
  actor: string;
  to: [typeof AS2_PUBLIC];
  cc: [string];
  object: string;
}

/**
 * `Delete` of the actor itself (suspension, federation turned off, account deletion). `occasion`
 * (the triggering event's id, say) makes the id differ per occurrence, so a second suspension
 * is not deduped against the first; without it the id is `<actor>#delete`.
 */
export function deleteActorActivity(actor: Actor, occasion?: string): DeleteActorActivity {
  return {
    "@context": AS2_CONTEXT,
    id: occasion ? `${actor.id}#delete/${encodeURIComponent(occasion)}` : `${actor.id}#delete`,
    type: "Delete",
    actor: actor.id,
    to: [AS2_PUBLIC],
    cc: [actor.followers],
    object: actor.id,
  };
}

/** The parts of a remote `Follow` an `Accept` echoes (Mastodon matches on the Follow's id). */
export interface FollowRef {
  id: string;
  type: "Follow";
  actor: string;
  object: string;
}

export interface AcceptActivity {
  "@context": typeof AS2_CONTEXT;
  id: string;
  type: "Accept";
  actor: string;
  to: [string];
  object: FollowRef;
}

/**
 * `Accept{Follow}` from the channel actor to the follower. `followKey` (the
 * `federation_followers` id plus a digest of the Follow's id) makes the id stable per follow.
 */
export function acceptActivity(actor: Pick<ActorUrls, "id">, follow: FollowRef, followKey: string): AcceptActivity {
  return {
    "@context": AS2_CONTEXT,
    id: `${actor.id}#accepts/follows/${followKey}`,
    type: "Accept",
    actor: actor.id,
    to: [follow.actor],
    object: { id: follow.id, type: "Follow", actor: follow.actor, object: follow.object },
  };
}

export interface UpdateServiceActivity {
  "@context": [string, string];
  id: string;
  type: "Update";
  actor: string;
  to: [typeof AS2_PUBLIC];
  cc: [string];
  object: ServiceActor;
}

/**
 * `Update{Service}` carrying the whole actor document with its current `publicKey` (Mastodon
 * replaces the stored actor with the object, so a partial document would clear fields). The id
 * names the key's creation time, so one rotation is one activity.
 */
export function updateServiceActivity(input: ServiceActorInput, keyCreatedAt: Date): UpdateServiceActivity {
  const object = serviceActor(input, ACTOR_CONTEXT);
  return {
    "@context": ACTOR_CONTEXT,
    id: `${object.id}#updates/key-${keyCreatedAt.getTime()}`,
    type: "Update",
    actor: object.id,
    to: [AS2_PUBLIC],
    cc: [object.followers],
    object,
  };
}

/** The `id` of an `actor` field (a string or an object with `id`); null otherwise. */
export function idOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string")
    return (value as { id: string }).id;
  return null;
}

/** The inbound activities the inbox applies (decision 5); everything else is dropped. */
export type InboundActivity =
  | { kind: "follow"; id: string; actor: string; object: string }
  | { kind: "undo-follow"; actor: string; followId: string | null; object: string | null }
  | { kind: "delete-actor"; actor: string }
  | { kind: "other"; actor: string | null; type: string | null };

/**
 * Classify an inbound activity from its parsed JSON. Reads only the fields it needs, from known
 * shapes (no JSON-LD processing).
 */
export function classifyInbound(json: unknown): InboundActivity {
  if (!json || typeof json !== "object") return { kind: "other", actor: null, type: null };
  const a = json as Record<string, unknown>;
  const type = typeof a.type === "string" ? a.type : null;
  const actor = idOf(a.actor);
  if (!actor) return { kind: "other", actor: null, type };
  switch (type) {
    case "Follow": {
      const id = typeof a.id === "string" ? a.id : null;
      const object = idOf(a.object);
      return id && object ? { kind: "follow", id, actor, object } : { kind: "other", actor, type };
    }
    case "Undo": {
      const inner = a.object;
      if (inner && typeof inner === "object") {
        const o = inner as Record<string, unknown>;
        if (o.type !== "Follow") return { kind: "other", actor, type };
        // A remote may only undo its own follow.
        if (idOf(o.actor) !== null && idOf(o.actor) !== actor) return { kind: "other", actor, type };
        return {
          kind: "undo-follow",
          actor,
          followId: typeof o.id === "string" ? o.id : null,
          object: idOf(o.object),
        };
      }
      // A bare id: the follow it names (we cannot see its type; treat it as a follow by this actor).
      if (typeof inner === "string") return { kind: "undo-follow", actor, followId: inner, object: null };
      return { kind: "other", actor, type };
    }
    case "Delete":
      return idOf(a.object) === actor ? { kind: "delete-actor", actor } : { kind: "other", actor, type };
    default:
      return { kind: "other", actor, type };
  }
}
