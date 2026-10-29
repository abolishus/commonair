// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `@commonair/sdk`: the client SDK for CommonAir's developer platform (ADR 0027), Apache-2.0
 * (ADR 0035). A typed API client, OAuth helpers (PKCE, device flow, refresh rotation), an
 * EventSub WebSocket client, webhook verification and a minimal chat client for bots.
 */
export { createClient, type ClientOptions, type CommonAirClient, type Contract, type FetchLike } from "./client.ts";
export {
  ChatError,
  connectChat,
  type ChatConnectOptions,
  type ChatConnection,
  type ChatMessageEvent,
  type ChatServerFrame,
  type WebSocketConstructorLike,
} from "./chat.ts";
export {
  authorizeUrl,
  clientCredentials,
  createPkcePair,
  deviceFlow,
  exchangeCode,
  memoryStore,
  refresh,
  refreshingToken,
  revoke,
  type AuthorizeUrlOptions,
  type DeviceCode,
  type DeviceFlowOptions,
  type PkcePair,
  type RefreshingToken,
  type RefreshingTokenOptions,
  type StoredTokens,
  type TokenSet,
  type TokenStore,
} from "./auth.ts";
export { OAuthError, ReauthorizeError, errorCode, retryAfterSeconds, type OAuthErrorCode } from "./errors.ts";
export {
  closeCodeName,
  connectEventSub,
  eventSubUrl,
  subscribe,
  type EventSubClose,
  type EventSubCloseName,
  type EventSubMessageType,
  type EventSubNotification,
  type EventSubOptions,
  type EventSubRevocation,
  type EventSubSession,
  type SubscribeOptions,
  type WebSocketConstructor,
  type WsMessage,
} from "./eventsub.ts";
export {
  WEBHOOK_MAX_AGE_MS,
  createDedupe,
  verifyEventSubRequest,
  verifyEventSubWebRequest,
  type Dedupe,
  type HeaderSource,
  type VerifiedWebhook,
  type VerifyFailure,
  type VerifyOptions,
  type WebhookMessageType,
  type WebhookSubscription,
} from "./webhooks.ts";
// Contract values bots commonly need, re-exported so apps never import the private contracts package.
export { OAUTH_PATHS, PKCE_VERIFIER, DEVICE_CODE_GRANT, parseScope, pkceChallenge } from "@commonair/contracts/oauth";
export { SCOPES, SCOPE_NAMES, TWITCH_SCOPE_MAP, type Scope } from "@commonair/contracts/scopes";
export {
  EVENTSUB_WS_CLOSE,
  EVENTSUB_WS_KEEPALIVE,
  EVENTSUB_WS_PATH,
  ENVELOPE_STATUS,
} from "@commonair/contracts/eventsub";
export {
  WEBHOOK_HEADERS,
  signWebhook,
  verifyWebhook,
  type EventPayload,
  type EventType,
  type PublicEventType,
} from "@commonair/contracts/events";
