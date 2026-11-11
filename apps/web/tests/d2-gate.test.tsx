// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d2-gate in the DOM: `<AuthGatePrompt>` on every signed-out action (Follow, Support, chat,
 * predictions, the 18+ gate, Report), its links and weights, Escape and focus, the counters, the
 * page's Follow dropping to an outline while it is open, and the one-tap confirm after sign-up.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AuthGatePrompt, gateCopy } from "../src/components/auth-gate/auth-gate-prompt.tsx";
import { ChatSignUpPrompt, PredictionSignUpPrompt } from "../src/components/auth-gate/chat-prompt.tsx";
import { GatedSupportButton, type SupportSplitLoader } from "../src/components/auth-gate/gated-support.tsx";
import { PENDING_INTENT_KEY, savePendingIntent } from "../src/components/auth-gate/pending-intent.ts";
import { FollowButton } from "../src/components/channel-follow.tsx";
import { MatureGate, RestrictedStream } from "../src/components/safety/mature-gate.tsx";
import { ReportButton } from "../src/components/safety/report-dialog.tsx";
import { FILLED_CTA_ATTRIBUTE } from "../src/components/shell/use-filled-cta.ts";
import { resetUiMetricsForTests } from "../src/lib/ui-metrics.ts";
import { renderInRouter } from "./d1-fixtures.tsx";

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

/** The `{surface, action, step}` bodies sent to the UI counter. */
const counted = () =>
  fetchMock.mock.calls
    .filter(([url]) => (url instanceof Request ? url.url : url.toString()) === "/api/metrics/ui")
    .map(([, init]) => JSON.parse(init?.body as string) as { surface: string; action: string; step: string });

const searchOf = (el: Element | null) => {
  const href = el?.getAttribute("href") ?? "";
  const url = new URL(href, "https://x.invalid");
  return { path: url.pathname, params: Object.fromEntries(url.searchParams) };
};

const RIVERTIDE = { slug: "rivertide", name: "Rivertide" };
const notFollowing = { following: false, count: 3, pending: false, previous: null, settledAt: 0 };

describe("gateCopy", () => {
  it("has a title and body for every intent, naming the channel where it has one", () => {
    expect(gateCopy({ intent: "follow", channel: RIVERTIDE })).toEqual({
      title: "Follow Rivertide",
      body: "Get told when they go live. Free account.",
    });
    expect(gateCopy({ intent: "follow" }).title).toBe("Follow this channel");
    expect(gateCopy({ intent: "support" }).title).toBe("Support this channel");
    expect(gateCopy({ intent: "report" }).title).toBe("Sign in to report");
    expect(gateCopy({ intent: "vote" }).body).toContain("join the co-op to vote");
    expect(gateCopy({ intent: "predict" }).body).toContain("never money");
  });

  it("states the creator's share only when it is known", () => {
    expect(gateCopy({ intent: "support", channel: RIVERTIDE, creatorShare: 90 }).body).toMatch(/^90% of every sub/);
    expect(gateCopy({ intent: "support", channel: RIVERTIDE, creatorShare: null }).body).not.toMatch(/\d/);
    expect(gateCopy({ intent: "support", channel: RIVERTIDE, creatorShare: Number.NaN }).body).not.toMatch(/\d/);
  });
});

describe("AuthGatePrompt", () => {
  it("opens from the action: Create account is the brand fill, both links carry redirect, intent and channel", async () => {
    await renderInRouter(
      <AuthGatePrompt
        intent="follow"
        channel={RIVERTIDE}
        trigger={<button type="button" aria-label="act" data-testid="act" />}
      >
        Follow
      </AuthGatePrompt>,
      "/rivertide",
    );
    const trigger = await screen.findByTestId("act");
    act(() => {
      fireEvent.click(trigger);
    });
    const gate = await screen.findByTestId("auth-gate");
    expect(gate.getAttribute("data-intent")).toBe("follow");
    expect(gate.textContent).toContain("Follow Rivertide");
    const create = screen.getByTestId("auth-gate-create");
    const signIn = screen.getByTestId("auth-gate-signin");
    expect(create.hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(true);
    expect(create.className).toMatch(/\bbg-brand\b/);
    expect(signIn.className).not.toMatch(/\bbg-brand\b/);
    // Create comes first in the reading order.
    expect(create.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const params = { redirect: "/rivertide", intent: "follow", channel: "rivertide" };
    expect(searchOf(create)).toEqual({ path: "/signup", params });
    expect(searchOf(signIn)).toEqual({ path: "/signin", params });
    await waitFor(() => expect(counted()).toContainEqual({ surface: "authGate", action: "view", step: "follow" }));
    act(() => {
      fireEvent.click(create);
    });
    expect(counted()).toContainEqual({ surface: "authGate", action: "create", step: "follow" });
  });

  it("Escape closes it and focus goes back to the action", async () => {
    await renderInRouter(
      <AuthGatePrompt intent="clip" trigger={<button type="button" aria-label="act" data-testid="act" />}>
        Clip
      </AuthGatePrompt>,
      "/rivertide",
    );
    const trigger = await screen.findByTestId("act");
    act(() => {
      trigger.focus();
      fireEvent.click(trigger);
    });
    const gate = await screen.findByTestId("auth-gate");
    act(() => {
      fireEvent.keyDown(gate, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByTestId("auth-gate")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("the close button closes it", async () => {
    await renderInRouter(
      <AuthGatePrompt intent="chat" trigger={<button type="button" aria-label="act" data-testid="act" />}>
        Chat
      </AuthGatePrompt>,
    );
    act(() => {
      fireEvent.click(screen.getByTestId("act"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("auth-gate-close"));
    });
    await waitFor(() => expect(screen.queryByTestId("auth-gate")).toBeNull());
  });

  it("report: Sign in leads, with no brand fill and no intent; signing in is counted", async () => {
    await renderInRouter(<ReportButton signedIn={false} subjectType="channel" subjectId="c1" />, "/rivertide");
    const open = await screen.findByTestId("report-open");
    act(() => {
      fireEvent.click(open);
    });
    const gate = await screen.findByTestId("auth-gate");
    expect(gate.getAttribute("data-intent")).toBe("report");
    const create = screen.getByTestId("auth-gate-create");
    const signIn = screen.getByTestId("auth-gate-signin");
    expect(signIn.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(create.hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(false);
    expect(document.querySelector("[data-filled-cta]")).toBeNull();
    expect(searchOf(signIn).params).toEqual({ redirect: "/rivertide", channel: "rivertide" });
    act(() => {
      fireEvent.click(signIn);
    });
    expect(counted()).toContainEqual({ surface: "authGate", action: "signin", step: "report" });
  });

  it("vote counts as join on the links", async () => {
    await renderInRouter(
      <AuthGatePrompt intent="vote" trigger={<button type="button" aria-label="act" data-testid="act" />}>
        Vote
      </AuthGatePrompt>,
      "/directory",
    );
    act(() => {
      fireEvent.click(screen.getByTestId("act"));
    });
    expect(searchOf(await screen.findByTestId("auth-gate-create")).params).toEqual({
      redirect: "/directory",
      intent: "join",
    });
  });
});

describe("Follow, signed out", () => {
  it("opens the prompt, naming the channel from the route; Follow drops to an outline while it is open", async () => {
    await renderInRouter(<FollowButton signedIn={false} state={notFollowing} onToggle={() => {}} />, "/rivertide");
    const follow = await screen.findByTestId("follow-button");
    expect(follow.hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(true);
    act(() => {
      fireEvent.click(follow);
    });
    const gate = await screen.findByTestId("auth-gate");
    expect(gate.textContent).toContain("Follow rivertide");
    expect(follow.hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(false);
    expect(follow.getAttribute("data-gate-open")).toBe("true");
    expect(follow.className).toMatch(/\bbg-background\b/);
    expect(follow.className).not.toMatch(/\bbg-channel-accent\b/);
    // The prompt holds the one fill.
    expect(document.querySelectorAll("[data-filled-cta]")).toHaveLength(1);
    act(() => {
      fireEvent.keyDown(gate, { key: "Escape" });
    });
    await waitFor(() => expect(follow.hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(true));
    expect(follow.className).toMatch(/\bbg-channel-accent\b/);
  });

  it("uses the channel's display name when the caller gives it", async () => {
    await renderInRouter(
      <FollowButton signedIn={false} state={notFollowing} onToggle={() => {}} channel={RIVERTIDE} />,
      "/videos",
    );
    act(() => {
      fireEvent.click(screen.getByTestId("follow-button"));
    });
    expect((await screen.findByTestId("auth-gate")).textContent).toContain("Follow Rivertide");
  });
});

describe("the one-tap confirm after sign-up", () => {
  it("back on the page, Follow is offered once; confirming follows and forgets it", async () => {
    savePendingIntent({ intent: "follow", target: "/rivertide", channel: "rivertide" });
    const onToggle = vi.fn<() => void>();
    await renderInRouter(<FollowButton signedIn state={notFollowing} onToggle={onToggle} />, "/rivertide");
    const confirm = await screen.findByTestId("intent-confirm");
    expect(confirm.textContent).toContain("You're in. Follow rivertide?");
    // It never follows on its own.
    expect(onToggle).not.toHaveBeenCalled();
    const follow = screen.getByTestId("follow-button");
    expect(follow.hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(false);
    expect(screen.getByTestId("intent-confirm-follow").hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(true);
    act(() => {
      fireEvent.click(screen.getByTestId("intent-confirm-follow"));
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PENDING_INTENT_KEY)).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("intent-confirm")).toBeNull());
    expect(counted()).toContainEqual({ surface: "intent", action: "confirm", step: "follow" });
  });

  it("Not now forgets it without following", async () => {
    savePendingIntent({ intent: "follow", target: "/rivertide" });
    const onToggle = vi.fn<() => void>();
    await renderInRouter(<FollowButton signedIn state={notFollowing} onToggle={onToggle} />, "/rivertide");
    const confirm = await screen.findByTestId("intent-confirm");
    expect(confirm.textContent).toContain("You're in. Follow rivertide?");
    act(() => {
      fireEvent.click(screen.getByTestId("intent-confirm-dismiss"));
    });
    await waitFor(() => expect(screen.queryByTestId("intent-confirm")).toBeNull());
    expect(onToggle).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_INTENT_KEY)).toBeNull();
    expect(counted()).toContainEqual({ surface: "intent", action: "dismiss", step: "follow" });
    expect(screen.getByTestId("follow-button").hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(true);
  });

  it("nothing on another page, or when already following", async () => {
    savePendingIntent({ intent: "follow", target: "/rivertide" });
    await renderInRouter(<FollowButton signedIn state={notFollowing} onToggle={() => {}} />, "/other");
    await screen.findByTestId("follow-button");
    expect(screen.queryByTestId("intent-confirm")).toBeNull();
    cleanup();
    await renderInRouter(
      <FollowButton signedIn state={{ ...notFollowing, following: true }} onToggle={() => {}} />,
      "/rivertide",
    );
    await screen.findByTestId("follow-button");
    expect(screen.queryByTestId("intent-confirm")).toBeNull();
    expect(localStorage.getItem(PENDING_INTENT_KEY)).not.toBeNull();
  });
});

describe("the other signed-out actions", () => {
  it("Support loads the real split and states it", async () => {
    const loadSplit = vi.fn<SupportSplitLoader>(async () => ({ streamerShare: 0.9, coopShare: 0.1 }));
    await renderInRouter(<GatedSupportButton channel="rivertide" channelName="Rivertide" loadSplit={loadSplit} />);
    act(() => {
      fireEvent.click(screen.getByTestId("support-open"));
    });
    const gate = await screen.findByTestId("auth-gate");
    expect(gate.getAttribute("data-intent")).toBe("support");
    await waitFor(() => expect(gate.textContent).toContain("90% of every sub and tip reaches them"));
    expect(loadSplit).toHaveBeenCalledWith("rivertide");
    expect(searchOf(screen.getByTestId("auth-gate-create")).params.intent).toBe("support");
  });

  it("Support without the split says it without a number", async () => {
    const loadSplit = vi.fn<SupportSplitLoader>(async () => Promise.reject(new Error("down")));
    await renderInRouter(<GatedSupportButton channel="rivertide" channelName="Rivertide" loadSplit={loadSplit} />);
    act(() => {
      fireEvent.click(screen.getByTestId("support-open"));
    });
    const gate = await screen.findByTestId("auth-gate");
    await waitFor(() => expect(loadSplit).toHaveBeenCalled());
    expect(gate.textContent).toContain("Subs and tips reach them");
  });

  it("the chat input opens the chat prompt", async () => {
    await renderInRouter(<ChatSignUpPrompt />, "/rivertide");
    const open = await screen.findByTestId("chat-signup-open");
    expect(open.textContent).toContain("Create an account to chat");
    act(() => {
      fireEvent.click(open);
    });
    const gate = await screen.findByTestId("auth-gate");
    expect(gate.getAttribute("data-intent")).toBe("chat");
    expect(searchOf(screen.getByTestId("auth-gate-create")).params.intent).toBe("chat");
  });

  it("the prediction card opens the predict prompt", async () => {
    await renderInRouter(<PredictionSignUpPrompt />, "/rivertide");
    act(() => {
      fireEvent.click(screen.getByTestId("chat-prediction-signup"));
    });
    expect((await screen.findByTestId("auth-gate")).getAttribute("data-intent")).toBe("predict");
  });

  it("the 18+ gate is the prompt inline, keeping its Sign in selector", async () => {
    await renderInRouter(<MatureGate signedIn={false} onConfirmed={() => {}} />, "/rivertide");
    const gate = await screen.findByTestId("mature-gate");
    expect(gate.getAttribute("data-intent")).toBe("watch");
    expect(gate.textContent).toContain("This stream is for adults");
    const create = screen.getByTestId("mature-gate-create");
    expect(create.hasAttribute(FILLED_CTA_ATTRIBUTE)).toBe(true);
    expect(searchOf(create).params).toEqual({ redirect: "/rivertide", intent: "watch", channel: "rivertide" });
    expect(searchOf(screen.getByTestId("mature-gate-signin")).path).toBe("/signin");
    await waitFor(() => expect(counted()).toContainEqual({ surface: "authGate", action: "view", step: "watch" }));
  });

  it("signed in, the 18+ gate still asks to confirm", async () => {
    await renderInRouter(<MatureGate signedIn onConfirmed={() => {}} />, "/rivertide");
    expect(await screen.findByTestId("mature-gate-confirm")).toBeTruthy();
    expect(screen.queryByTestId("mature-gate-signin")).toBeNull();
  });

  it("a restricted stream offers Create account and Sign in signed out", async () => {
    await renderInRouter(
      <RestrictedStream signedIn={false} confirmed={false} onConfirmed={() => {}}>
        <div />
      </RestrictedStream>,
      "/rivertide",
    );
    const create = await screen.findByTestId("auth-gate-create");
    expect(searchOf(create).params.intent).toBe("watch");
    expect(screen.getByTestId("auth-gate-signin")).toBeTruthy();
  });
});
