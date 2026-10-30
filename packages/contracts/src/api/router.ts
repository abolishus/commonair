// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public API contract. services/api implements it; apps/web and @commonair/sdk
 * consume it; the OpenAPI document is generated from it. Paths are REST-style so
 * the generated spec reads naturally; every procedure is also reachable over oRPC RPC.
 */
import { z } from "zod";
import * as E from "../enums.ts";
import {
  AlertTemplate,
  BotConfig,
  ChannelChatSettingsPatch,
  ChannelTheme,
  GovernanceChange,
  MAX_UPLOAD_BYTES,
  UPLOAD_CONTENT_TYPES,
  UPLOAD_PURPOSES,
} from "../shapes.ts";
import { SCOPE_NAMES } from "../scopes.ts";
import { PUBLIC_EVENT_TYPES } from "../events.ts";
import { MONEY_LIMITS } from "../currency.ts";
import { OAUTH_LIMITS, PKCE_CHALLENGE, RedirectUri } from "../oauth.ts";
import {
  ChannelRef,
  Id,
  MATURE_GATE,
  SECOND_APPROVER,
  VOTE_REFUSED,
  Money,
  Ok,
  PageInput,
  ReturnPath,
  ShortText,
  Slug,
  Timestamp,
  UPLOAD_REJECTED,
  base,
  page,
} from "./common.ts";
import * as D from "./entities.ts";

const tag = (t: string) => ({ tags: [t] });
const user = base.meta({ access: "user" });
const owner = base.meta({ access: "owner" });
const mod = base.meta({ access: "moderator" });
const admin = base.meta({ access: "admin" });
const treasurer = base.meta({ access: "treasurer" });
const platformMod = base.meta({ access: "platform-moderator" });
const legal = base.meta({ access: "legal" });
const safetyStaff = base.meta({ access: "safety-staff" });
const finance = base.meta({ access: "finance" });

/** `vods.chat` / `clips.chat` (ADR 0012 amendment 1 decision 5). */
const ChatReplayInput = z.object({
  id: Id,
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

const ChannelUpdate = z.object({
  title: z.string().max(140).optional(),
  description: z.string().max(2000).optional(),
  categoryId: Id.nullable().optional(),
  tags: z
    .array(
      z
        .string()
        .min(1)
        .max(25)
        .regex(/^[\p{L}\p{N}-]+$/u),
    )
    .max(10)
    .optional(),
  language: z.string().min(2).max(8).optional(),
  mature: z.boolean().optional(),
  theme: ChannelTheme.optional(),
  vodEnabled: z.boolean().optional(),
  vodRetentionDays: z.number().int().min(1).max(60).optional(),
});

export const contract = {
  instance: {
    info: base
      .route({
        method: "GET",
        path: "/instance",
        summary: "Instance identity, source link, enabled features",
        ...tag("Instance"),
      })
      .output(D.InstanceInfo),
    status: base
      .route({
        method: "GET",
        path: "/status",
        summary: "Public status page data",
        ...tag("Instance"),
      })
      .output(D.StatusSummary),
  },

  me: {
    get: user
      .meta({ access: "user", scopes: [] })
      .route({
        method: "GET",
        path: "/me",
        summary: "The signed-in user (email only with user:read:email for tokens)",
        ...tag("Users"),
      })
      .output(D.Me),
    update: user
      .route({
        method: "PATCH",
        path: "/me",
        summary: "Update profile and privacy preferences",
        ...tag("Users"),
      })
      .input(
        z.object({
          displayName: z.string().min(1).max(40).optional(),
          shareEmailWithFollowedChannels: z.boolean().optional(),
          /** A language tag, or null to clear the choice (back to browser and instance defaults). */
          locale: D.LocaleTag.nullable().optional(),
        }),
      )
      .output(D.Me),
    confirmMature: user
      .route({
        method: "POST",
        path: "/me/mature-confirmation",
        summary: "Confirm 18+ to view mature streams (adults only)",
        ...tag("Users"),
      })
      .output(Ok),
    acceptLegal: user
      .route({
        method: "POST",
        path: "/me/legal-acceptances",
        summary: "Accept the current version of legal documents",
        ...tag("Compliance"),
      })
      .input(z.object({ documentIds: z.array(Id).min(1) }))
      .output(Ok),
    follows: user
      .meta({ access: "user", scopes: ["user:read:follows"] })
      .route({
        method: "GET",
        path: "/me/follows",
        summary: "Channels the user follows",
        ...tag("Follows"),
      })
      .input(PageInput)
      .output(
        page(
          z.object({
            channel: D.StreamCard.shape.channel,
            live: D.BroadcastSummary.nullable(),
            followedAt: Timestamp,
            notify: z.boolean(),
          }),
        ),
      ),
    notifications: user
      .route({
        method: "GET",
        path: "/me/notifications",
        summary: "In-app notifications",
        ...tag("Users"),
      })
      .input(PageInput.extend({ unreadOnly: z.boolean().default(false) }))
      .output(
        page(
          z.object({
            id: Id,
            type: z.enum(E.NOTIFICATION_TYPES),
            payload: z.record(z.string(), z.unknown()),
            readAt: Timestamp.nullable(),
            createdAt: Timestamp,
          }),
        ),
      ),
    markNotificationsRead: user
      .route({
        method: "POST",
        path: "/me/notifications/read",
        summary: "Mark notifications read",
        ...tag("Users"),
      })
      .input(z.object({ ids: z.array(Id).optional() }))
      .output(Ok),
    labels: user
      .route({
        method: "GET",
        path: "/me/moderation-labels",
        summary: "Active moderation labels on channels you own (each can be appealed)",
        ...tag("Moderation"),
      })
      .output(z.array(D.ContentLabel)),
    enforcement: {
      /**
       * Statements of reasons about the caller (ADR 0019 decision 8), newest first, keyset cursor
       * on `(created_at, id)`. A GET, so a suspended user can still read it.
       */
      list: user
        .route({
          method: "GET",
          path: "/me/enforcement",
          summary: "Statements of reasons about you",
          ...tag("Users"),
        })
        .input(PageInput)
        .output(
          page(
            D.EnforcementStatement.extend({
              /** The clause's plain-language title, from the i18n catalog. */
              clauseTitle: z.string(),
              /** The clause's section of the pinned `enforcement_notice` document. */
              explanation: z.string(),
              /** The notice text was an unreviewed draft when the statement was made. */
              noticeIsDraft: z.boolean(),
              /** Joined from `moderation_cases.resolution_note` on read; never stored in the statement. */
              moderatorNote: z.string().nullable(),
              /** An existing appeal against the same subject. */
              appealId: Id.nullable(),
              /** Computed on read: the case cleared or an appeal overturned it. */
              reversedAt: Timestamp.nullable(),
            }),
          ),
        ),
    },
    exports: {
      create: user
        .meta({ access: "user", rateLimit: "expensive" })
        .route({
          method: "POST",
          path: "/me/exports",
          summary: "Start a data export (account or channel)",
          ...tag("Compliance"),
        })
        .input(z.object({ kind: z.enum(E.EXPORT_KINDS) }))
        .output(D.ExportJob),
      list: user
        .route({
          method: "GET",
          path: "/me/exports",
          summary: "Your data exports",
          ...tag("Compliance"),
        })
        .output(z.array(D.ExportJob)),
    },
    deletion: {
      request: user
        .route({
          method: "POST",
          path: "/me/deletion",
          summary: "Schedule account deletion (grace period applies)",
          ...tag("Compliance"),
        })
        .input(z.object({ confirmUsername: Slug }))
        .output(D.DeletionRequest),
      cancel: user
        .route({
          method: "DELETE",
          path: "/me/deletion",
          summary: "Cancel a scheduled deletion",
          ...tag("Compliance"),
        })
        .output(Ok),
      get: user
        .route({
          method: "GET",
          path: "/me/deletion",
          summary: "Scheduled deletion, if any",
          ...tag("Compliance"),
        })
        .output(D.DeletionRequest.nullable()),
    },
    bots: {
      create: user
        .route({
          method: "POST",
          path: "/me/bots",
          summary: "Create a bot account you own",
          ...tag("Developers"),
        })
        .input(z.object({ username: Slug, displayName: z.string().min(1).max(40) }))
        .output(D.UserPublic),
      list: user
        .route({
          method: "GET",
          path: "/me/bots",
          summary: "Bot accounts you own",
          ...tag("Developers"),
        })
        .output(z.array(D.UserPublic)),
      createToken: user
        .route({
          method: "POST",
          path: "/me/bots/{botId}/tokens",
          summary: "Mint an access token for your bot",
          description:
            "Refused with PRECONDITION_FAILED (requirement `channel_bot`) for a channel's built-in bot: it speaks only through the bot engine, never with a token.",
          ...tag("Developers"),
        })
        .input(
          z.object({
            botId: Id,
            scopes: z.array(z.enum(SCOPE_NAMES)).min(1),
            expiresInDays: z.number().int().min(1).max(365).default(90),
          }),
        )
        .output(z.object({ token: D.AccessToken, accessToken: z.string().describe("Shown once.") })),
    },
    blocks: {
      list: user
        .route({ method: "GET", path: "/me/blocks", summary: "Users you blocked", ...tag("Users") })
        .input(PageInput)
        .output(page(D.BlockedUser)),
      /** All blocked user ids (at most BLOCK_RULES.maxPerUser), for hiding them in live chat. */
      ids: user
        .route({ method: "GET", path: "/me/blocks/ids", summary: "Ids of users you blocked", ...tag("Users") })
        .output(z.object({ userIds: z.array(Id).max(E.BLOCK_RULES.maxPerUser) })),
      add: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/me/blocks",
          summary: "Block a user: hidden from you in chat and chat replay",
          description:
            "Idempotent. Refused for yourself (BAD_REQUEST) and beyond BLOCK_RULES.maxPerUser (PRECONDITION_FAILED `block_limit`).",
          ...tag("Users"),
        })
        .input(z.object({ username: Slug }))
        .output(D.BlockedUser),
      remove: user
        .meta({ access: "user", rateLimit: "write" })
        .route({ method: "DELETE", path: "/me/blocks/{username}", summary: "Unblock a user", ...tag("Users") })
        .input(z.object({ username: Slug }))
        .output(Ok),
    },
  },

  users: {
    get: base
      .route({
        method: "GET",
        path: "/users/{username}",
        summary: "A user's public profile",
        ...tag("Users"),
      })
      .input(z.object({ username: Slug }))
      .output(D.UserPublic),
  },

  categories: {
    list: base
      .route({
        method: "GET",
        path: "/categories",
        summary: "Categories, busiest first",
        ...tag("Directory"),
      })
      .input(PageInput.extend({ q: z.string().max(80).optional() }))
      .output(page(D.Category)),
    get: base
      .route({
        method: "GET",
        path: "/categories/{slug}",
        summary: "One category",
        ...tag("Directory"),
      })
      .input(z.object({ slug: ShortText }))
      .output(D.Category),
  },

  directory: {
    /** The front page: blends popularity with spotlight slots for small channels (see docs/discovery.md). */
    home: base
      .route({
        method: "GET",
        path: "/directory",
        summary: "Front-page directory: live (fair-discovery ranking) and recently live",
        ...tag("Directory"),
      })
      .input(z.object({ language: ShortText.optional(), includeMature: z.boolean().default(false) }))
      .output(
        z.object({
          spotlight: z.array(D.StreamCard),
          newAndLive: z.array(D.StreamCard),
          live: z.array(D.StreamCard),
          following: z.array(D.StreamCard),
          /** Offline channels by when they were last live, newest first; unranked. */
          recentlyLive: z.array(D.ChannelCard),
          /** The caller's followed channels that are offline; empty for anonymous callers. */
          followingOffline: z.array(D.ChannelCard),
          rankingVersion: z.string(),
        }),
      ),
    live: base
      .route({
        method: "GET",
        path: "/directory/live",
        summary: "All live streams with filters",
        ...tag("Directory"),
      })
      .input(
        PageInput.extend({
          category: ShortText.optional(),
          language: ShortText.optional(),
          tag: ShortText.optional(),
          sort: z.enum(["recommended", "viewers_desc", "viewers_asc", "recent"]).default("recommended"),
          includeMature: z.boolean().default(false),
        }),
      )
      .output(page(D.StreamCard)),
    random: base
      .route({
        method: "GET",
        path: "/directory/random",
        summary: "A random live channel",
        ...tag("Directory"),
      })
      .input(z.object({ category: ShortText.optional(), includeMature: z.boolean().default(false) }))
      .output(D.StreamCard.nullable()),
    search: base
      .route({
        method: "GET",
        path: "/search",
        summary: "Search channels and categories",
        ...tag("Directory"),
      })
      .input(
        z.object({
          q: z.string().min(1).max(80),
          limit: z.number().int().min(1).max(50).default(20),
        }),
      )
      .output(
        z.object({
          channels: z.array(
            z.object({
              slug: Slug,
              displayName: z.string(),
              avatarUrl: z.string().nullable(),
              live: D.BroadcastSummary.nullable(),
              followerCount: z.number().int(),
            }),
          ),
          categories: z.array(D.Category),
        }),
      ),
    ranking: base
      .route({
        method: "GET",
        path: "/directory/ranking",
        summary: "The current ranking configuration (governance-controlled)",
        ...tag("Directory"),
      })
      .output(
        z.object({
          version: z.string(),
          config: z.record(z.string(), z.unknown()),
          explanation: z.string(),
        }),
      ),
  },

  channels: {
    get: base
      .route({
        method: "GET",
        path: "/channels/{channel}",
        summary: "Channel page data",
        ...tag("Channels"),
      })
      .input(ChannelRef)
      .output(D.Channel),
    update: owner
      .meta({ access: "owner", scopes: ["channel:manage"] })
      .route({
        method: "PATCH",
        path: "/channels/{channel}",
        summary: "Update channel info and theme",
        ...tag("Channels"),
      })
      .input(ChannelRef.extend(ChannelUpdate.shape))
      .output(D.Channel),
    setPanels: owner
      .meta({ access: "owner", scopes: ["channel:manage"] })
      .route({
        method: "PUT",
        path: "/channels/{channel}/panels",
        summary: "Replace the channel's panels",
        ...tag("Channels"),
      })
      .input(
        ChannelRef.extend({
          panels: z
            .array(
              z.object({
                title: z.string().max(60),
                body: z.string().max(5000),
                imageKey: z.string().nullable(),
                linkUrl: z.url().nullable(),
              }),
            )
            .max(20),
        }),
      )
      .output(z.array(D.Panel)),
    uploadUrl: owner
      .route({
        method: "POST",
        path: "/channels/{channel}/uploads",
        summary: "Presigned upload for avatar, banner, panel image, emote or alert asset",
        ...tag("Channels"),
      })
      .input(
        ChannelRef.extend({
          purpose: z.enum(UPLOAD_PURPOSES),
          contentType: z.enum(UPLOAD_CONTENT_TYPES),
          sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
        }),
      )
      .output(
        z.object({
          key: z.string(),
          uploadUrl: z.string(),
          headers: z.record(z.string(), z.string()),
          expiresAt: Timestamp,
        }),
      ),
    commitUpload: owner
      .route({
        method: "POST",
        path: "/channels/{channel}/uploads/commit",
        summary: "Scan an uploaded file and publish it (required before the key can be used)",
        description:
          "The presigned PUT lands in an unpublished incoming prefix. Commit runs the hash matcher and the classifier on images, then copies the object to its public key. Every rejection has the same response.",
        ...tag("Channels"),
      })
      .errors(UPLOAD_REJECTED)
      .input(ChannelRef.extend({ key: z.string().min(1).max(300) }))
      .output(z.object({ key: z.string(), url: z.string() })),
    follow: user
      .meta({ access: "user", scopes: ["user:manage:follows"] })
      .route({
        method: "PUT",
        path: "/channels/{channel}/follow",
        summary: "Follow a channel",
        ...tag("Follows"),
      })
      .input(ChannelRef.extend({ notify: z.boolean().default(true) }))
      .output(z.object({ following: z.literal(true), followerCount: z.number().int() })),
    unfollow: user
      .meta({ access: "user", scopes: ["user:manage:follows"] })
      .route({
        method: "DELETE",
        path: "/channels/{channel}/follow",
        summary: "Unfollow a channel",
        ...tag("Follows"),
      })
      .input(ChannelRef)
      .output(z.object({ following: z.literal(false), followerCount: z.number().int() })),
    followers: owner
      .route({
        method: "GET",
        path: "/channels/{channel}/followers",
        summary: "Followers (owner only)",
        ...tag("Follows"),
      })
      .input(ChannelRef.extend(PageInput.shape))
      .output(page(z.object({ user: D.UserPublic, followedAt: Timestamp, excluded: z.boolean() }))),
    roles: {
      list: mod
        .route({
          method: "GET",
          path: "/channels/{channel}/roles",
          summary: "Moderators, VIPs and editors",
          ...tag("Moderation"),
        })
        .input(ChannelRef)
        .output(z.array(z.object({ user: D.UserPublic, role: z.enum(E.CHANNEL_ROLES), grantedAt: Timestamp }))),
      grant: owner
        .route({
          method: "PUT",
          path: "/channels/{channel}/roles/{username}",
          summary: "Grant a channel role",
          ...tag("Moderation"),
        })
        .input(ChannelRef.extend({ username: Slug, role: z.enum(E.CHANNEL_ROLES) }))
        .output(Ok),
      revoke: owner
        .route({
          method: "DELETE",
          path: "/channels/{channel}/roles/{username}",
          summary: "Revoke a channel role",
          ...tag("Moderation"),
        })
        .input(ChannelRef.extend({ username: Slug, role: z.enum(E.CHANNEL_ROLES) }))
        .output(Ok),
    },
  },

  stream: {
    ingest: owner
      .route({
        method: "GET",
        path: "/channels/{channel}/ingest",
        summary: "Ingest URLs and recommended encoder settings",
        ...tag("Streaming"),
      })
      .input(ChannelRef)
      .output(D.IngestInfo),
    obsConfig: owner
      .route({
        method: "GET",
        path: "/channels/{channel}/ingest/obs-service.json",
        summary: "Downloadable OBS service configuration",
        ...tag("Streaming"),
      })
      .input(ChannelRef)
      .output(z.object({ filename: z.string(), json: z.string() })),
    keys: owner
      .route({
        method: "GET",
        path: "/channels/{channel}/stream-keys",
        summary: "Stream keys (prefixes only)",
        ...tag("Streaming"),
      })
      .input(ChannelRef)
      .output(z.array(D.StreamKey)),
    rotateKey: owner
      .meta({ access: "owner", rateLimit: "write" })
      .route({
        method: "POST",
        path: "/channels/{channel}/stream-keys",
        summary: "Create a new stream key and revoke the old one",
        ...tag("Streaming"),
      })
      .input(ChannelRef)
      .output(D.StreamKeyCreated),
    health: owner
      .route({
        method: "GET",
        path: "/channels/{channel}/health",
        summary: "Live stream health (bitrate, dropped frames, keyframes, warnings)",
        ...tag("Streaming"),
      })
      .input(ChannelRef)
      .output(D.StreamHealth),
    simulcast: {
      list: owner
        .route({
          method: "GET",
          path: "/channels/{channel}/simulcast",
          summary: "Simulcast targets with status",
          ...tag("Streaming"),
        })
        .input(ChannelRef)
        .output(z.array(D.SimulcastTarget)),
      create: owner
        .route({
          method: "POST",
          path: "/channels/{channel}/simulcast",
          summary: "Add a simulcast target",
          ...tag("Streaming"),
        })
        .input(
          ChannelRef.extend({
            platform: z.enum(E.SIMULCAST_PLATFORMS),
            name: z.string().min(1).max(40),
            rtmpUrl: z.string().regex(/^rtmps?:\/\//),
            streamKey: z.string().min(1).max(256),
            enabled: z.boolean().default(true),
          }),
        )
        .output(D.SimulcastTarget),
      update: owner
        .route({
          method: "PATCH",
          path: "/channels/{channel}/simulcast/{id}",
          summary: "Enable, disable or rename a target",
          ...tag("Streaming"),
        })
        .input(
          ChannelRef.extend({
            id: Id,
            name: z.string().min(1).max(40).optional(),
            enabled: z.boolean().optional(),
            streamKey: z.string().min(1).max(256).optional(),
          }),
        )
        .output(D.SimulcastTarget),
      remove: owner
        .route({
          method: "DELETE",
          path: "/channels/{channel}/simulcast/{id}",
          summary: "Remove a target",
          ...tag("Streaming"),
        })
        .input(ChannelRef.extend({ id: Id }))
        .output(Ok),
    },
  },

  playback: {
    // Viewers are anonymous and many share an address (carrier-grade NAT, a campus, one load
    // generator), so playback has its own per-address bucket instead of `default`.
    start: base
      .meta({ access: "public", rateLimit: "playback" })
      .errors(MATURE_GATE)
      .route({
        method: "POST",
        path: "/channels/{channel}/playback",
        summary: "Start a playback session and get a signed playlist URL",
        ...tag("Playback"),
      })
      .input(
        ChannelRef.extend({
          deviceId: z.string().min(16).max(64),
          embed: z.boolean().default(false),
          /**
           * The player's P2P opt-in (ADR 0005 amendment 1): true only when the viewer chose P2P, or
           * has not chosen and the operator default (`instance.info` `features.p2pDefault`) is on.
           * Omitted means no P2P, so an old or third-party client never gets a tracker URL.
           */
          p2pCapable: z.boolean().default(false),
          nativeHls: z.boolean().default(false),
          /** ADR 0018: the data-mode ceiling in bit/s, null or absent = off. */
          dataMode: z
            .number()
            .int()
            .min(E.DATA_MODE.minCeilingBps)
            .max(E.DATA_MODE.maxCeilingBps)
            .nullable()
            .default(null),
        }),
      )
      .output(D.PlaybackStart),
    heartbeat: base
      .meta({ access: "public", rateLimit: "playback" })
      .route({
        method: "POST",
        path: "/playback/heartbeat",
        summary: "Report playback stats (drives verified viewer counts)",
        ...tag("Playback"),
      })
      .input(D.Heartbeat)
      .output(
        z.object({
          ok: z.literal(true),
          token: z.string().optional(),
          switchTo: z.string().optional(),
          /**
           * The beat came sooner than the server's floor and was ignored (nothing recorded).
           * Clients keep accumulating their counters and send them with the next beat.
           */
          throttled: z.boolean().optional(),
        }),
      ),
    end: base
      .meta({ access: "public", rateLimit: "playback" })
      .route({
        method: "POST",
        path: "/playback/end",
        summary: "End a playback session",
        ...tag("Playback"),
      })
      .input(z.object({ sessionId: Id, token: z.string() }))
      .output(Ok),
  },

  p2p: {
    iceServers: base
      .meta({ access: "public", rateLimit: "playback" })
      .route({
        method: "POST",
        path: "/playback/ice-servers",
        summary: "ICE servers and time-limited TURN credentials for a P2P playback session",
        description:
          "Only for a session that holds a P2P grant (`playback.start` returned `p2p.enabled`). Refusals as `playback.heartbeat`: UNAUTHORIZED for a bad token or one for another session, NOT_FOUND for an unknown session, CONFLICT for an ended one; PRECONDITION_FAILED (`requirement: p2p`) for a session without a grant. STUN only unless the operator turned the TURN relay on; TURN credentials are TURN REST credentials that expire at `expiresAt`.",
        ...tag("Playback"),
      })
      .input(z.object({ sessionId: Id, token: z.string() }))
      .output(D.IceServers),
  },

  vods: {
    list: base
      .route({
        method: "GET",
        path: "/channels/{channel}/vods",
        summary: "Past broadcasts",
        ...tag("VODs"),
      })
      .input(ChannelRef.extend(PageInput.shape))
      .output(page(D.Vod)),
    get: base
      .route({ method: "GET", path: "/vods/{id}", summary: "One VOD", ...tag("VODs") })
      .input(z.object({ id: Id }))
      .output(D.Vod),
    update: owner
      .route({
        method: "PATCH",
        path: "/vods/{id}",
        summary: "Rename or change visibility",
        ...tag("VODs"),
      })
      .input(
        z.object({
          id: Id,
          title: z.string().max(140).optional(),
          visibility: z.enum(E.VISIBILITIES).optional(),
        }),
      )
      .output(D.Vod),
    remove: owner
      .route({ method: "DELETE", path: "/vods/{id}", summary: "Delete a VOD", ...tag("VODs") })
      .input(z.object({ id: Id }))
      .output(Ok),
    /** ADR 0012 amendment 1 decisions 5 and 7: the broadcast's chat in media-time order; served exactly when the VOD is playable to the caller; filtered per viewer (blocks), never shared-cached. */
    chat: base
      .route({ method: "GET", path: "/vods/{id}/chat", summary: "Chat replay for a VOD", ...tag("VODs") })
      .input(ChatReplayInput)
      .output(D.ChatReplayPage),
  },

  clips: {
    create: user
      .meta({ access: "user", scopes: ["clips:edit"], rateLimit: "write" })
      .route({
        method: "POST",
        path: "/channels/{channel}/clips",
        summary: "Clip the last seconds of a live stream or a VOD range",
        ...tag("Clips"),
      })
      .input(
        ChannelRef.extend({
          title: z.string().min(1).max(100),
          vodId: Id.optional(),
          startOffset: z.number().min(0).optional(),
          durationSeconds: z.number().min(5).max(60).default(30),
        }),
      )
      .output(D.Clip),
    list: base
      .route({
        method: "GET",
        path: "/channels/{channel}/clips",
        summary: "A channel's clips",
        ...tag("Clips"),
      })
      .input(
        ChannelRef.extend(PageInput.shape).extend({
          sort: z.enum(["recent", "top"]).default("recent"),
        }),
      )
      .output(page(D.Clip)),
    get: base
      .route({ method: "GET", path: "/clips/{id}", summary: "One clip", ...tag("Clips") })
      .input(z.object({ id: Id }))
      .output(D.Clip),
    remove: mod
      .route({
        method: "DELETE",
        path: "/clips/{id}",
        summary: "Delete a clip (creator, owner or moderator)",
        ...tag("Clips"),
      })
      .input(z.object({ id: Id }))
      .output(Ok),
    /** As `vods.chat`, for the wall-clock window the clip was cut from. */
    chat: base
      .route({
        method: "GET",
        path: "/clips/{id}/chat",
        summary: "Chat replay for a clip (the wall-clock window it was cut from)",
        ...tag("Clips"),
      })
      .input(ChatReplayInput)
      .output(D.ChatReplayPage),
  },

  chat: {
    history: base
      .route({
        method: "GET",
        path: "/channels/{channel}/chat/messages",
        summary: "Recent chat (for late joiners)",
        ...tag("Chat"),
      })
      .input(
        ChannelRef.extend({
          limit: z.number().int().min(1).max(200).default(50),
          before: Timestamp.optional(),
        }),
      )
      .output(z.array(D.ChatMessage)),
    send: user
      .meta({ access: "user", scopes: ["chat:edit"], rateLimit: "chat" })
      .route({
        method: "POST",
        path: "/channels/{channel}/chat/messages",
        summary: "Send a chat message (REST alternative to the WebSocket)",
        ...tag("Chat"),
      })
      .input(ChannelRef.extend({ body: z.string().min(1).max(500), replyToId: Id.optional() }))
      .output(z.object({ id: Id, held: z.boolean(), dropReason: z.string().nullable() })),
    deleteMessage: mod
      .meta({ access: "moderator", scopes: ["moderator:manage:chat"] })
      .route({
        method: "DELETE",
        path: "/channels/{channel}/chat/messages/{id}",
        summary: "Delete a message",
        ...tag("Moderation"),
      })
      .input(ChannelRef.extend({ id: Id }))
      .output(Ok),
    clear: mod
      .meta({ access: "moderator", scopes: ["moderator:manage:chat"] })
      .route({
        method: "POST",
        path: "/channels/{channel}/chat/clear",
        summary: "Clear chat",
        ...tag("Moderation"),
      })
      .input(ChannelRef)
      .output(Ok),
    settings: base
      .route({
        method: "GET",
        path: "/channels/{channel}/chat/settings",
        summary: "Chat modes",
        ...tag("Chat"),
      })
      .input(ChannelRef)
      .output(D.ChatSettings),
    updateSettings: mod
      .meta({ access: "moderator", scopes: ["moderator:manage:chat"] })
      .route({
        method: "PATCH",
        path: "/channels/{channel}/chat/settings",
        summary: "Change chat modes (slow, followers-only, subscribers-only, emote-only)",
        ...tag("Moderation"),
      })
      .input(ChannelRef.extend(ChannelChatSettingsPatch.shape))
      .output(D.ChatSettings),
    bans: {
      list: mod
        .route({
          method: "GET",
          path: "/channels/{channel}/bans",
          summary: "Active bans and timeouts",
          ...tag("Moderation"),
        })
        .input(ChannelRef.extend(PageInput.shape))
        .output(page(D.Ban)),
      ban: mod
        .meta({ access: "moderator", scopes: ["moderator:manage:chat"] })
        .route({
          method: "POST",
          path: "/channels/{channel}/bans",
          summary: "Ban or time out a user",
          ...tag("Moderation"),
        })
        .input(
          ChannelRef.extend({
            username: Slug,
            reason: z.string().max(500).default(""),
            durationSeconds: z.number().int().min(1).max(1_209_600).optional().describe("Omit for a permanent ban"),
          }),
        )
        .output(D.Ban),
      unban: mod
        .meta({ access: "moderator", scopes: ["moderator:manage:chat"] })
        .route({
          method: "DELETE",
          path: "/channels/{channel}/bans/{username}",
          summary: "Lift a ban or timeout",
          ...tag("Moderation"),
        })
        .input(ChannelRef.extend({ username: Slug }))
        .output(Ok),
    },
    filters: {
      list: mod
        .route({
          method: "GET",
          path: "/channels/{channel}/word-filters",
          summary: "Word filters",
          ...tag("Moderation"),
        })
        .input(ChannelRef)
        .output(z.array(D.WordFilter)),
      create: mod
        .route({
          method: "POST",
          path: "/channels/{channel}/word-filters",
          summary: "Add a word filter",
          ...tag("Moderation"),
        })
        .input(
          ChannelRef.extend({
            pattern: z.string().min(1).max(200),
            isRegex: z.boolean().default(false),
            action: z.enum(E.WORD_FILTER_ACTIONS).default("block"),
            replacement: z.string().max(50).nullable().default(null),
          }),
        )
        .output(D.WordFilter),
      remove: mod
        .route({
          method: "DELETE",
          path: "/channels/{channel}/word-filters/{id}",
          summary: "Remove a word filter",
          ...tag("Moderation"),
        })
        .input(ChannelRef.extend({ id: Id }))
        .output(Ok),
    },
    held: {
      list: mod
        .route({
          method: "GET",
          path: "/channels/{channel}/chat/held",
          summary: "Messages held by filters",
          ...tag("Moderation"),
        })
        .input(ChannelRef)
        .output(z.array(D.ChatMessage)),
      resolve: mod
        .route({
          method: "POST",
          path: "/channels/{channel}/chat/held/{id}",
          summary: "Allow or deny a held message",
          ...tag("Moderation"),
        })
        .input(ChannelRef.extend({ id: Id, allow: z.boolean() }))
        .output(Ok),
    },
    emotes: {
      list: base
        .route({
          method: "GET",
          path: "/channels/{channel}/emotes",
          summary: "Global and channel emotes",
          ...tag("Chat"),
        })
        .input(ChannelRef)
        .output(z.array(D.Emote)),
      create: owner
        .route({
          method: "POST",
          path: "/channels/{channel}/emotes",
          summary: "Add a channel emote from an uploaded image",
          ...tag("Chat"),
        })
        .input(
          ChannelRef.extend({
            code: z.string().regex(/^[A-Za-z0-9]{2,20}$/),
            imageKey: z.string(),
            tier: z.number().int().min(0).max(3).default(0),
          }),
        )
        .output(D.Emote),
      remove: owner
        .route({
          method: "DELETE",
          path: "/channels/{channel}/emotes/{id}",
          summary: "Remove an emote",
          ...tag("Chat"),
        })
        .input(ChannelRef.extend({ id: Id }))
        .output(Ok),
    },
    /** Short-lived token the browser presents to the chat WebSocket. */
    connectToken: base
      .route({
        method: "POST",
        path: "/chat/token",
        summary: "Token for the chat WebSocket (anonymous read-only if signed out)",
        ...tag("Chat"),
      })
      .output(z.object({ token: z.string(), url: z.string(), expiresAt: Timestamp })),
    surge: {
      state: mod
        .meta({ access: "moderator", scopes: ["moderator:manage:chat"] })
        .route({
          method: "GET",
          path: "/channels/{channel}/chat/surge",
          summary: "Surge-guard state",
          ...tag("Moderation"),
        })
        .input(ChannelRef)
        .output(D.SurgeState),
      /** ADR 0015 decision 6: one click; `end` writes `suppressed` for the cooldown. Audited, with an outbox event. */
      override: mod
        .meta({ access: "moderator", scopes: ["moderator:manage:chat"], rateLimit: "write" })
        .route({
          method: "POST",
          path: "/channels/{channel}/chat/surge",
          summary: "Start or end surge mode by hand",
          ...tag("Moderation"),
        })
        .input(ChannelRef.extend({ action: z.enum(["start", "end"]) }))
        .output(D.SurgeState),
    },
  },

  money: {
    support: base
      .route({
        method: "GET",
        path: "/channels/{channel}/support",
        summary: "Tiers, split, limits and the caller's subscription for the Support dialog",
        ...tag("Monetization"),
      })
      .input(ChannelRef)
      .output(D.SupportInfo),
    tiers: base
      .route({
        method: "GET",
        path: "/channels/{channel}/subscription-tiers",
        summary: "Subscription tiers and prices",
        ...tag("Monetization"),
      })
      .input(ChannelRef)
      .output(z.array(D.SubTierInfo)),
    setTiers: owner
      .route({
        method: "PUT",
        path: "/channels/{channel}/subscription-tiers",
        summary: "Set tier names, prices and benefits",
        ...tag("Monetization"),
      })
      .input(
        ChannelRef.extend({
          tiers: z
            .array(
              D.SubTierInfo.extend({
                price: Money.extend({
                  cents: z.number().int().min(MONEY_LIMITS.tierMinCents).max(MONEY_LIMITS.tierMaxCents),
                }),
              }),
            )
            .length(3),
        }),
      )
      .output(z.array(D.SubTierInfo)),
    subscribe: user
      .meta({ access: "user", rateLimit: "write" })
      .route({
        method: "POST",
        path: "/channels/{channel}/subscriptions",
        summary: "Start a subscription checkout",
        ...tag("Monetization"),
      })
      .input(
        ChannelRef.extend({
          tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
          /**
           * Gift subs instead of subscribing yourself. Without `to`, recipients are drawn at random
           * from the channel's community (recent chatters and followers with no subscription).
           * `to` names one recipient and needs `count: 1`.
           */
          gift: z
            .object({ count: z.number().int().min(1).max(MONEY_LIMITS.giftMaxCount), to: Slug.optional() })
            .refine((g) => g.to === undefined || g.count === 1, {
              message: "A named recipient gets exactly one gift",
              path: ["count"],
            })
            .optional(),
          returnPath: ReturnPath,
        }),
      )
      .output(D.CheckoutResult),
    mySubscriptions: user
      .route({
        method: "GET",
        path: "/me/subscriptions",
        summary: "Your subscriptions",
        ...tag("Monetization"),
      })
      .output(z.array(D.Subscription)),
    cancelSubscription: user
      .route({
        method: "POST",
        path: "/me/subscriptions/{id}/cancel",
        summary: "Cancel at the end of the period",
        ...tag("Monetization"),
      })
      .input(z.object({ id: Id }))
      .output(D.Subscription),
    tip: user
      .meta({ access: "user", rateLimit: "write" })
      .route({
        method: "POST",
        path: "/channels/{channel}/tips",
        summary: "Start a tip checkout",
        ...tag("Monetization"),
      })
      .input(
        ChannelRef.extend({
          amountCents: z.number().int().min(MONEY_LIMITS.tipMinCents).max(MONEY_LIMITS.tipMaxCents),
          message: z.string().max(MONEY_LIMITS.tipMessageMaxLength).default(""),
          anonymous: z.boolean().default(false),
          returnPath: ReturnPath,
        }),
      )
      .output(D.CheckoutResult),
    subscribers: owner
      .meta({ access: "owner", scopes: ["channel:read:subscriptions"] })
      .route({
        method: "GET",
        path: "/channels/{channel}/subscriptions",
        summary: "Subscribers",
        ...tag("Monetization"),
      })
      .input(ChannelRef.extend(PageInput.shape))
      .output(page(D.Subscription)),
    tips: owner
      .meta({ access: "owner", scopes: ["channel:read:tips"] })
      .route({
        method: "GET",
        path: "/channels/{channel}/tips",
        summary: "Tips received",
        ...tag("Monetization"),
      })
      .input(ChannelRef.extend(PageInput.shape))
      .output(page(D.Tip)),
    revenue: owner
      .route({
        method: "GET",
        path: "/channels/{channel}/revenue",
        summary: "Revenue dashboard",
        ...tag("Monetization"),
      })
      .input(ChannelRef.extend({ from: Timestamp.optional(), to: Timestamp.optional() }))
      .output(D.RevenueSummary),
    revenueLedger: owner
      .route({
        method: "GET",
        path: "/channels/{channel}/revenue/ledger",
        summary: "Revenue ledger: one row per payment, reversal and payout, newest first",
        ...tag("Monetization"),
      })
      .input(ChannelRef.extend(PageInput.shape).extend({ from: Timestamp.optional(), to: Timestamp.optional() }))
      .output(page(D.RevenueLine)),
    payouts: user
      .route({
        method: "GET",
        path: "/me/payouts",
        summary: "Your payouts",
        ...tag("Monetization"),
      })
      .output(z.array(D.Payout)),
    payoutAccount: user
      .route({
        method: "GET",
        path: "/me/payout-account",
        summary: "Payout account status",
        ...tag("Monetization"),
      })
      .output(
        z.object({
          provider: z.enum(E.PAYMENT_PROVIDERS),
          payoutsEnabled: z.boolean(),
          onboardingUrl: z.string().nullable(),
          instructions: z.string().nullable(),
        }),
      ),
    statement: user
      .route({
        method: "GET",
        path: "/me/ledger",
        summary: "Your ledger lines (earnings, payouts, clawbacks)",
        ...tag("Monetization"),
      })
      .input(PageInput)
      .output(page(D.LedgerLine)),
    /** feature-wins §4.1. The payer, or the owner of the payee channel; anything else is NOT_FOUND (ids are time-ordered, so authorization is the guard). */
    paymentBreakdown: user
      .route({
        method: "GET",
        path: "/payments/{paymentId}/breakdown",
        summary: "Where one payment's money went",
        ...tag("Monetization"),
      })
      .input(z.object({ paymentId: Id }))
      .output(D.PaymentBreakdown),
    paymentBreakdowns: user
      .route({
        method: "GET",
        path: "/me/payment-breakdowns",
        summary: "Breakdowns of your payments, or of payments to your channel",
        ...tag("Monetization"),
      })
      .input(PageInput.extend({ role: z.enum(["payer", "payee"]).default("payer") }))
      .output(page(D.PaymentBreakdown)),
    /** Manual adapter: the treasurer records offline payments, refunds and payouts. */
    treasurer: {
      payments: treasurer
        .route({
          method: "GET",
          path: "/treasurer/payments",
          summary: "Payments by status (default: awaiting offline confirmation), or by reference",
          ...tag("Treasury"),
        })
        .input(
          PageInput.extend({
            status: z.enum(E.PAYMENT_STATUSES).default("pending"),
            /** A payment reference (normalized like `normalizeManualReference`); ignores `status`. */
            reference: z.string().max(64).optional(),
          }),
        )
        .output(page(D.TreasurerPayment)),
      confirm: treasurer
        .route({
          method: "POST",
          path: "/treasurer/payments/{paymentId}/confirm",
          summary: "Confirm an offline payment was received",
          ...tag("Treasury"),
        })
        .input(z.object({ paymentId: Id, receivedAt: Timestamp, note: z.string().max(500).default("") }))
        .output(Ok),
      refund: treasurer
        .route({
          method: "POST",
          path: "/treasurer/payments/{paymentId}/refund",
          summary: "Record a refund",
          ...tag("Treasury"),
        })
        .input(
          z.object({
            paymentId: Id,
            amountCents: z.number().int().positive(),
            reason: z.string().max(500),
          }),
        )
        .output(Ok),
      chargeback: treasurer
        .route({
          method: "POST",
          path: "/treasurer/payments/{paymentId}/chargeback",
          summary: "Record a chargeback (claws back from pending payouts)",
          ...tag("Treasury"),
        })
        .input(
          z.object({
            paymentId: Id,
            amountCents: z.number().int().positive(),
            reason: z.string().max(500),
          }),
        )
        .output(Ok),
      runPayouts: treasurer
        .route({
          method: "POST",
          path: "/treasurer/payouts/run",
          summary: "Compute the monthly payout batch",
          ...tag("Treasury"),
        })
        .input(z.object({ periodEnd: Timestamp }))
        .output(z.object({ created: z.number().int(), held: z.number().int(), total: Money })),
      payouts: treasurer
        .route({
          method: "GET",
          path: "/treasurer/payouts",
          summary: "Payouts by status",
          ...tag("Treasury"),
        })
        .input(PageInput.extend({ status: z.enum(E.PAYOUT_STATUSES).optional() }))
        .output(page(D.TreasurerPayout)),
      setPayoutAccount: treasurer
        .route({
          method: "PUT",
          path: "/treasurer/payout-accounts/{username}",
          summary: "Manual adapter: record how a creator is paid and enable payouts",
          ...tag("Treasury"),
        })
        .input(
          z.object({
            username: Slug,
            payoutsEnabled: z.boolean(),
            /** The treasurer's own reference for the arrangement (never bank details). */
            reference: z.string().max(200),
          }),
        )
        .output(Ok),
      markPaid: treasurer
        .route({
          method: "POST",
          path: "/treasurer/payouts/{id}/paid",
          summary: "Record that a payout was sent",
          ...tag("Treasury"),
        })
        .input(z.object({ id: Id, reference: z.string().max(200) }))
        .output(Ok),
      recordCost: treasurer
        .route({
          method: "POST",
          path: "/treasurer/costs",
          summary: "Record an infrastructure cost",
          ...tag("Treasury"),
        })
        .input(
          z.object({
            periodStart: Timestamp,
            periodEnd: Timestamp,
            category: z.string().min(1).max(40),
            description: z.string().max(200),
            amountCents: z.number().int().positive(),
          }),
        )
        .output(Ok),
      fraudFlags: {
        list: treasurer
          .route({ method: "GET", path: "/treasurer/fraud-flags", summary: "Payment fraud flags", ...tag("Treasury") })
          .input(PageInput.extend({ status: z.enum(E.PAYMENT_FRAUD_STATUSES).optional() }))
          .output(page(D.PaymentFraudFlag)),
        raise: treasurer
          .route({
            method: "POST",
            path: "/treasurer/fraud-flags",
            summary: "Hold a payee's payouts for fraud review",
            ...tag("Treasury"),
          })
          .input(z.object({ username: Slug, note: z.string().max(500).default("") }))
          .output(D.PaymentFraudFlag),
        review: treasurer
          .route({
            method: "POST",
            path: "/treasurer/fraud-flags/{id}/review",
            summary: "First review: recommend clearing or confirming",
            ...tag("Treasury"),
          })
          .input(
            z.object({
              id: Id,
              recommendation: z.enum(E.PAYMENT_FRAUD_DECISIONS),
              note: z.string().max(500).default(""),
            }),
          )
          .output(D.PaymentFraudFlag),
        /** Four eyes: a different treasurer, or an admin, than the reviewer (database-enforced). Clearing releases the payee's fraud holds when no other flag is open. */
        decide: finance
          .route({
            method: "POST",
            path: "/treasurer/fraud-flags/{id}/decide",
            summary: "Second review: clear or confirm",
            ...tag("Treasury"),
          })
          .errors(SECOND_APPROVER)
          .input(
            z.object({ id: Id, decision: z.enum(E.PAYMENT_FRAUD_DECISIONS), note: z.string().max(500).default("") }),
          )
          .output(D.PaymentFraudFlag),
        /** ADR 0036 decision 3: an admin's audited account action, the only release of a confirmed flag (database-enforced: admin, not the payee, once). Releases the payee's fraud holds when no other flag holds. */
        release: admin
          .route({
            method: "POST",
            path: "/treasurer/fraud-flags/{id}/release",
            summary: "Admin: release the payouts a confirmed fraud flag holds",
            ...tag("Treasury"),
          })
          .input(z.object({ id: Id }))
          .output(D.PaymentFraudFlag),
      },
    },
  },

  developer: {
    apps: {
      list: user
        .route({
          method: "GET",
          path: "/developer/apps",
          summary: "Your OAuth apps",
          ...tag("Developers"),
        })
        .output(z.array(D.OAuthApp)),
      create: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/developer/apps",
          summary: "Register an OAuth app",
          ...tag("Developers"),
        })
        .input(
          z.object({
            name: z.string().min(1).max(50),
            description: z.string().max(500).default(""),
            redirectUris: z.array(RedirectUri).min(1).max(OAUTH_LIMITS.redirectUrisPerApp),
            confidential: z.boolean().default(true),
          }),
        )
        .output(z.object({ app: D.OAuthApp, secret: D.OAuthAppSecret.nullable() })),
      update: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "PATCH",
          path: "/developer/apps/{id}",
          summary: "Update an app",
          ...tag("Developers"),
        })
        .input(
          z.object({
            id: Id,
            name: z.string().min(1).max(50).optional(),
            description: z.string().max(500).optional(),
            redirectUris: z.array(RedirectUri).min(1).max(OAUTH_LIMITS.redirectUrisPerApp).optional(),
          }),
        )
        .output(D.OAuthApp),
      rotateSecret: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/developer/apps/{id}/secret",
          summary: "Rotate the client secret",
          ...tag("Developers"),
        })
        .input(z.object({ id: Id }))
        .output(D.OAuthAppSecret),
      remove: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "DELETE",
          path: "/developer/apps/{id}",
          summary: "Delete an app and revoke its tokens",
          ...tag("Developers"),
        })
        .input(z.object({ id: Id }))
        .output(Ok),
    },
    tokens: {
      list: user
        .route({
          method: "GET",
          path: "/developer/tokens",
          summary: "Tokens authorized on your account",
          ...tag("Developers"),
        })
        .output(z.array(D.AccessToken)),
      revoke: user
        .route({
          method: "DELETE",
          path: "/developer/tokens/{id}",
          summary: "Revoke a token",
          ...tag("Developers"),
        })
        .input(z.object({ id: Id }))
        .output(Ok),
      validate: base
        .route({
          method: "GET",
          path: "/oauth2/validate",
          summary: "Validate the bearer token (Twitch-compatible shape)",
          ...tag("OAuth"),
        })
        .output(
          z.object({
            client_id: z.string().nullable(),
            login: Slug.nullable(),
            user_id: Id.nullable(),
            scopes: z.array(z.string()),
            expires_in: z.number().int(),
          }),
        ),
    },
    events: {
      catalog: base
        .route({
          method: "GET",
          path: "/eventsub/types",
          summary: "Event types, versions, conditions and required scopes",
          ...tag("Events"),
        })
        .output(
          z.array(
            z.object({
              type: z.enum(PUBLIC_EVENT_TYPES),
              version: z.string(),
              condition: z.array(z.string()),
              scopes: z.array(z.string()),
              transports: z.array(z.enum(E.EVENT_TRANSPORTS)),
              description: z.string(),
            }),
          ),
        ),
      subscribe: user
        .meta({ access: "user", scopes: [], appTokens: true, rateLimit: "write" })
        .route({
          method: "POST",
          path: "/eventsub/subscriptions",
          summary: "Create an event subscription (webhook or WebSocket)",
          ...tag("Events"),
        })
        .input(
          z.object({
            type: z.enum(PUBLIC_EVENT_TYPES),
            version: z.string().default("1"),
            condition: z
              .record(z.string().max(64), z.string().max(128))
              .refine((c) => Object.keys(c).length <= 8, "at most 8 condition fields"),
            transport: z.discriminatedUnion("method", [
              z.object({
                method: z.literal("webhook"),
                callback: z.url(),
                secret: z.string().min(10).max(100),
              }),
              z.object({ method: z.literal("websocket"), sessionId: z.string().max(64) }),
            ]),
            appId: Id.optional().describe("Session callers only: subscribe for an app you own"),
          }),
        )
        .output(D.EventSubscription),
      list: user
        .meta({ access: "user", scopes: [], appTokens: true })
        .route({
          method: "GET",
          path: "/eventsub/subscriptions",
          summary: "Your event subscriptions",
          ...tag("Events"),
        })
        .input(
          PageInput.extend({
            type: z.enum(PUBLIC_EVENT_TYPES).optional(),
            status: z.enum(E.SUBSCRIPTION_STATES).optional(),
            appId: Id.optional(),
          }),
        )
        .output(page(D.EventSubscription)),
      unsubscribe: user
        .meta({ access: "user", scopes: [], appTokens: true })
        .route({
          method: "DELETE",
          path: "/eventsub/subscriptions/{id}",
          summary: "Delete a subscription",
          ...tag("Events"),
        })
        .input(z.object({ id: Id }))
        .output(Ok),
      deliveries: user
        .meta({ access: "user", scopes: [], appTokens: true })
        .route({
          method: "GET",
          path: "/eventsub/subscriptions/{id}/deliveries",
          summary: "Webhook delivery log",
          ...tag("Events"),
        })
        .input(z.object({ id: Id }).extend(PageInput.shape))
        .output(page(D.WebhookDelivery)),
      sendTest: user
        .meta({ access: "user", scopes: [], appTokens: true, rateLimit: "write" })
        .route({
          method: "POST",
          path: "/eventsub/subscriptions/{id}/test",
          summary: "Send a test event to a subscription",
          ...tag("Events"),
        })
        .input(z.object({ id: Id }))
        .output(z.object({ eventId: Id })),
      redeliver: user
        .meta({ access: "user", scopes: [], appTokens: true, rateLimit: "write" })
        .route({
          method: "POST",
          path: "/eventsub/deliveries/{id}/redeliver",
          summary: "Retry a failed delivery",
          ...tag("Events"),
        })
        .input(z.object({ id: Id }))
        .output(Ok),
    },
    oauth: {
      /** Validates an authorization request for the consent page (never redirects by itself). */
      request: user
        .route({
          method: "GET",
          path: "/oauth2/authorize/request",
          summary: "Check an authorization request",
          ...tag("OAuth"),
        })
        .input(
          z.object({
            clientId: z.string().min(1).max(64),
            redirectUri: z.string().min(1).max(2000),
            // Loose on purpose: once the redirect URI is valid, problems go back to the client (kind "redirect").
            responseType: z.string().max(40),
            scope: z.string().max(2000).default(""),
            state: z.string().max(OAUTH_LIMITS.stateMaxLength).optional(),
            codeChallenge: z.string().max(200).optional(),
            codeChallengeMethod: z.string().max(20).optional(),
            forceVerify: z.boolean().default(false),
          }),
        )
        .output(D.OAuthConsent),
      decide: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/oauth2/authorize",
          summary: "Approve or deny an authorization request",
          ...tag("OAuth"),
        })
        .input(
          z.object({
            clientId: z.string().min(1).max(64),
            redirectUri: z.string().min(1).max(2000),
            scope: z.string().max(2000).default(""),
            state: z.string().max(OAUTH_LIMITS.stateMaxLength).optional(),
            codeChallenge: z.string().regex(PKCE_CHALLENGE),
            codeChallengeMethod: z.literal("S256"),
            approve: z.boolean(),
          }),
        )
        .output(z.object({ redirectTo: z.string() })),
      // POST with the user code in the body, never in the path or query: a code in a URL reaches
      // access logs, and a logged code could be approved by someone else (decided 2026-10-29).
      activation: user
        .meta({ access: "user", rateLimit: "auth" })
        .route({
          method: "POST",
          path: "/oauth2/activate/lookup",
          summary: "Look up a device's user code",
          ...tag("OAuth"),
        })
        .input(z.object({ userCode: z.string().min(8).max(16) }))
        .output(D.OAuthDeviceConsent),
      activate: user
        .meta({ access: "user", rateLimit: "auth" })
        .route({
          method: "POST",
          path: "/oauth2/activate",
          summary: "Approve or deny a device",
          ...tag("OAuth"),
        })
        .input(z.object({ userCode: z.string().min(8).max(16), approve: z.boolean() }))
        .output(Ok),
    },
    grants: {
      list: user
        .route({
          method: "GET",
          path: "/me/authorizations",
          summary: "Apps you have authorized",
          ...tag("OAuth"),
        })
        .output(z.array(D.OAuthGrant)),
      revoke: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "DELETE",
          path: "/me/authorizations/{appId}",
          summary: "Revoke an app's access to your account",
          ...tag("OAuth"),
        })
        .input(z.object({ appId: Id }))
        .output(Ok),
    },
    admin: {
      list: admin
        .route({
          method: "GET",
          path: "/admin/apps",
          summary: "OAuth apps on this instance",
          ...tag("Developers"),
        })
        .input(PageInput.extend({ q: z.string().max(100).optional(), suspended: z.boolean().optional() }))
        .output(page(D.AdminOAuthApp)),
      suspend: admin
        .meta({ access: "admin", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/admin/apps/{id}/suspend",
          summary: "Suspend an app (revokes its tokens and subscriptions)",
          ...tag("Developers"),
        })
        .input(z.object({ id: Id, reason: z.enum(E.APP_SUSPENSION_REASONS) }))
        .output(D.AdminOAuthApp),
      unsuspend: admin
        .meta({ access: "admin", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/admin/apps/{id}/unsuspend",
          summary: "Lift an app's suspension (tokens stay revoked)",
          ...tag("Developers"),
        })
        .input(z.object({ id: Id }))
        .output(D.AdminOAuthApp),
    },
  },

  bot: {
    settings: owner
      .meta({ access: "owner", scopes: ["channel:manage:bot"] })
      .route({
        method: "GET",
        path: "/channels/{channel}/bot",
        summary: "Built-in channel bot settings",
        ...tag("Channel bot"),
      })
      .input(ChannelRef)
      .output(D.BotSettings),
    updateSettings: owner
      .meta({ access: "owner", scopes: ["channel:manage:bot"] })
      .route({
        method: "PUT",
        path: "/channels/{channel}/bot",
        summary: "Update channel bot settings",
        ...tag("Channel bot"),
      })
      .input(ChannelRef.extend({ enabled: z.boolean(), config: BotConfig }))
      .output(D.BotSettings),
    commands: {
      list: base
        .route({
          method: "GET",
          path: "/channels/{channel}/bot/commands",
          summary: "Custom commands",
          ...tag("Channel bot"),
        })
        .input(ChannelRef)
        .output(z.array(D.BotCommand)),
      upsert: mod
        .meta({ access: "moderator", scopes: ["channel:manage:bot"] })
        .route({
          method: "PUT",
          path: "/channels/{channel}/bot/commands/{name}",
          summary: "Create or update a command",
          ...tag("Channel bot"),
        })
        .input(ChannelRef.extend(D.BotCommand.omit({ id: true, useCount: true }).shape))
        .output(D.BotCommand),
      remove: mod
        .meta({ access: "moderator", scopes: ["channel:manage:bot"] })
        .route({
          method: "DELETE",
          path: "/channels/{channel}/bot/commands/{name}",
          summary: "Delete a command",
          ...tag("Channel bot"),
        })
        .input(ChannelRef.extend({ name: z.string() }))
        .output(Ok),
    },
    timers: {
      list: mod
        .route({
          method: "GET",
          path: "/channels/{channel}/bot/timers",
          summary: "Timers",
          ...tag("Channel bot"),
        })
        .input(ChannelRef)
        .output(z.array(D.BotTimer)),
      upsert: mod
        .meta({ access: "moderator", scopes: ["channel:manage:bot"] })
        .route({
          method: "PUT",
          path: "/channels/{channel}/bot/timers",
          summary: "Create or update a timer",
          ...tag("Channel bot"),
        })
        .input(ChannelRef.extend(D.BotTimer.partial({ id: true }).shape))
        .output(D.BotTimer),
      remove: mod
        .meta({ access: "moderator", scopes: ["channel:manage:bot"] })
        .route({
          method: "DELETE",
          path: "/channels/{channel}/bot/timers/{id}",
          summary: "Delete a timer",
          ...tag("Channel bot"),
        })
        .input(ChannelRef.extend({ id: Id }))
        .output(Ok),
    },
    variables: {
      list: mod
        .route({
          method: "GET",
          path: "/channels/{channel}/bot/variables",
          summary: "Command variables",
          ...tag("Channel bot"),
        })
        .input(ChannelRef)
        .output(z.array(z.object({ name: z.string(), value: z.string() }))),
      set: mod
        .meta({ access: "moderator", scopes: ["channel:manage:bot"] })
        .route({
          method: "PUT",
          path: "/channels/{channel}/bot/variables/{name}",
          summary: "Set a variable",
          ...tag("Channel bot"),
        })
        .input(
          ChannelRef.extend({
            name: z.string().regex(/^[a-z0-9_]{1,30}$/),
            value: z.string().max(500),
          }),
        )
        .output(Ok),
    },
    songRequests: {
      list: mod
        .route({
          method: "GET",
          path: "/channels/{channel}/bot/song-requests",
          summary: "Song request queue (links only; no playback)",
          ...tag("Channel bot"),
        })
        .input(ChannelRef.extend({ status: z.enum(E.SONG_REQUEST_STATUSES).optional() }))
        .output(z.array(D.SongRequest)),
      setStatus: mod
        .meta({ access: "moderator", scopes: ["channel:manage:bot"] })
        .route({
          method: "PUT",
          path: "/channels/{channel}/bot/song-requests/{id}",
          summary: "Mark a song request played or skipped",
          ...tag("Channel bot"),
        })
        .input(ChannelRef.extend({ id: Id, status: z.enum(["played", "skipped"]) }))
        .output(D.SongRequest),
    },
    points: {
      balance: base
        .route({
          method: "GET",
          path: "/channels/{channel}/points/{username}",
          summary: "A user's loyalty points",
          ...tag("Channel points"),
        })
        .input(ChannelRef.extend({ username: Slug }))
        .output(D.LoyaltyBalance),
      leaderboard: base
        .route({
          method: "GET",
          path: "/channels/{channel}/points",
          summary: "Top point holders",
          ...tag("Channel points"),
        })
        .input(ChannelRef.extend({ limit: z.number().int().min(1).max(100).default(10) }))
        .output(z.array(D.LoyaltyBalance)),
      adjust: mod
        .meta({ access: "moderator", scopes: ["channel:manage:points"] })
        .route({
          method: "POST",
          path: "/channels/{channel}/points/{username}",
          summary: "Grant or deduct points",
          ...tag("Channel points"),
        })
        .input(
          ChannelRef.extend({
            username: Slug,
            delta: z.number().int().min(-1_000_000).max(1_000_000),
            reason: z.enum(E.POINTS_ADJUST_REASONS),
          }),
        )
        .output(D.LoyaltyBalance),
    },
  },

  interact: {
    polls: {
      current: base
        .route({
          method: "GET",
          path: "/channels/{channel}/polls/current",
          summary: "Active or most recent poll",
          ...tag("Polls"),
        })
        .input(ChannelRef)
        .output(D.PollView.nullable()),
      create: mod
        .meta({ access: "moderator", scopes: ["channel:manage:polls"] })
        .route({
          method: "POST",
          path: "/channels/{channel}/polls",
          summary: "Start a poll",
          ...tag("Polls"),
        })
        .input(
          ChannelRef.extend({
            title: z.string().min(1).max(60),
            choices: z.array(z.string().min(1).max(25)).min(2).max(5),
            durationSeconds: z.number().int().min(15).max(1800),
            pointsPerExtraVote: z.number().int().min(0).max(1_000_000).default(0),
          }),
        )
        .output(D.PollView),
      vote: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/polls/{id}/votes",
          summary: "Vote in a poll",
          ...tag("Polls"),
        })
        .input(
          z.object({
            id: Id,
            choiceId: z.string(),
            extraVotes: z.number().int().min(0).max(100).default(0),
          }),
        )
        .output(D.PollView),
      end: mod
        .meta({ access: "moderator", scopes: ["channel:manage:polls"] })
        .route({
          method: "POST",
          path: "/polls/{id}/end",
          summary: "End a poll early or archive it",
          ...tag("Polls"),
        })
        .input(z.object({ id: Id, status: z.enum(["terminated", "archived"]) }))
        .output(D.PollView),
    },
    predictions: {
      current: base
        .route({
          method: "GET",
          path: "/channels/{channel}/predictions/current",
          summary: "Active or most recent prediction",
          ...tag("Predictions"),
        })
        .input(ChannelRef)
        .output(D.PredictionView.nullable()),
      create: mod
        .meta({ access: "moderator", scopes: ["channel:manage:predictions"] })
        .route({
          method: "POST",
          path: "/channels/{channel}/predictions",
          summary: "Start a prediction",
          ...tag("Predictions"),
        })
        .input(
          ChannelRef.extend({
            title: z.string().min(1).max(45),
            outcomes: z.array(z.string().min(1).max(25)).min(2).max(10),
            windowSeconds: z.number().int().min(30).max(1800),
          }),
        )
        .output(D.PredictionView),
      bet: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/predictions/{id}/bets",
          summary: "Bet channel points on an outcome",
          ...tag("Predictions"),
        })
        .input(z.object({ id: Id, outcomeId: z.string(), points: z.number().int().min(1).max(250_000) }))
        .output(D.PredictionView),
      lock: mod
        .meta({ access: "moderator", scopes: ["channel:manage:predictions"] })
        .route({
          method: "POST",
          path: "/predictions/{id}/lock",
          summary: "Lock betting",
          ...tag("Predictions"),
        })
        .input(z.object({ id: Id }))
        .output(D.PredictionView),
      resolve: mod
        .meta({ access: "moderator", scopes: ["channel:manage:predictions"] })
        .route({
          method: "POST",
          path: "/predictions/{id}/resolve",
          summary: "Pick the winning outcome and pay out points",
          ...tag("Predictions"),
        })
        .input(z.object({ id: Id, winningOutcomeId: z.string() }))
        .output(D.PredictionView),
      cancel: mod
        .meta({ access: "moderator", scopes: ["channel:manage:predictions"] })
        .route({
          method: "POST",
          path: "/predictions/{id}/cancel",
          summary: "Cancel and refund points",
          ...tag("Predictions"),
        })
        .input(z.object({ id: Id }))
        .output(D.PredictionView),
    },
    raids: {
      start: owner
        .meta({ access: "owner", scopes: ["channel:manage:raids"] })
        .route({
          method: "POST",
          path: "/channels/{channel}/raids",
          summary: "Raid another live channel",
          ...tag("Raids"),
        })
        .input(ChannelRef.extend({ to: Slug }))
        .output(D.RaidView),
      cancel: owner
        .meta({ access: "owner", scopes: ["channel:manage:raids"] })
        .route({
          method: "DELETE",
          path: "/channels/{channel}/raids",
          summary: "Cancel a pending raid",
          ...tag("Raids"),
        })
        .input(ChannelRef)
        .output(Ok),
      current: owner
        .meta({ access: "owner", scopes: ["channel:manage:raids"] })
        .route({
          method: "GET",
          path: "/channels/{channel}/raids",
          summary: "The pending or last raid, the cooldown and the raid policy",
          ...tag("Raids"),
        })
        .input(ChannelRef)
        .output(D.RaidState),
      setPolicy: owner
        .meta({ access: "owner", scopes: ["channel:manage:raids"], rateLimit: "write" })
        .route({
          method: "PUT",
          path: "/channels/{channel}/raids/policy",
          summary: "Who may raid this channel",
          ...tag("Raids"),
        })
        .input(ChannelRef.extend({ policy: z.enum(E.RAID_POLICIES) }))
        .output(D.RaidState),
    },
    alerts: {
      list: owner
        .route({
          method: "GET",
          path: "/channels/{channel}/alerts",
          summary: "Alert configurations",
          ...tag("Overlays"),
        })
        .input(ChannelRef)
        .output(z.array(D.AlertConfig)),
      set: owner
        .route({
          method: "PUT",
          path: "/channels/{channel}/alerts/{type}",
          summary: "Configure an alert",
          ...tag("Overlays"),
        })
        .input(
          ChannelRef.extend({
            type: z.enum(E.ALERT_TYPES),
            enabled: z.boolean(),
            template: AlertTemplate,
            minAmountCents: z.number().int().min(0).default(0),
            durationMs: z.number().int().min(1000).max(30000).default(6000),
          }),
        )
        .output(D.AlertConfig),
      test: owner
        .route({
          method: "POST",
          path: "/channels/{channel}/alerts/{type}/test",
          summary: "Fire a test alert on the overlay",
          ...tag("Overlays"),
        })
        .input(ChannelRef.extend({ type: z.enum(E.ALERT_TYPES) }))
        .output(Ok),
    },
    goals: {
      list: base
        .route({
          method: "GET",
          path: "/channels/{channel}/goals",
          summary: "Goal bars",
          ...tag("Overlays"),
        })
        .input(ChannelRef)
        .output(z.array(D.Goal)),
      create: owner
        .route({
          method: "POST",
          path: "/channels/{channel}/goals",
          summary: "Start a goal",
          ...tag("Overlays"),
        })
        .input(
          ChannelRef.extend({
            type: z.enum(E.GOAL_TYPES),
            title: z.string().min(1).max(60),
            target: z.number().int().positive(),
          }),
        )
        .output(D.Goal),
      end: owner
        .route({
          method: "POST",
          path: "/channels/{channel}/goals/{id}/end",
          summary: "End a goal",
          ...tag("Overlays"),
        })
        .input(ChannelRef.extend({ id: Id }))
        .output(D.Goal),
    },
    overlays: {
      token: owner
        .meta({ access: "owner", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/channels/{channel}/overlay-token",
          summary: "Create (or rotate) the secret overlay URL token; revokes the previous one",
          ...tag("Overlays"),
        })
        // ADR 0021: no expiry (null/absent, the default) or any future instant, no upper cap.
        .input(ChannelRef.extend({ expiresAt: Timestamp.nullable().optional() }))
        .output(
          z.object({
            /** Shown once; only its hash is stored. */
            token: z.string(),
            alertsUrl: z.string(),
            goalsUrl: z.string(),
            chatUrl: z.string(),
            expiresAt: Timestamp.nullable(),
          }),
        ),
      status: owner
        .route({
          method: "GET",
          path: "/channels/{channel}/overlay-token",
          summary: "Whether an overlay token is active, and when it expires",
          ...tag("Overlays"),
        })
        .input(ChannelRef)
        .output(D.OverlayTokenStatus),
      revoke: owner
        .meta({ access: "owner", rateLimit: "write" })
        .route({
          method: "DELETE",
          path: "/channels/{channel}/overlay-token",
          summary: "Revoke the overlay token without a replacement",
          ...tag("Overlays"),
        })
        .input(ChannelRef)
        .output(Ok),
      state: base
        .meta({ access: "overlay" })
        .route({
          method: "GET",
          path: "/overlay/state",
          summary: "Overlay bootstrap state (overlay token)",
          ...tag("Overlays"),
        })
        .output(
          z.object({
            channelSlug: Slug,
            alerts: z.array(D.AlertConfig),
            goals: z.array(D.Goal),
            eventsUrl: z.string(),
          }),
        ),
    },
  },

  coop: {
    membership: user
      .route({
        method: "GET",
        path: "/coop/membership",
        summary: "Your memberships and eligibility",
        ...tag("Co-op"),
      })
      .output(D.MembershipView),
    buyShare: user
      .meta({ access: "user", rateLimit: "write" })
      .route({
        method: "POST",
        path: "/coop/shares",
        summary: "Buy the one-time, refundable viewer membership share",
        ...tag("Co-op"),
      })
      .input(z.object({ returnPath: ReturnPath }))
      .output(D.CheckoutResult),
    shares: {
      list: treasurer
        .route({
          method: "GET",
          path: "/coop/shares",
          summary: "Member shares by status (treasury)",
          ...tag("Co-op"),
        })
        .input(PageInput.extend({ status: z.enum(E.SHARE_STATUSES).optional() }))
        .output(page(D.ShareView)),
      refund: treasurer
        .route({
          method: "POST",
          path: "/coop/shares/{shareId}/refund",
          summary: "Record that a refund_pending share was paid back",
          ...tag("Co-op"),
        })
        .input(z.object({ shareId: Id, sentAt: Timestamp, note: z.string().max(500).optional() }))
        .output(D.ShareView),
    },
    exit: user
      .route({
        method: "POST",
        path: "/coop/membership/{class}/exit",
        summary: "Leave a membership class (share refunded per rules)",
        ...tag("Co-op"),
      })
      .input(z.object({ class: z.enum(E.MEMBER_CLASSES) }))
      .output(D.MembershipView),
    join: user
      .meta({ access: "user", rateLimit: "write" })
      .route({
        method: "POST",
        path: "/coop/membership/{class}/join",
        summary: "Rejoin the viewer class (a qualifying subscription, no new share)",
        ...tag("Co-op"),
      })
      .input(z.object({ class: z.literal("viewer") }))
      .output(D.MembershipView),
    appointWorker: admin
      .route({
        method: "POST",
        path: "/coop/workers",
        summary: "Record a board decision appointing a worker member",
        ...tag("Co-op"),
      })
      .input(z.object({ username: Slug, boardMinuteRef: z.string().min(1).max(200) }))
      .output(Ok),
    settings: base
      .route({
        method: "GET",
        path: "/coop/settings",
        summary: "Governance settings (protected ones change only by protected decision)",
        ...tag("Governance"),
      })
      .output(z.array(D.GovernanceSetting)),
    proposals: {
      list: base
        .route({
          method: "GET",
          path: "/coop/proposals",
          summary: "Proposals",
          ...tag("Governance"),
        })
        .input(PageInput.extend({ status: z.enum(E.PROPOSAL_STATUSES).optional() }))
        .output(page(D.ProposalView)),
      get: base
        .route({
          method: "GET",
          path: "/coop/proposals/{id}",
          summary: "A proposal with timeline, council response and tally",
          ...tag("Governance"),
        })
        .input(z.object({ id: Id }))
        .output(D.ProposalView),
      create: user
        .route({
          method: "POST",
          path: "/coop/proposals",
          summary: "Draft a proposal (members only)",
          ...tag("Governance"),
        })
        .input(
          z.object({
            title: z.string().min(5).max(140),
            body: z.string().min(1).max(50_000),
            changes: z.array(GovernanceChange).max(20),
            affectsCreators: z.boolean(),
          }),
        )
        .output(D.ProposalView),
      update: user
        .route({
          method: "PATCH",
          path: "/coop/proposals/{id}",
          summary: "Edit your proposal while it is a draft or in discussion (restarts discussion)",
          ...tag("Governance"),
        })
        .input(
          z.object({
            id: Id,
            title: z.string().min(5).max(140),
            body: z.string().min(1).max(50_000),
            changes: z.array(GovernanceChange).max(20),
            affectsCreators: z.boolean(),
          }),
        )
        .output(D.ProposalView),
      submit: user
        .route({
          method: "POST",
          path: "/coop/proposals/{id}/submit",
          summary: "Open discussion",
          ...tag("Governance"),
        })
        .input(z.object({ id: Id }))
        .output(D.ProposalView),
      withdraw: user
        .route({
          method: "POST",
          path: "/coop/proposals/{id}/withdraw",
          summary: "Withdraw before voting",
          ...tag("Governance"),
        })
        .input(z.object({ id: Id }))
        .output(D.ProposalView),
      comments: base
        .route({
          method: "GET",
          path: "/coop/proposals/{id}/comments",
          summary: "Discussion",
          ...tag("Governance"),
        })
        .input(z.object({ id: Id }).extend(PageInput.shape))
        .output(page(D.ProposalComment)),
      comment: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/coop/proposals/{id}/comments",
          summary: "Comment (members only)",
          ...tag("Governance"),
        })
        .input(z.object({ id: Id, body: z.string().min(1).max(10_000) }))
        .output(D.ProposalComment),
      vote: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/coop/proposals/{id}/vote",
          summary: "Cast or change your vote while voting is open",
          ...tag("Governance"),
        })
        .errors(VOTE_REFUSED)
        .input(z.object({ id: Id, choice: z.enum(E.VOTE_CHOICES) }))
        .output(D.ProposalView),
      councilRespond: user
        .route({
          method: "POST",
          path: "/coop/proposals/{id}/council-response",
          summary: "Publish the creator council's response (council members)",
          ...tag("Governance"),
        })
        .input(
          z.object({
            id: Id,
            stance: z.enum(E.COUNCIL_STANCES),
            body: z.string().min(1).max(20_000),
          }),
        )
        .output(D.ProposalView),
    },
    council: base
      .route({
        method: "GET",
        path: "/coop/council",
        summary: "The current creator council and how it was seated",
        ...tag("Governance"),
      })
      .output(D.CouncilView),
    elections: {
      list: base
        .route({
          method: "GET",
          path: "/coop/elections",
          summary: "Board elections",
          ...tag("Governance"),
        })
        .output(z.array(D.ElectionView)),
      nominate: user
        .route({
          method: "POST",
          path: "/coop/elections/{id}/candidates",
          summary: "Stand as a candidate (members of the seat's class)",
          ...tag("Governance"),
        })
        .input(z.object({ id: Id, statement: z.string().max(5000) }))
        .output(D.ElectionView),
      vote: user
        .route({
          method: "POST",
          path: "/coop/elections/{id}/ballot",
          summary: "Approval ballot (up to `seats` candidates)",
          ...tag("Governance"),
        })
        .input(z.object({ id: Id, candidateIds: z.array(Id).min(1).max(50) }))
        .output(D.ElectionView),
      create: admin
        .route({
          method: "POST",
          path: "/coop/elections",
          summary: "Schedule a board election per the seat configuration",
          ...tag("Governance"),
        })
        .input(
          z.object({
            class: z.enum(E.MEMBER_CLASSES),
            nominationsCloseAt: Timestamp,
            votingEndsAt: Timestamp,
          }),
        )
        .output(D.ElectionView),
    },
    board: base
      .route({
        method: "GET",
        path: "/coop/board",
        summary: "Current board seats by class",
        ...tag("Governance"),
      })
      .output(
        z.array(
          z.object({
            user: D.UserPublic,
            class: z.enum(E.MEMBER_CLASSES),
            termStart: Timestamp,
            termEnd: Timestamp,
          }),
        ),
      ),
    patronage: {
      statements: user
        .route({
          method: "GET",
          path: "/coop/patronage",
          summary: "Your patronage statements",
          ...tag("Patronage"),
        })
        .output(z.array(D.PatronageStatement)),
      statement: user
        .route({
          method: "GET",
          path: "/coop/patronage/{periodId}",
          summary: "One statement, explained line by line",
          ...tag("Patronage"),
        })
        .input(z.object({ periodId: Id }))
        .output(D.PatronageStatement),
      run: treasurer
        .route({
          method: "POST",
          path: "/coop/patronage/run",
          summary: "Compute a patronage period (draft)",
          ...tag("Patronage"),
        })
        .input(
          z.object({
            periodStart: Timestamp,
            periodEnd: Timestamp,
            /** Omitted: all retained surplus available after closing the period. */
            surplusCents: z.number().int().nonnegative().optional(),
          }),
        )
        .output(z.object({ periodId: Id, members: z.number().int(), total: Money, surplus: Money })),
      approve: finance
        .route({
          method: "POST",
          path: "/coop/patronage/{periodId}/approve",
          summary: "Approve and post allocations to the ledger (not the person who ran it)",
          ...tag("Patronage"),
        })
        .errors(SECOND_APPROVER)
        .input(z.object({ periodId: Id }))
        .output(Ok),
      periods: finance
        .route({
          method: "GET",
          path: "/coop/patronage-periods",
          summary: "Patronage periods, newest first",
          ...tag("Patronage"),
        })
        .output(z.array(D.PatronagePeriodView)),
    },
    transparency: base
      .route({
        method: "GET",
        path: "/transparency",
        summary: "Monthly revenue, costs, surplus distribution and governance outcomes",
        ...tag("Transparency"),
      })
      .input(z.object({ months: z.number().int().min(1).max(36).default(12) }))
      .output(z.array(D.TransparencyMonth)),
    feeSchedule: base
      .route({
        method: "GET",
        path: "/transparency/fee-schedule",
        summary: "Every change to the platform cut and payout rules, with dates",
        ...tag("Transparency"),
      })
      .output(z.array(D.FeeScheduleEntry)),
  },

  integrity: {
    channelSummary: owner
      .route({
        method: "GET",
        path: "/channels/{channel}/integrity",
        summary: "What was excluded from your counts and why",
        ...tag("Integrity"),
      })
      .input(ChannelRef.extend({ from: Timestamp.optional(), to: Timestamp.optional() }))
      .output(D.IntegritySummary),
    flags: admin
      .route({
        method: "GET",
        path: "/admin/integrity/flags",
        summary: "Integrity flags",
        ...tag("Integrity"),
      })
      .input(
        PageInput.extend({
          subjectType: z.enum(E.INTEGRITY_SUBJECTS).optional(),
          decision: z.enum(E.INTEGRITY_DECISIONS).optional(),
          channel: Slug.optional(),
        }),
      )
      .output(page(D.IntegrityFlag)),
    decide: admin
      .route({
        method: "POST",
        path: "/admin/integrity/flags/{id}",
        summary: "Confirm or clear a flag",
        ...tag("Integrity"),
      })
      .input(
        z.object({
          id: Id,
          decision: z.enum(["excluded", "allowed"]),
          reason: z.string().min(1).max(1000),
        }),
      )
      .output(D.IntegrityFlag),
  },

  appeals: {
    create: user
      .meta({ access: "user", rateLimit: "write", whileSuspended: true })
      .route({
        method: "POST",
        path: "/appeals",
        summary: "Appeal an integrity, moderation, DMCA or account decision",
        ...tag("Appeals"),
      })
      .input(
        z.object({
          kind: z.enum(E.APPEAL_KINDS),
          subjectType: z.enum(E.APPEAL_SUBJECTS),
          subjectId: Id,
          body: z.string().min(10).max(5000),
        }),
      )
      .output(D.Appeal),
    mine: user
      .route({ method: "GET", path: "/appeals", summary: "Your appeals", ...tag("Appeals") })
      .output(z.array(D.Appeal)),
    accountActions: user
      .route({
        method: "GET",
        path: "/appeals/account-actions",
        summary: "Account actions about you (appealable)",
        ...tag("Appeals"),
      })
      .output(z.array(D.AccountAction)),
    queue: platformMod
      .route({ method: "GET", path: "/admin/appeals", summary: "Appeals queue", ...tag("Appeals") })
      .input(PageInput.extend({ status: z.enum(E.APPEAL_STATUSES).default("open") }))
      .output(page(D.Appeal)),
    resolve: platformMod
      .route({
        method: "POST",
        path: "/admin/appeals/{id}",
        summary: "Resolve an appeal (logged)",
        ...tag("Appeals"),
      })
      .input(
        z.object({
          id: Id,
          status: z.enum(["upheld", "overturned"]),
          resolution: z.string().min(1).max(5000),
        }),
      )
      .output(D.Appeal),
  },

  safety: {
    report: base
      .meta({ access: "user", rateLimit: "write" })
      .route({
        method: "POST",
        path: "/reports",
        summary: "Report a user, channel, message, VOD, clip or broadcast, or a wave of chat messages",
        ...tag("Safety"),
      })
      .input(
        z
          .object({
            subjectType: z.enum(E.REPORT_SUBJECTS),
            subjectId: Id,
            reason: z.enum(E.REPORT_REASONS),
            details: z.string().max(5000).default(""),
            /** `message_set` only (a Calm Chat wave): the messages, all in one channel; `subjectId` must be one of them. */
            messageIds: z
              .array(Id)
              .min(E.MESSAGE_SET_RULES.minMessages)
              .max(E.MESSAGE_SET_RULES.maxMessages)
              .optional(),
          })
          .refine(
            (i) =>
              (i.subjectType === "message_set") === (i.messageIds !== undefined) &&
              (i.messageIds === undefined || i.messageIds.includes(i.subjectId)),
            {
              message: "messageIds is required exactly for message_set and must contain subjectId",
              path: ["messageIds"],
            },
          ),
      )
      .output(z.object({ id: Id })),
    queue: platformMod
      .route({
        method: "GET",
        path: "/admin/reports",
        summary: "Moderation queue",
        ...tag("Safety"),
      })
      .input(
        PageInput.extend({
          status: z.enum(E.REPORT_STATUSES).default("open"),
          reason: z.enum(E.REPORT_REASONS).optional(),
        }),
      )
      .output(page(D.Report)),
    resolve: platformMod
      .route({
        method: "POST",
        path: "/admin/reports/{id}",
        summary: "Resolve a report, optionally taking action",
        ...tag("Safety"),
      })
      .input(
        z.object({
          id: Id,
          status: z.enum(["actioned", "dismissed"]),
          resolution: z.string().min(1).max(5000),
          action: z
            .enum(["none", "remove_content", "suspend_user", "suspend_channel", "ban_from_channel"])
            .default("none"),
          durationSeconds: z.number().int().positive().optional(),
        }),
      )
      .output(D.Report),
    modLog: mod
      .route({
        method: "GET",
        path: "/channels/{channel}/mod-log",
        summary: "Every moderator action in the channel",
        ...tag("Moderation"),
      })
      .input(ChannelRef.extend(PageInput.shape))
      .output(page(D.ModActionView)),
    auditLog: admin
      .route({
        method: "GET",
        path: "/admin/audit-log",
        summary: "Platform audit log",
        ...tag("Safety"),
      })
      .input(
        PageInput.extend({
          subjectType: ShortText.optional(),
          subjectId: ShortText.optional(),
          actorId: Id.optional(),
        }),
      )
      .output(page(D.AuditEntry)),
    dmca: {
      submit: base
        .meta({ access: "public", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/dmca/notices",
          summary: "Submit a DMCA takedown notice",
          ...tag("DMCA"),
        })
        .input(
          z.object({
            claimantName: z.string().min(1).max(200),
            claimantEmail: z.email(),
            claimantAddress: z.string().min(1).max(500),
            /** § 512(c)(3)(A)(iv): "such as … telephone number". */
            claimantPhone: z.string().min(5).max(40).optional(),
            copyrightedWork: z.string().min(1).max(5000),
            infringingUrls: z.array(z.url()).min(1).max(50),
            goodFaithStatement: z.literal(true),
            accuracyStatement: z.literal(true),
            signature: z.string().min(1).max(200),
            altcha: z.string(),
          }),
        )
        .output(z.object({ id: Id })),
      counter: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/dmca/notices/{id}/counter",
          summary: "File a counter-notice for your content",
          ...tag("DMCA"),
        })
        .input(
          z.object({
            id: Id,
            fullName: z.string().min(1).max(200),
            address: z.string().min(1).max(500),
            /** § 512(g)(3)(D) requires a telephone number. */
            phone: z.string().min(5).max(40),
            /** § 512(g)(3)(B): which removed material the counter-notice covers. */
            itemIds: z.array(Id).min(1).max(50),
            statement: z.string().min(1).max(5000),
            /** § 512(g)(3)(C): good-faith belief of mistake or misidentification, under penalty of perjury. */
            goodFaithStatement: z.literal(true),
            /**
             * § 512(g)(3)(D): consent to the jurisdiction of the federal district court and acceptance of
             * service of process from the claimant; one checkbox covers both.
             */
            consentToJurisdiction: z.literal(true),
            signature: z.string().min(1).max(200),
          }),
        )
        .output(z.object({ restoreAfter: Timestamp })),
      mine: user
        .route({
          method: "GET",
          path: "/dmca/mine",
          summary: "Copyright notices about your content",
          ...tag("DMCA"),
        })
        .output(z.array(D.DmcaNoticeForOwner)),
      queue: platformMod
        .route({ method: "GET", path: "/admin/dmca", summary: "DMCA notices", ...tag("DMCA") })
        .input(PageInput.extend({ status: z.enum(E.DMCA_STATUSES).optional() }))
        .output(page(D.DmcaNotice)),
      action: platformMod
        .route({
          method: "POST",
          path: "/admin/dmca/{id}",
          summary: "Action or reject a notice",
          ...tag("DMCA"),
        })
        .input(
          z.object({
            id: Id,
            decision: z.enum(["actioned", "rejected"]),
            note: z.string().max(2000),
          }),
        )
        .output(D.DmcaNotice),
      suitFiled: platformMod
        .route({
          method: "POST",
          path: "/admin/dmca/counter-notices/{id}/suit",
          summary: "Record that the claimant filed suit (blocks the restore)",
          ...tag("DMCA"),
        })
        .input(z.object({ id: Id, note: z.string().max(2000) }))
        .output(D.DmcaNotice),
    },
    suspend: platformMod
      .route({
        method: "POST",
        path: "/admin/users/{username}/suspension",
        summary: "Suspend or unsuspend a user or channel",
        ...tag("Safety"),
      })
      .input(
        z.object({
          username: Slug,
          target: z.enum(["user", "channel"]),
          suspended: z.boolean(),
          reason: z.string().min(1).max(2000),
          durationSeconds: z.number().int().positive().optional(),
        }),
      )
      .output(Ok),
  },

  legal: {
    current: base
      .route({
        method: "GET",
        path: "/legal",
        summary: "Current legal documents (drafts pending lawyer review are marked)",
        ...tag("Compliance"),
      })
      .output(z.array(D.LegalDocument)),
    get: base
      .route({
        method: "GET",
        path: "/legal/{kind}",
        summary: "One legal document, current or a specific version",
        ...tag("Compliance"),
      })
      .input(z.object({ kind: z.enum(E.LEGAL_DOCUMENT_KINDS), version: ShortText.optional() }))
      .output(D.LegalDocument),
    consent: base
      .route({
        method: "POST",
        path: "/consent",
        summary: "Record cookie/storage consent choices",
        ...tag("Compliance"),
      })
      .meta({ access: "public", rateLimit: "write" })
      .input(
        z.object({
          anonymousId: z.string().min(16).max(64).optional(),
          choices: z
            .record(z.string().min(1).max(32), z.boolean())
            .refine((c) => Object.keys(c).length <= 16, "Too many consent categories"),
          policyVersion: ShortText,
        }),
      )
      .output(Ok),
  },

  relays: {
    mine: user
      .route({ method: "GET", path: "/relays", summary: "Your relay nodes", ...tag("Relays") })
      .output(z.array(D.RelayNode)),
    create: user
      .route({
        method: "POST",
        path: "/relays",
        summary: "Create a relay registration token",
        ...tag("Relays"),
      })
      .input(z.object({ name: z.string().min(1).max(50) }))
      .output(
        z.object({
          relayId: Id,
          registrationToken: z.string().describe("Shown once. Pass to the relay with --token."),
        }),
      ),
    remove: user
      .route({
        method: "DELETE",
        path: "/relays/{id}",
        summary: "Retire a relay",
        ...tag("Relays"),
      })
      .input(z.object({ id: Id }))
      .output(Ok),
    /** Called by the relay binary itself. */
    register: base
      .meta({ access: "relay" })
      .route({
        method: "POST",
        path: "/relay/register",
        summary: "Relay announces its URL, capacity, key and version",
        ...tag("Relay protocol"),
      })
      .input(
        z.object({
          publicUrl: z.url(),
          declaredCapacityMbps: z.number().int().min(1).max(100_000),
          publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          version: z.string().max(40),
          region: z.string().max(40).default(""),
        }),
      )
      .output(
        z.object({
          relayId: Id,
          originUrl: z.string(),
          originPublicKey: z.string(),
          receiptIntervalSeconds: z.number().int(),
          heartbeatIntervalSeconds: z.number().int(),
          status: z.enum(E.RELAY_STATUSES),
        }),
      ),
    heartbeat: base
      .meta({ access: "relay" })
      .route({
        method: "POST",
        path: "/relay/heartbeat",
        summary: "Relay liveness and load",
        ...tag("Relay protocol"),
      })
      .input(
        z.object({
          activeViewers: z.number().int().min(0),
          egressMbps: z.number().min(0),
          cacheBytes: z.number().int().min(0),
          /**
           * The relay is shutting down: the API takes it out of assignment at once (status
           * `offline`) so players move to the origin on their next heartbeat; the relay keeps
           * serving its current viewers until its drain timeout. It re-registers on restart.
           */
          draining: z.boolean().default(false),
        }),
      )
      .output(z.object({ status: z.enum(E.RELAY_STATUSES), originPublicKey: z.string() })),
    receipt: base
      .meta({ access: "relay" })
      .route({
        method: "POST",
        path: "/relay/receipts",
        summary: "Submit a signed bandwidth receipt",
        ...tag("Relay protocol"),
      })
      .input(
        z.object({
          payload: z.string().max(4_000_000).describe("base64url of the receipt JSON bytes (see ReceiptPayload)"),
          signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
        }),
      )
      .output(z.object({ receiptId: Id, status: z.enum(E.RECEIPT_STATUSES) })),
    adminList: admin
      .route({ method: "GET", path: "/admin/relays", summary: "All relays", ...tag("Relays") })
      .input(PageInput.extend({ status: z.enum(E.RELAY_STATUSES).optional() }))
      .output(page(D.RelayNode.extend({ owner: D.UserPublic }))),
    reinstate: admin
      .route({
        method: "POST",
        path: "/admin/relays/{id}/reinstate",
        summary: "Reinstate a suspended relay after review",
        ...tag("Relays"),
      })
      .input(z.object({ id: Id, reason: z.string().min(1).max(1000) }))
      .output(D.RelayNode),
  },

  admin: {
    egress: admin
      .route({
        method: "GET",
        path: "/admin/egress",
        summary: "Egress by source (origin / relay / P2P / CDN)",
        ...tag("Admin"),
      })
      .input(z.object({ from: Timestamp, to: Timestamp }))
      .output(D.EgressReport),
    categories: admin
      .route({
        method: "PUT",
        path: "/admin/categories/{slug}",
        summary: "Create or update a category",
        ...tag("Admin"),
      })
      .input(
        z.object({
          slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
          name: z.string().min(1).max(60),
          mature: z.boolean().default(false),
        }),
      )
      .output(D.Category),
    setRole: admin
      .route({
        method: "PUT",
        path: "/admin/users/{username}/role",
        summary: "Set a platform role",
        ...tag("Admin"),
      })
      .input(z.object({ username: Slug, role: z.enum(E.PLATFORM_ROLES) }))
      .output(Ok),
    incidents: admin
      .route({
        method: "POST",
        path: "/admin/incidents",
        summary: "Open or update a status-page incident",
        ...tag("Admin"),
      })
      .input(
        z.object({
          id: Id.optional(),
          title: z.string().min(1).max(140),
          status: z.enum(E.INCIDENT_STATUSES),
          components: z.array(z.string()),
          body: z.string().max(5000),
        }),
      )
      .output(z.object({ id: Id })),
    legalHold: legal
      .route({
        method: "POST",
        path: "/admin/users/{username}/legal-hold",
        summary: "Place a manual legal hold (release needs the operator CLI)",
        ...tag("Legal"),
      })
      .input(
        z.object({
          username: Slug,
          hold: z.literal(true),
          reasonCode: z.enum(["law_enforcement", "litigation"]),
          reason: z.string().min(1).max(2000),
        }),
      )
      .output(D.LegalHold),
    expediteDeletion: admin
      .route({
        method: "POST",
        path: "/admin/users/{username}/deletion",
        summary: "Delete an account now (creates the request if needed; held data is retained)",
        ...tag("Admin"),
      })
      .input(z.object({ username: Slug, reason: z.string().min(1).max(2000) }))
      .output(D.DeletionRequest),
  },

  moderation: {
    queue: safetyStaff
      .route({
        method: "GET",
        path: "/admin/moderation/cases",
        summary: "T1 and T2 moderation cases (T0 cases are only in the legal queue)",
        ...tag("Moderation"),
      })
      .input(
        PageInput.extend({
          tier: z.enum(["t1", "t2"]).optional(),
          status: z.enum(E.MODERATION_CASE_STATUSES).optional(),
        }),
      )
      .output(page(D.ModerationCase)),
    case: safetyStaff
      .route({
        method: "GET",
        path: "/admin/moderation/cases/{id}",
        summary: "A T1/T2 case with its flags and audit trail (T0 cases are NOT_FOUND here)",
        ...tag("Moderation"),
      })
      .input(z.object({ id: Id }))
      .output(D.ModerationCaseDetail),
    frame: safetyStaff
      .route({
        method: "GET",
        path: "/admin/moderation/flags/{id}/frame",
        summary: "The stored review frame of a T1/T2 flag (never T0)",
        ...tag("Moderation"),
      })
      .input(z.object({ id: Id }))
      .output(z.object({ contentType: z.string(), dataBase64: z.string() })),
    review: safetyStaff
      .route({
        method: "POST",
        path: "/admin/moderation/cases/{id}/review",
        summary: "Decide an open T1 or report-derived case (logged)",
        ...tag("Moderation"),
      })
      .input(
        z.object({
          id: Id,
          decision: z.enum(E.MODERATION_REVIEW_DECISIONS),
          note: z.string().min(1).max(2000),
          /** `suspend` only: what to suspend and for how long (absent = indefinite). */
          suspendTarget: z.enum(["channel", "user", "both"]).default("channel"),
          durationSeconds: z.number().int().positive().optional(),
        }),
      )
      .output(D.ModerationCase),
    t0Queue: legal
      .route({ method: "GET", path: "/admin/legal/cases", summary: "T0 cases", ...tag("Legal") })
      .input(PageInput.extend({ status: z.enum(E.MODERATION_CASE_STATUSES).optional() }))
      .output(page(D.LegalCase)),
    t0Confirm: legal
      .route({
        method: "POST",
        path: "/admin/legal/cases/{id}/confirm",
        summary: "Confirm a T0 case: hashes to the local block list, NCMEC draft if needed",
        ...tag("Legal"),
      })
      .input(z.object({ id: Id, note: z.string().min(1).max(2000) }))
      .output(D.LegalCase),
    t0Dismiss: legal
      .route({
        method: "POST",
        path: "/admin/legal/cases/{id}/dismiss",
        summary: "Dismiss a T0 case (two different legal reviewers; the hold stays)",
        ...tag("Legal"),
      })
      .input(z.object({ id: Id, note: z.string().min(1).max(2000) }))
      .output(
        z.object({
          case: D.LegalCase,
          /** Removed VOD/clip media is never restored: it exists only as sealed evidence. */
          mediaRestored: z.literal(false),
        }),
      ),
    evidence: legal
      .route({
        method: "GET",
        path: "/admin/legal/evidence/{id}",
        summary: "View one inline evidence object (decrypted, never cached, audited)",
        ...tag("Legal"),
      })
      .input(z.object({ id: Id }))
      .output(D.EvidenceView),
    ncmecReports: legal
      .route({ method: "GET", path: "/admin/legal/ncmec", summary: "NCMEC report drafts", ...tag("Legal") })
      .input(PageInput.extend({ status: z.enum(E.NCMEC_REPORT_STATUSES).optional() }))
      .output(page(D.NcmecReport)),
    ncmecReport: legal
      .route({
        method: "GET",
        path: "/admin/legal/ncmec/{id}",
        summary: "One draft with its decrypted snapshot (audited)",
        ...tag("Legal"),
      })
      .input(z.object({ id: Id }))
      .output(D.NcmecReportDetail),
    ncmecFile: legal
      .route({
        method: "POST",
        path: "/admin/legal/ncmec/{id}/filing",
        summary: "Record the CyberTipline filing (starts the one-year preservation clock)",
        ...tag("Legal"),
      })
      .input(z.object({ id: Id, externalReportId: z.string().min(1).max(100), filedAt: Timestamp }))
      .output(D.NcmecReport),
    holds: legal
      .route({ method: "GET", path: "/admin/legal/holds", summary: "Legal holds", ...tag("Legal") })
      .input(PageInput.extend({ active: z.boolean().default(true) }))
      .output(page(D.LegalHold)),
  },

  ncii: {
    submit: base
      .meta({ access: "public", rateLimit: "write" })
      .route({
        method: "POST",
        path: "/takedown/requests",
        summary: "Request removal of non-consensual intimate imagery (48-hour clock)",
        ...tag("Safety"),
      })
      .input(
        z.object({
          requesterName: z.string().min(1).max(200),
          requesterEmail: z.email(),
          relationship: z.enum(E.NCII_RELATIONSHIPS),
          contentUrls: z.array(z.url()).min(1).max(20),
          description: z.string().min(1).max(5000),
          goodFaith: z.literal(true),
          signature: z.string().min(1).max(200),
          altcha: z.string(),
        }),
      )
      .output(z.object({ id: Id, deadlineAt: Timestamp })),
    queue: safetyStaff
      .route({ method: "GET", path: "/admin/ncii", summary: "NCII takedown requests", ...tag("Safety") })
      .input(PageInput.extend({ status: z.enum(E.NCII_STATUSES).optional() }))
      .output(page(D.NciiRequest)),
    decide: safetyStaff
      .route({
        method: "POST",
        path: "/admin/ncii/{id}",
        summary: "Remove or reject an NCII request (logged)",
        ...tag("Safety"),
      })
      .input(z.object({ id: Id, decision: z.enum(E.NCII_DECISIONS), note: z.string().min(1).max(2000) }))
      .output(D.NciiRequest),
  },
};

export type Contract = typeof contract;
