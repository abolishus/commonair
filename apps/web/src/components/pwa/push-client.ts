// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The browser half of web push (ADR 0028 decisions 1 and 6): permission, this browser's
 * subscription and the API calls that register or forget it. Every browser API is behind
 * `PushEnv`, so the state machine is tested with fakes. Nothing here runs on page load except
 * reading state: permission is only ever asked from a click.
 */
import { api } from "../../lib/api.ts";

export type PushState = "unsupported" | "unavailable" | "denied" | "off" | "on" | "busy";

/** `forgetPushSubscription` never holds sign-out up longer than this. */
export const FORGET_TIMEOUT_MS = 3_000;
/** How long to wait for the service worker (registered when the browser is idle) before giving up. */
export const READY_TIMEOUT_MS = 10_000;

export interface PushSubscriptionLike {
  readonly endpoint: string;
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array<ArrayBuffer>;
  }): Promise<PushSubscriptionLike>;
}

export interface PushApi {
  status(): Promise<{ enabled: boolean; vapidPublicKey: string | null; subscriptions: number }>;
  subscribe(input: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<unknown>;
  unsubscribe(input: { endpoint: string }): Promise<unknown>;
  /** Whether the member's go-live push default is on. */
  goLivePushDefault(): Promise<boolean>;
  /** Turn the go-live push default on (`preferences.set`, `channel: null`). */
  enableGoLivePushDefault(): Promise<unknown>;
}

export interface PushEnv {
  /** `serviceWorker`, `PushManager` and `Notification` all exist. */
  supported: boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /**
   * This page's push manager: with `wait`, until the worker is ready (bounded), otherwise only an
   * existing registration's. Null when there is none.
   */
  pushManager(wait: boolean): Promise<PushManagerLike | null>;
  api: PushApi;
}

/** base64url (padded or not) → bytes, for `applicationServerKey`. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** What the API stores of a subscription; `toJSON()` is what browsers (and the harness stub) fill. */
export function subscriptionInput(sub: PushSubscriptionLike): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const json = sub.toJSON();
  const endpoint = json.endpoint ?? sub.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) throw new Error("push subscription without endpoint or keys");
  return { endpoint, keys: { p256dh, auth } };
}

function endpointOf(sub: PushSubscriptionLike): string {
  return sub.toJSON().endpoint ?? sub.endpoint;
}

/** The toggle's state on load. Never asks for permission. */
export async function readPushState(env: PushEnv): Promise<PushState> {
  if (!env.supported) return "unsupported";
  const status = await env.api.status();
  if (!status.enabled || !status.vapidPublicKey) return "unavailable";
  if (env.permission() === "denied") return "denied";
  const manager = await env.pushManager(true);
  if (!manager) return "unsupported";
  const sub = await manager.getSubscription();
  // "On" means the server knows a subscription and this browser still has one.
  return sub && status.subscriptions > 0 ? "on" : "off";
}

/**
 * From a click only: ask permission, subscribe this browser, register it, and turn the go-live push
 * default on if it was off (turning push on in a browser means "notify me", ADR 0028).
 */
export async function turnPushOn(env: PushEnv): Promise<PushState> {
  if (!env.supported) return "unsupported";
  let permission = env.permission();
  if (permission !== "granted") permission = await env.requestPermission();
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "off";
  const status = await env.api.status();
  if (!status.enabled || !status.vapidPublicKey) return "unavailable";
  const manager = await env.pushManager(true);
  if (!manager) return "unsupported";
  const sub =
    (await manager.getSubscription()) ??
    (await manager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(status.vapidPublicKey) }));
  try {
    await env.api.subscribe(subscriptionInput(sub));
  } catch (err) {
    // A subscription the server does not know would only ever stay silent: drop it.
    await sub.unsubscribe().catch(() => false);
    throw err;
  }
  if (!(await env.api.goLivePushDefault())) await env.api.enableGoLivePushDefault();
  return "on";
}

/** Forget this browser's subscription on the API, then in the browser. */
export async function turnPushOff(env: PushEnv, wait = true): Promise<PushState> {
  if (!env.supported) return "unsupported";
  const manager = await env.pushManager(wait);
  const sub = manager ? await manager.getSubscription() : null;
  if (sub) {
    await env.api.unsubscribe({ endpoint: endpointOf(sub) });
    await sub.unsubscribe();
  }
  return "off";
}

/**
 * Sign-out in this browser removes its push subscription (ADR 0028 decision 6): the same as
 * turning it off, silent on errors and bounded so sign-out never hangs.
 */
export async function forgetPushSubscription(
  env: PushEnv = browserPushEnv(),
  timeoutMs = FORGET_TIMEOUT_MS,
): Promise<void> {
  if (!env.supported) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([
      turnPushOff(env, false).then(
        () => undefined,
        () => undefined,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** The real browser and API. */
export function browserPushEnv(): PushEnv {
  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  return {
    supported,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    async pushManager(wait) {
      const existing = await navigator.serviceWorker.getRegistration();
      if (existing?.active) return existing.pushManager as unknown as PushManagerLike;
      if (!wait) return existing ? (existing.pushManager as unknown as PushManagerLike) : null;
      const ready = await withTimeout<ServiceWorkerRegistration | null>(
        navigator.serviceWorker.ready,
        READY_TIMEOUT_MS,
        null,
      );
      return ready ? (ready.pushManager as unknown as PushManagerLike) : null;
    },
    api: {
      status: () => api().notifications.push.status(),
      subscribe: (input) => api().notifications.push.subscribe(input),
      unsubscribe: (input) => api().notifications.push.unsubscribe(input),
      goLivePushDefault: async () => (await api().notifications.preferences.get({ type: "go_live" })).defaults.push,
      enableGoLivePushDefault: () =>
        api().notifications.preferences.set({ type: "go_live", medium: "push", channel: null, enabled: true }),
    },
  };
}
