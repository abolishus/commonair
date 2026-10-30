// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The browser push state machine and the toggle, with a fake PushManager and API. */
import { LocaleProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type PushEnv,
  type PushManagerLike,
  type PushSubscriptionLike,
  base64UrlToBytes,
  forgetPushSubscription,
  readPushState,
  subscriptionInput,
  turnPushOff,
  turnPushOn,
} from "../src/components/pwa/push-client.ts";
import { PushToggle } from "../src/components/pwa/push-toggle.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const VAPID = "BPx8_" + "A".repeat(82); // 87 base64url characters → 65 bytes
const KEYS = { p256dh: "B" + "x".repeat(86), auth: "y".repeat(22) };

class FakeSubscription implements PushSubscriptionLike {
  unsubscribed = false;
  constructor(
    readonly endpoint: string,
    private readonly manager: FakePushManager,
  ) {}
  toJSON() {
    return { endpoint: this.endpoint, keys: KEYS };
  }
  unsubscribe() {
    this.unsubscribed = true;
    this.manager.current = null;
    return Promise.resolve(true);
  }
}

class FakePushManager implements PushManagerLike {
  current: FakeSubscription | null = null;
  subscribeCalls: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }[] = [];
  getSubscription() {
    return Promise.resolve(this.current);
  }
  subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array<ArrayBuffer> }) {
    this.subscribeCalls.push(options);
    this.current = new FakeSubscription("https://push.example/sub/1", this);
    return Promise.resolve(this.current);
  }
}

interface Fake {
  env: PushEnv;
  manager: FakePushManager;
  calls: string[];
  server: { subscriptions: number; pushDefault: boolean; enabled: boolean };
  permission: { value: NotificationPermission; answer: NotificationPermission; asked: number };
}

function fake(opts: { supported?: boolean; manager?: boolean; failSubscribe?: boolean } = {}): Fake {
  const manager = new FakePushManager();
  const calls: string[] = [];
  const server = { subscriptions: 0, pushDefault: false, enabled: true };
  const permission = {
    value: "default" as NotificationPermission,
    answer: "granted" as NotificationPermission,
    asked: 0,
  };
  const env: PushEnv = {
    supported: opts.supported ?? true,
    permission: () => permission.value,
    requestPermission: () => {
      permission.asked++;
      permission.value = permission.answer;
      return Promise.resolve(permission.answer);
    },
    pushManager: () => Promise.resolve(opts.manager === false ? null : manager),
    api: {
      status: () => {
        calls.push("status");
        return Promise.resolve({
          enabled: server.enabled,
          vapidPublicKey: server.enabled ? VAPID : null,
          subscriptions: server.subscriptions,
        });
      },
      subscribe: (input) => {
        calls.push(`subscribe ${input.endpoint} ${input.keys.p256dh === KEYS.p256dh}`);
        if (opts.failSubscribe) return Promise.reject(new Error("PRECONDITION_FAILED"));
        server.subscriptions++;
        return Promise.resolve({ ok: true });
      },
      unsubscribe: (input) => {
        calls.push(`unsubscribe ${input.endpoint}`);
        server.subscriptions = Math.max(0, server.subscriptions - 1);
        return Promise.resolve({ ok: true });
      },
      goLivePushDefault: () => {
        calls.push("preferences.get");
        return Promise.resolve(server.pushDefault);
      },
      enableGoLivePushDefault: () => {
        calls.push("preferences.set");
        server.pushDefault = true;
        return Promise.resolve({});
      },
    },
  };
  return { env, manager, calls, server, permission };
}

describe("readPushState", () => {
  it("is unsupported without the browser APIs, and asks nothing", async () => {
    const f = fake({ supported: false });
    expect(await readPushState(f.env)).toBe("unsupported");
    expect(f.calls).toEqual([]);
  });

  it("is unavailable when the instance has push off", async () => {
    const f = fake();
    f.server.enabled = false;
    expect(await readPushState(f.env)).toBe("unavailable");
  });

  it("is denied when the browser blocks notifications", async () => {
    const f = fake();
    f.permission.value = "denied";
    expect(await readPushState(f.env)).toBe("denied");
  });

  it("is unsupported when no service worker becomes ready", async () => {
    expect(await readPushState(fake({ manager: false }).env)).toBe("unsupported");
  });

  it("is off with no subscription, and never asks for permission on load", async () => {
    const f = fake();
    expect(await readPushState(f.env)).toBe("off");
    expect(f.permission.asked).toBe(0);
  });

  it("is on only when this browser and the server both have one", async () => {
    const f = fake();
    await f.manager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array() });
    expect(await readPushState(f.env)).toBe("off");
    f.server.subscriptions = 1;
    expect(await readPushState(f.env)).toBe("on");
  });
});

describe("turnPushOn", () => {
  it("asks permission, subscribes with the VAPID key, registers it and turns the push default on", async () => {
    const f = fake();
    expect(await turnPushOn(f.env)).toBe("on");
    expect(f.permission.asked).toBe(1);
    expect(f.manager.subscribeCalls).toHaveLength(1);
    expect(f.manager.subscribeCalls[0]?.userVisibleOnly).toBe(true);
    expect(f.manager.subscribeCalls[0]?.applicationServerKey).toEqual(base64UrlToBytes(VAPID));
    expect(f.calls).toEqual([
      "status",
      "subscribe https://push.example/sub/1 true",
      "preferences.get",
      "preferences.set",
    ]);
    expect(f.server.pushDefault).toBe(true);
  });

  it("leaves the preference alone when the push default is already on", async () => {
    const f = fake();
    f.server.pushDefault = true;
    expect(await turnPushOn(f.env)).toBe("on");
    expect(f.calls).not.toContain("preferences.set");
  });

  it("does not ask again when permission is already granted, and reuses a subscription", async () => {
    const f = fake();
    f.permission.value = "granted";
    await f.manager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array() });
    expect(await turnPushOn(f.env)).toBe("on");
    expect(f.permission.asked).toBe(0);
    expect(f.manager.subscribeCalls).toHaveLength(1);
  });

  it("stops at denied or a dismissed prompt, subscribing nothing", async () => {
    const denied = fake();
    denied.permission.answer = "denied";
    expect(await turnPushOn(denied.env)).toBe("denied");
    const dismissed = fake();
    dismissed.permission.answer = "default";
    expect(await turnPushOn(dismissed.env)).toBe("off");
    for (const f of [denied, dismissed]) {
      expect(f.manager.subscribeCalls).toEqual([]);
      expect(f.calls).toEqual([]);
    }
  });

  it("drops the browser subscription when the API refuses it", async () => {
    const f = fake({ failSubscribe: true });
    await expect(turnPushOn(f.env)).rejects.toThrow("PRECONDITION_FAILED");
    expect(f.manager.current).toBeNull();
    expect(f.calls).not.toContain("preferences.set");
  });

  it("is unsupported without the browser APIs", async () => {
    expect(await turnPushOn(fake({ supported: false }).env)).toBe("unsupported");
  });
});

describe("turnPushOff and sign-out", () => {
  it("forgets it on the API first, then in the browser", async () => {
    const f = fake();
    await turnPushOn(f.env);
    const sub = f.manager.current;
    expect(await turnPushOff(f.env)).toBe("off");
    expect(f.calls.at(-1)).toBe("unsubscribe https://push.example/sub/1");
    expect(sub?.unsubscribed).toBe(true);
    expect(f.server.subscriptions).toBe(0);
  });

  it("is off with nothing to forget", async () => {
    const f = fake();
    expect(await turnPushOff(f.env)).toBe("off");
    expect(f.calls).toEqual([]);
  });

  it("forgets the subscription on sign-out", async () => {
    const f = fake();
    await turnPushOn(f.env);
    await forgetPushSubscription(f.env);
    expect(f.manager.current).toBeNull();
    expect(f.server.subscriptions).toBe(0);
  });

  it("is silent when the API fails", async () => {
    const f = fake();
    await turnPushOn(f.env);
    f.env.api.unsubscribe = () => Promise.reject(new Error("network"));
    await expect(forgetPushSubscription(f.env)).resolves.toBeUndefined();
  });

  it("is bounded: a hanging API never holds sign-out up past the limit", async () => {
    vi.useFakeTimers();
    const f = fake();
    await turnPushOn(f.env);
    f.env.api.unsubscribe = () => new Promise(() => undefined);
    let done = false;
    const p = forgetPushSubscription(f.env, 3_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it("does nothing in a browser without push", async () => {
    const f = fake({ supported: false });
    await forgetPushSubscription(f.env);
    expect(f.calls).toEqual([]);
  });
});

describe("subscription helpers", () => {
  it("decodes base64url with and without padding", () => {
    expect([...base64UrlToBytes("AQID")]).toEqual([1, 2, 3]);
    expect([...base64UrlToBytes("_-8")]).toEqual([255, 239]);
    expect([...base64UrlToBytes("_-8=")]).toEqual([255, 239]);
    expect(base64UrlToBytes(VAPID)).toHaveLength(65);
  });

  it("reads endpoint and keys from toJSON() and refuses a subscription without keys", () => {
    const manager = new FakePushManager();
    expect(subscriptionInput(new FakeSubscription("https://push.example/a", manager))).toEqual({
      endpoint: "https://push.example/a",
      keys: KEYS,
    });
    const bare: PushSubscriptionLike = {
      endpoint: "https://push.example/b",
      toJSON: () => ({ endpoint: "https://push.example/b" }),
      unsubscribe: () => Promise.resolve(true),
    };
    expect(() => subscriptionInput(bare)).toThrow("without endpoint or keys");
  });
});

describe("PushToggle", () => {
  const show = (env: PushEnv) =>
    render(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <PushToggle env={env} />
      </LocaleProvider>,
    );
  const toggleState = () => screen.getByTestId("push-toggle").getAttribute("data-state");

  it("goes off → on from a click, asking permission only then", async () => {
    const f = fake();
    show(f.env);
    await waitFor(() => expect(toggleState()).toBe("off"));
    expect(f.permission.asked).toBe(0);
    await act(async () => {
      fireEvent.click(screen.getByTestId("push-toggle"));
    });
    await waitFor(() => expect(toggleState()).toBe("on"));
    expect(f.permission.asked).toBe(1);
    await act(async () => {
      fireEvent.click(screen.getByTestId("push-toggle"));
    });
    await waitFor(() => expect(toggleState()).toBe("off"));
    expect(f.server.subscriptions).toBe(0);
  });

  it("renders nothing when the instance has push off", async () => {
    const f = fake();
    f.server.enabled = false;
    const { container } = show(f.env);
    await waitFor(() => expect(f.calls).toContain("status"));
    await waitFor(() => expect(container.querySelector("[data-testid]")).toBeNull());
  });

  it("explains an unsupported browser", async () => {
    show(fake({ supported: false }).env);
    await waitFor(() => expect(toggleState()).toBe("unsupported"));
    expect(screen.getByTestId("push-unsupported")).toBeTruthy();
  });

  it("explains how to undo a denial", async () => {
    const f = fake();
    f.permission.value = "denied";
    show(f.env);
    await waitFor(() => expect(toggleState()).toBe("denied"));
    expect(screen.getByTestId("push-denied-help")).toBeTruthy();
  });
});
