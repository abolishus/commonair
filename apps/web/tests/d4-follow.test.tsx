// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d4-follow in the DOM: the Following split button (bell, menu, Unfollow behind a confirm, the
 * move grant), the one-time first-follow alert prompt (Push, Email, Not now; iOS before install),
 * the post-verification confirms for chat, support, predict, clip and watch, and the signed-out
 * Clip button's prompt.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ChatIntentConfirm,
  PredictionIntentConfirm,
  revealAndFocus,
} from "../src/components/auth-gate/intent-confirms.tsx";
import { PENDING_INTENT_KEY, savePendingIntent } from "../src/components/auth-gate/pending-intent.ts";
import { FollowButton, useFollow, type FollowApi } from "../src/components/channel-follow.tsx";
import { FirstFollowPrompt, type EnableEmailAlerts } from "../src/components/follow/alert-prompt.tsx";
import { FollowingControls } from "../src/components/follow/following-menu.tsx";
import type { FollowNotify, FollowsPage, FollowsPageLoader, SetNotify } from "../src/components/follow/notify.ts";
import type { SetGrant } from "../src/components/portability/grants.tsx";
import type { PushEnv } from "../src/components/pwa/push-client.ts";
import type { MaturityClient } from "../src/components/safety/client.ts";
import { MatureGate } from "../src/components/safety/mature-gate.tsx";
import { FILLED_CTA_ATTRIBUTE } from "../src/components/shell/use-filled-cta.ts";
import { SupportButton, type SupportClient } from "../src/components/support/support-dialog.tsx";
import { ClipButton, type ClipCreate } from "../src/components/watch/clip-button.tsx";
import { t } from "../src/i18n/index.ts";
import { resetUiMetricsForTests } from "../src/lib/ui-metrics.ts";
import { renderInRouter } from "./d1-fixtures.tsx";
import { supportInfo } from "./support-fixtures.ts";

type FetchFn = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

beforeEach(() => {
  resetUiMetricsForTests();
  localStorage.clear();
  fetchMock = vi.fn<FetchFn>(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const counted = () =>
  fetchMock.mock.calls
    .filter(([url]) => (url instanceof Request ? url.url : url.toString()) === "/api/metrics/ui")
    .map(([, init]) => JSON.parse(init?.body as string) as { surface: string; action: string; step: string });

const id = (testId: string) => screen.getByTestId(testId);
const click = (el: Element) =>
  act(() => {
    fireEvent.click(el);
  });

const RIVERTIDE = { slug: "rivertide", name: "Rivertide" };
const followingState = { following: true, count: 4, pending: false, previous: null, settledAt: 0 };
const notFollowing = { ...followingState, following: false, count: 3 };

function fakeNotify(initial: boolean | null = true): FollowNotify & { calls: boolean[] } {
  const calls: boolean[] = [];
  return { notify: initial, pending: false, set: (next) => calls.push(next), calls };
}

describe("the Following split button", () => {
  it("following: a bell and the Following menu; follow-button stays the primary control", async () => {
    const setNotify = vi.fn<SetNotify>(async () => ({}));
    await renderInRouter(
      <FollowButton
        signedIn
        state={followingState}
        onToggle={() => {}}
        channel={RIVERTIDE}
        notify
        setNotify={setNotify}
      />,
      "/rivertide",
    );
    const follow = await screen.findByTestId("follow-button");
    expect(follow.getAttribute("data-following")).toBe("true");
    expect(follow.getAttribute("aria-label")).toBe(t("d4Follow.menu.label", { channel: "Rivertide" }));
    expect(follow.textContent).toContain(t("follow.following"));
    // Following is an outline: Support takes the fill.
    expect(follow.hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(false);
    const bell = id("follow-bell");
    expect(bell.getAttribute("aria-label")).toBe(t("d4Follow.bell.label", { channel: "Rivertide" }));
    expect(bell.getAttribute("aria-pressed")).toBe("true");
    expect(bell.closest("button")).toBe(bell);
    expect(bell.parentElement?.closest("button")).toBeNull();
    click(bell);
    await waitFor(() => expect(setNotify).toHaveBeenCalledWith("rivertide", false));
    await waitFor(() => expect(id("follow-bell").getAttribute("aria-pressed")).toBe("false"));
    expect(counted()).toContainEqual({ surface: "watch.followMenu", action: "click", step: "decline" });
  });

  it("a failed bell change rolls back", async () => {
    const setNotify = vi.fn<SetNotify>(async () => {
      throw new Error("offline");
    });
    await renderInRouter(
      <FollowButton
        signedIn
        state={followingState}
        onToggle={() => {}}
        channel={RIVERTIDE}
        notify
        setNotify={setNotify}
      />,
      "/rivertide",
    );
    click(id("follow-bell"));
    await waitFor(() => expect(setNotify).toHaveBeenCalled());
    await waitFor(() => expect(id("follow-bell").getAttribute("aria-pressed")).toBe("true"));
  });

  it("unknown alerts: read from the follows list, the bell waits until then", async () => {
    let release: (page: FollowsPage) => void = () => {};
    const loadFollowsPage = vi.fn<FollowsPageLoader>(() => new Promise<FollowsPage>((r) => (release = r)));
    await renderInRouter(
      <FollowButton
        signedIn
        state={followingState}
        onToggle={() => {}}
        channel={RIVERTIDE}
        loadFollowsPage={loadFollowsPage}
      />,
      "/rivertide",
    );
    const bell = await screen.findByTestId("follow-bell");
    expect(bell.getAttribute("data-notify")).toBe("unknown");
    expect((bell as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release({ items: [{ channel: { slug: "rivertide" }, notify: false }], nextCursor: null }));
    await waitFor(() => expect(id("follow-bell").getAttribute("data-notify")).toBe("false"));
  });

  it("the menu: alert level, the move grant, and Unfollow behind a confirm", async () => {
    const notify = fakeNotify(true);
    const onUnfollow = vi.fn<() => void>();
    const setGrant = vi.fn<SetGrant>(async (_c, enabled) => ({ enabled }));
    await renderInRouter(
      <FollowingControls
        channel={RIVERTIDE}
        notify={notify}
        portabilityGrant={false}
        pending={false}
        onUnfollow={onUnfollow}
        setGrant={setGrant}
      />,
      "/rivertide",
    );
    click(id("follow-button"));
    const menu = await screen.findByTestId("follow-menu");
    expect(menu.textContent).toContain(t("d4Follow.menu.alertsAll"));
    expect(menu.textContent).toContain(t("d4Follow.menu.move", { channel: "Rivertide" }));
    expect(id("follow-menu-alerts-all").getAttribute("aria-checked")).toBe("true");
    click(id("follow-menu-alerts-off"));
    expect(notify.calls).toEqual([false]);
    click(id("follow-menu-move"));
    await waitFor(() => expect(setGrant).toHaveBeenCalledWith("rivertide", true));
    expect(counted()).toContainEqual({ surface: "watch.followMenu", action: "click", step: "email" });
    click(id("follow-menu-unfollow"));
    const dialog = await screen.findByTestId("follow-unfollow-dialog");
    expect(dialog.textContent).toContain(t("d4Follow.unfollow.title", { channel: "Rivertide" }));
    // It never unfollows before the confirm.
    expect(onUnfollow).not.toHaveBeenCalled();
    click(id("confirm-dialog-confirm"));
    await waitFor(() => expect(onUnfollow).toHaveBeenCalledTimes(1));
    expect(counted()).toContainEqual({ surface: "watch.followMenu", action: "confirm", step: "none" });
  });

  it("Cancel keeps the follow; no grant known: no move item", async () => {
    const onUnfollow = vi.fn<() => void>();
    await renderInRouter(
      <FollowingControls channel={RIVERTIDE} notify={fakeNotify()} pending={false} onUnfollow={onUnfollow} />,
      "/rivertide",
    );
    click(id("follow-button"));
    await screen.findByTestId("follow-menu");
    expect(screen.queryByTestId("follow-menu-move")).toBeNull();
    click(id("follow-menu-unfollow"));
    await screen.findByTestId("follow-unfollow-dialog");
    click(id("confirm-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("follow-unfollow-dialog")).toBeNull());
    expect(onUnfollow).not.toHaveBeenCalled();
  });

  it("not following: one Follow, the filled CTA, no bell", async () => {
    await renderInRouter(
      <FollowButton signedIn state={notFollowing} onToggle={() => {}} channel={RIVERTIDE} />,
      "/rivertide",
    );
    const follow = await screen.findByTestId("follow-button");
    expect(follow.getAttribute("data-following")).toBe("false");
    expect(follow.hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(true);
    expect(screen.queryByTestId("follow-bell")).toBeNull();
  });
});

/** A channel page's follow: `useFollow` with the API stubbed, and its `FollowButton`. */
function FollowPage({ call }: { call: FollowApi }): React.JSX.Element {
  const f = useFollow("rivertide", false, 3, 0, call);
  return <FollowButton signedIn state={f.state} onToggle={f.toggle} channel={RIVERTIDE} setNotify={async () => ({})} />;
}

describe("the first-follow alert prompt", () => {
  it("opens after the caller's first follow, on the control that was pressed", async () => {
    const call = vi.fn<FollowApi>(async () => ({ following: true, followerCount: 4, firstFollow: true }));
    await renderInRouter(<FollowPage call={call} />, "/rivertide");
    click(await screen.findByTestId("follow-button"));
    const prompt = await screen.findByTestId("first-follow-prompt");
    expect(prompt.textContent).toContain(t("d4Follow.alertPrompt.title", { channel: "Rivertide" }));
    expect(id("follow-button").getAttribute("data-following")).toBe("true");
    // Alerts on: the follow was made with notify = true.
    expect(id("follow-bell").getAttribute("aria-pressed")).toBe("true");
    click(id("first-follow-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("first-follow-prompt")).toBeNull());
    expect(counted()).toContainEqual({ surface: "watch.firstFollow", action: "dismiss", step: "none" });
  });

  it("not the first follow: no prompt", async () => {
    const call = vi.fn<FollowApi>(async () => ({ following: true, followerCount: 4, firstFollow: false }));
    await renderInRouter(<FollowPage call={call} />, "/rivertide");
    click(await screen.findByTestId("follow-button"));
    await waitFor(() => expect(id("follow-button").getAttribute("data-following")).toBe("true"));
    expect(screen.queryByTestId("first-follow-prompt")).toBeNull();
  });

  const desktop = { pushSupported: true, appleStandaloneApi: false, standalone: false };
  const iphone = { pushSupported: false, appleStandaloneApi: true, standalone: false };

  function pushEnv(over: Partial<PushEnv> = {}, enabled = true): PushEnv & { subscribed: unknown[] } {
    const subscribed: unknown[] = [];
    const sub = {
      endpoint: "https://push.invalid/1",
      toJSON: () => ({ endpoint: "https://push.invalid/1", keys: { p256dh: "p", auth: "a" } }),
      unsubscribe: async () => true,
    };
    return {
      supported: true,
      permission: () => "default",
      requestPermission: async () => "granted",
      pushManager: async () => ({ getSubscription: async () => null, subscribe: async () => sub }),
      api: {
        status: async () => ({ enabled, vapidPublicKey: enabled ? "AAAA" : null, subscriptions: 0 }),
        subscribe: async (input) => {
          subscribed.push(input);
          return {};
        },
        unsubscribe: async () => ({}),
        goLivePushDefault: async () => false,
        enableGoLivePushDefault: async () => ({}),
      },
      ...over,
      subscribed,
    };
  }

  async function prompt(props: Partial<React.ComponentProps<typeof FirstFollowPrompt>>) {
    const onClose = vi.fn<() => void>();
    await renderInRouter(
      <span className="relative">
        <FirstFollowPrompt open onClose={onClose} channel={RIVERTIDE} {...props} />
      </span>,
      "/rivertide",
    );
    await screen.findByTestId("first-follow-prompt");
    return onClose;
  }

  it("Push: asks permission from the click, subscribes, and closes", async () => {
    const env = pushEnv();
    const onClose = await prompt({ alertEnv: desktop, pushEnv: env });
    const push = await screen.findByTestId("first-follow-push");
    expect(push.hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(true);
    expect(id("first-follow-email").hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(false);
    await act(async () => {
      fireEvent.click(push);
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(env.subscribed).toHaveLength(1);
    expect(counted()).toContainEqual({ surface: "watch.firstFollow", action: "view", step: "push" });
    expect(counted()).toContainEqual({ surface: "watch.firstFollow", action: "click", step: "push" });
  });

  it("Push blocked by the browser: says so and leaves Email", async () => {
    const onClose = await prompt({ alertEnv: desktop, pushEnv: pushEnv({ requestPermission: async () => "denied" }) });
    await act(async () => {
      fireEvent.click(await screen.findByTestId("first-follow-push"));
    });
    expect((await screen.findByTestId("first-follow-notice")).textContent).toBe(t("d4Follow.alertPrompt.pushBlocked"));
    expect(screen.queryByTestId("first-follow-push")).toBeNull();
    expect(id("first-follow-email")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("an instance without push never offers it (and never asks permission)", async () => {
    const requestPermission = vi.fn<() => Promise<NotificationPermission>>(async () => "granted");
    await prompt({ alertEnv: desktop, pushEnv: pushEnv({ requestPermission }, false) });
    await waitFor(() => expect(id("first-follow-email").textContent).toContain(t("d4Follow.alertPrompt.emailMe")));
    expect(screen.queryByTestId("first-follow-push")).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("Email turns the go-live email default on", async () => {
    const enableEmail = vi.fn<EnableEmailAlerts>(async () => ({}));
    const onClose = await prompt({ alertEnv: desktop, pushEnv: pushEnv(), enableEmail });
    await act(async () => {
      fireEvent.click(id("first-follow-email"));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(enableEmail).toHaveBeenCalledTimes(1);
    expect(counted()).toContainEqual({ surface: "watch.firstFollow", action: "click", step: "email" });
  });

  it("a failed Email keeps the prompt open", async () => {
    const onClose = await prompt({
      alertEnv: desktop,
      pushEnv: pushEnv(),
      enableEmail: async () => {
        throw new Error("offline");
      },
    });
    await act(async () => {
      fireEvent.click(id("first-follow-email"));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(id("first-follow-prompt")).toBeTruthy();
  });

  it("iPhone before install: no Push, Email me and the Home Screen hint", async () => {
    const status = vi.fn<PushEnv["api"]["status"]>(async () => ({
      enabled: true,
      vapidPublicKey: "AAAA",
      subscriptions: 0,
    }));
    const env = pushEnv();
    env.api.status = status;
    await prompt({ alertEnv: iphone, pushEnv: env });
    expect(screen.queryByTestId("first-follow-push")).toBeNull();
    expect(id("first-follow-email").textContent).toContain(t("d4Follow.alertPrompt.emailMe"));
    expect(id("first-follow-email").hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(true);
    expect(id("first-follow-install").textContent).toContain(t("d4Follow.alertPrompt.installTitle"));
    expect(id("first-follow-prompt").getAttribute("data-install-hint")).toBe("true");
    expect(status).not.toHaveBeenCalled();
    expect(counted()).toContainEqual({ surface: "watch.firstFollow", action: "view", step: "install" });
  });

  it("Escape dismisses it", async () => {
    const onClose = await prompt({ alertEnv: iphone, pushEnv: pushEnv() });
    act(() => {
      fireEvent.keyDown(id("first-follow-prompt"), { key: "Escape" });
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("the post-verification confirms", () => {
  it("chat: Say hi in chat only focuses the composer", async () => {
    savePendingIntent({ intent: "chat", target: "/rivertide", channel: "rivertide" });
    const onSayHi = vi.fn<() => void>();
    await renderInRouter(<ChatIntentConfirm canChat onSayHi={onSayHi} />, "/rivertide");
    const card = await screen.findByTestId("intent-confirm");
    expect(card.textContent).toContain(t("d4Follow.confirm.chat"));
    expect(onSayHi).not.toHaveBeenCalled();
    click(id("intent-confirm-chat"));
    expect(onSayHi).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PENDING_INTENT_KEY)).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("intent-confirm")).toBeNull());
    expect(counted()).toContainEqual({ surface: "intent", action: "confirm", step: "chat" });
  });

  it("chat: nothing while the composer is not usable; Not now forgets it", async () => {
    savePendingIntent({ intent: "chat", target: "/rivertide" });
    const onSayHi = vi.fn<() => void>();
    await renderInRouter(<ChatIntentConfirm canChat={false} onSayHi={onSayHi} />, "/rivertide");
    expect(screen.queryByTestId("intent-confirm")).toBeNull();
    expect(localStorage.getItem(PENDING_INTENT_KEY)).not.toBeNull();
    cleanup();
    await renderInRouter(<ChatIntentConfirm canChat onSayHi={onSayHi} />, "/rivertide");
    click(await screen.findByTestId("intent-confirm-dismiss"));
    expect(onSayHi).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_INTENT_KEY)).toBeNull();
  });

  it("predict: only while a prediction is open; the tap brings it into view and focuses it", async () => {
    savePendingIntent({ intent: "predict", target: "/rivertide" });
    function Strip({ open }: { open: boolean }) {
      const card = React.useRef<HTMLDivElement>(null);
      return (
        <>
          <PredictionIntentConfirm predictionOpen={open} onJoin={() => revealAndFocus(card.current)} />
          <div data-testid="prediction-card" ref={card}>
            card
          </div>
        </>
      );
    }
    await renderInRouter(<Strip open={false} />, "/rivertide");
    expect(screen.queryByTestId("intent-confirm")).toBeNull();
    cleanup();
    await renderInRouter(<Strip open />, "/rivertide");
    expect((await screen.findByTestId("intent-confirm")).textContent).toContain(t("d4Follow.confirm.predict"));
    click(id("intent-confirm-predict"));
    expect(document.activeElement).toBe(id("prediction-card"));
    expect(id("prediction-card").getAttribute("tabindex")).toBe("-1");
  });

  it("support: the confirm opens the Support dialog, never a checkout", async () => {
    savePendingIntent({ intent: "support", target: "/rivertide", channel: "rivertide" });
    const support = vi.fn<SupportClient["support"]>(async () => supportInfo());
    const checkout = vi.fn<SupportClient["checkout"]>();
    await renderInRouter(
      <SupportButton channel="rivertide" channelName="Rivertide" signedIn client={{ support, checkout }} />,
      "/rivertide",
    );
    const confirm = await screen.findByTestId("intent-confirm");
    expect(confirm.textContent).toContain(t("d4Follow.confirm.support", { channel: "Rivertide" }));
    expect(id("support-open").hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(false);
    expect(support).not.toHaveBeenCalled();
    click(id("intent-confirm-support"));
    await waitFor(() => expect(support).toHaveBeenCalled());
    expect(checkout).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_INTENT_KEY)).toBeNull();
    expect(counted()).toContainEqual({ surface: "intent", action: "confirm", step: "support" });
  });

  it("support: Not now forgets it and leaves the dialog closed", async () => {
    savePendingIntent({ intent: "support", target: "/rivertide" });
    const support = vi.fn<SupportClient["support"]>(async () => supportInfo());
    await renderInRouter(
      <SupportButton
        channel="rivertide"
        channelName="Rivertide"
        signedIn
        client={{ support, checkout: vi.fn<SupportClient["checkout"]>() }}
      />,
      "/rivertide",
    );
    click(await screen.findByTestId("intent-confirm-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("intent-confirm")).toBeNull());
    expect(support).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_INTENT_KEY)).toBeNull();
  });

  it("clip: the confirm opens the clip dialog, never creates a clip", async () => {
    savePendingIntent({ intent: "clip", target: "/rivertide" });
    const create = vi.fn<ClipCreate>(async () => ({ id: "x", channelSlug: "rivertide" }));
    const opened: boolean[] = [];
    await renderInRouter(
      <ClipButton
        target={{ kind: "live", channel: "rivertide" }}
        signedIn
        create={create}
        onOpenChange={(o) => opened.push(o)}
      />,
      "/rivertide",
    );
    expect((await screen.findByTestId("intent-confirm")).textContent).toContain(t("d4Follow.confirm.clip"));
    expect(opened).toEqual([true]);
    click(id("intent-confirm-clip"));
    await screen.findByTestId("clip-dialog");
    expect(create).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_INTENT_KEY)).toBeNull();
  });

  it("clip: Not now lets the player bar hide again", async () => {
    savePendingIntent({ intent: "clip", target: "/rivertide" });
    const opened: boolean[] = [];
    await renderInRouter(
      <ClipButton target={{ kind: "live", channel: "rivertide" }} signedIn onOpenChange={(o) => opened.push(o)} />,
      "/rivertide",
    );
    click(await screen.findByTestId("intent-confirm-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("intent-confirm")).toBeNull());
    expect(opened).toEqual([true, false]);
    expect(screen.queryByTestId("clip-dialog")).toBeNull();
  });

  it("watch: the 18+ confirm is the tap; it never confirms on its own", async () => {
    savePendingIntent({ intent: "watch", target: "/rivertide" });
    const client = {
      me: vi.fn<MaturityClient["me"]>(async () => ({ isAdult: true, matureConfirmed: false })),
      confirmMature: vi.fn<MaturityClient["confirmMature"]>(async () => ({})),
    };
    const onConfirmed = vi.fn<() => void>();
    await renderInRouter(<MatureGate signedIn client={client} onConfirmed={onConfirmed} />, "/rivertide");
    const message = await screen.findByTestId("intent-confirm");
    expect(message.getAttribute("data-intent")).toBe("watch");
    expect(message.textContent).toBe(t("d4Follow.confirm.watch"));
    await waitFor(() => expect(document.activeElement).toBe(id("mature-gate-confirm")));
    expect(client.confirmMature).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(id("mature-gate-confirm"));
    });
    expect(client.confirmMature).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PENDING_INTENT_KEY)).toBeNull();
  });

  it("watch: Not now forgets it, the gate stays", async () => {
    savePendingIntent({ intent: "watch", target: "/rivertide" });
    const client = {
      me: vi.fn<MaturityClient["me"]>(async () => ({ isAdult: true, matureConfirmed: false })),
      confirmMature: vi.fn<MaturityClient["confirmMature"]>(),
    };
    await renderInRouter(<MatureGate signedIn client={client} onConfirmed={() => {}} />, "/rivertide");
    click(await screen.findByTestId("intent-confirm-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("intent-confirm")).toBeNull());
    expect(id("mature-gate-confirm")).toBeTruthy();
    expect(client.confirmMature).not.toHaveBeenCalled();
  });
});

describe("the signed-out Clip button", () => {
  it("is one keyboard-reachable button with its tooltip label that opens the sign-up prompt", async () => {
    await renderInRouter(<ClipButton target={{ kind: "live", channel: "rivertide" }} signedIn={false} />, "/rivertide");
    const button = (await screen.findByTestId("clip-button")) as HTMLButtonElement;
    expect(button.tagName).toBe("BUTTON");
    // No button inside a button (the IconButton is the popover's trigger itself).
    expect(button.querySelector("button")).toBeNull();
    expect(button.parentElement?.closest("button")).toBeNull();
    expect(button.disabled).toBe(false);
    expect(button.tabIndex).toBe(0);
    expect(button.getAttribute("aria-label")).toBe(t("d3Watch.clip.label"));
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    act(() => {
      button.focus();
    });
    expect(document.activeElement).toBe(button);
    act(() => {
      fireEvent.pointerEnter(button, { pointerType: "mouse" });
      fireEvent.mouseEnter(button);
      fireEvent.mouseMove(button);
    });
    await waitFor(() => expect(document.body.textContent).toContain(t("d3Watch.clip.signInTooltip")));
    act(() => {
      fireEvent.click(button);
    });
    const gate = await screen.findByTestId("auth-gate");
    expect(gate.getAttribute("data-intent")).toBe("clip");
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });
});
